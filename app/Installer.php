<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Installing the webmail: the checks behind each step of the installer wizard, and the install itself. The wizard
 * (install.php) asks step by step; install-cli.php and app installers (Softaculous, Installatron) give everything at
 * once. Either way the encryption key is made here, on this server.
 */
final class Installer
{
    /** What the server must have: [name, ok, how to fix]. The last one only decides whether config.php is written for you. */
    public static function requirements(string $dir): array
    {
        return [
            ['PHP 8.1 or newer', PHP_VERSION_ID >= 80100, 'This server has PHP ' . PHP_VERSION . '. Choose PHP 8.1+ in your hosting control panel.'],
            ['Sodium (encryption)', extension_loaded('sodium'), 'Turn on the "sodium" PHP extension in your hosting control panel.'],
            ['PDO MySQL', extension_loaded('pdo_mysql'), 'Turn on the "pdo_mysql" PHP extension.'],
            ['cURL', extension_loaded('curl'), 'Turn on the "curl" PHP extension.'],
            ['mbstring', extension_loaded('mbstring'), 'Turn on the "mbstring" PHP extension.'],
            ['OpenSSL', extension_loaded('openssl'), 'Turn on the "openssl" PHP extension.'],
            ['config.php can be written', is_writable($dir) || (is_file("$dir/config.php") && is_writable("$dir/config.php")), "The folder isn't writable: you'll be shown config.php to upload yourself."],
        ];
    }

    /** The database settings, tidied; throws if it can't be used (can't connect, or already has webmail tables). */
    public static function checkDatabase(array $db): array
    {
        $db = ['host' => trim((string) ($db['host'] ?? 'localhost')) ?: 'localhost', 'port' => (int) ($db['port'] ?? 3306) ?: 3306, 'name' => trim((string) ($db['name'] ?? '')),
            'user' => trim((string) ($db['user'] ?? '')), 'pass' => (string) ($db['pass'] ?? ''), 'prefix' => preg_replace('/\W/', '', (string) ($db['prefix'] ?? 'wm_')) ?: 'wm_'];
        if ($db['name'] === '' || $db['user'] === '') {
            throw new InstallError('Enter the database name and user.');
        }
        try {
            $conn = new Db($db, $db['prefix']);
            $exists = $conn->value('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [$db['name'], $db['prefix'] . 'messages']);
        } catch (\PDOException $ex) {
            throw new InstallError("Can't connect to the database: " . preg_replace('/^SQLSTATE\[\w+\] \[\d+\] /', '', $ex->getMessage()));
        }
        if ($exists) {
            throw new InstallError("This database already has webmail tables with the prefix {$db['prefix']}. Use another prefix or database.");
        }
        return $db;
    }

    /** The GhostParse connection, tidied and checked; returns it with the account's name. */
    public static function checkGhostParse(array $gp): array
    {
        $gp = ['api_url' => rtrim(trim((string) ($gp['api_url'] ?? '')), '/'), 'api_key' => trim((string) ($gp['api_key'] ?? '')), 'webhook_secret' => trim((string) ($gp['webhook_secret'] ?? ''))];
        if (!preg_match('#^https?://#', $gp['api_url'])) {
            throw new InstallError('Enter the GhostParse address, like https://ghostparse.com');
        }
        if (!preg_match('/^whsec_[A-Za-z0-9+\/=]{32,}$/', $gp['webhook_secret'])) {
            throw new InstallError('The signing secret starts with whsec_ (Dashboard → Inbound webhook → Signing secret).');
        }
        try {
            $me = (new GhostParse($gp['api_url'], $gp['api_key']))->me();
        } catch (GhostParseError $ex) {
            throw new InstallError($ex->status === 401 ? 'GhostParse didn\'t accept that API key.' : $ex->getMessage());
        }
        $missing = array_diff(['send', 'domains'], $me['api_key']['scopes'] ?? []);
        if ($missing) {
            throw new InstallError('This API key needs the ' . implode(' and ', $missing) . ' permission' . (count($missing) > 1 ? 's' : '') . '. Create a key with Send and Domains ticked.');
        }
        return ['gp' => $gp, 'account' => (string) ($me['account']['name'] ?? '')];
    }

    /** The first administrator and the webmail's name and address, tidied and checked. */
    public static function checkAdmin(array $a): array
    {
        $a = ['name' => trim((string) ($a['name'] ?? '')), 'email' => trim((string) ($a['email'] ?? '')), 'password' => (string) ($a['password'] ?? ''),
            'app_name' => trim((string) ($a['app_name'] ?? '')) ?: 'Webmail', 'base_url' => rtrim(trim((string) ($a['base_url'] ?? '')), '/')];
        if ($a['name'] === '') {
            $a['name'] = strstr($a['email'], '@', true) ?: 'Administrator';
        }
        if (!filter_var($a['email'], FILTER_VALIDATE_EMAIL)) {
            throw new InstallError('Enter a valid email address to sign in with.');
        }
        if (mb_strlen($a['password']) < 10) {
            throw new InstallError('Use a password of at least 10 characters.');
        }
        if (!preg_match('#^https?://[^\s]+$#', $a['base_url'])) {
            throw new InstallError('Enter the address this webmail is at.');
        }
        return $a;
    }

    /** The account's addresses that can be mailboxes (not patterns), with a note when the domain can't receive yet. */
    public static function addresses(GhostParse $gp): array
    {
        $addresses = [];
        try {
            foreach ($gp->domains() as $d) {
                foreach ($d['addresses'] ?? [] as $a) {
                    if (empty($a['is_pattern'])) {
                        $addresses[] = ['address' => $a['address'], 'note' => ($d['inbound_ready'] ?? false) ? '' : 'domain not receiving yet', 'webhook' => $a['webhook_url'] ?? null];
                    }
                }
            }
        } catch (GhostParseError $ex) {
            throw new InstallError("Couldn't read your GhostParse addresses: " . $ex->getMessage());
        }
        return $addresses;
    }

    /**
     * Create the tables and the administrator, connect the chosen addresses (each one's webhook pointed here), and
     * write config.php. On failure, the tables made are removed so it can be run again.
     *
     * @param array $db checked database settings
     * @param array $gp checked GhostParse connection
     * @param array $admin checked administrator
     * @param string[]|'all' $mailboxes addresses to connect
     * @return array{config: string, written: bool, connected: string[], path: string}
     */
    public static function install(array $db, array $gp, array $admin, $mailboxes, ?string $key = null): array
    {
        $client = new GhostParse($gp['api_url'], $gp['api_key']);
        $available = array_column(self::addresses($client), 'address');
        $chosen = $mailboxes === 'all' ? $available : array_values(array_intersect($available, array_map('strtolower', (array) $mailboxes)));
        $config = [
            'app_name' => $admin['app_name'], 'base_url' => $admin['base_url'], 'key' => $key ?? base64_encode(Crypto::newKey()),
            'db' => $db, 'ghostparse' => $gp, 'installed_at' => gmdate('c'), 'version' => App::VERSION,
        ];
        $app = null;
        try {
            $app = new App(new Config($config), new Db($db, $db['prefix']), $client);
            Schema::migrate($app->db);
            $uid = (new Auth($app))->createUser($admin['email'], $admin['name'], $admin['password'], 'admin');
            $adm = new Admin($app);
            $connected = [];
            foreach ($chosen as $address) {
                // No From name of its own: email goes out under the name of whoever sends it, until one is set (Settings → Mailboxes).
                $id = $adm->connectAddress($address);
                (new Mailstore($app))->grant($uid, $id);
                $connected[] = $address;
            }
        } catch (\Throwable $ex) {
            if ($app) {
                try {
                    $app->db->run('SET FOREIGN_KEY_CHECKS = 0');
                    foreach (Schema::tables() as $t) {
                        $app->db->run("DROP TABLE IF EXISTS {{$t}}");
                    }
                    $app->db->run('SET FOREIGN_KEY_CHECKS = 1');
                } catch (\Throwable) {
                }
            }
            throw new InstallError($ex->getMessage(), 0, $ex);
        }
        $source = Config::render($config);
        $path = Config::path();
        $written = @file_put_contents($path . '.tmp', $source, LOCK_EX) !== false && @rename($path . '.tmp', $path);
        if ($written) {
            @chmod($path, 0640);
            @unlink(dirname($path) . '/setup-preset.php');
        }
        return ['config' => $source, 'written' => $written, 'connected' => $connected, 'path' => $path];
    }

    /** Everything at once, for install-cli.php and app installers. */
    public static function unattended(array $in): array
    {
        if (Config::installed()) {
            throw new InstallError('Already installed: config.php exists.');
        }
        foreach (array_slice(self::requirements(dirname(Config::path())), 0, 6) as [$name, $ok, $fix]) {
            if (!$ok) {
                throw new InstallError("$name: $fix");
            }
        }
        $db = self::checkDatabase($in['db'] ?? []);
        $gp = self::checkGhostParse($in['ghostparse'] ?? []);
        $admin = self::checkAdmin(($in['admin'] ?? []) + ['app_name' => $in['app_name'] ?? ($gp['account'] ? $gp['account'] . ' Mail' : 'Webmail'), 'base_url' => $in['base_url'] ?? '']);
        return self::install($db, $gp['gp'], $admin, $in['mailboxes'] ?? 'all');
    }
}
