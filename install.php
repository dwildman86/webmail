<?php
// The installer wizard. It checks the server, sets up the database, connects GhostParse, creates the first
// administrator and mailboxes, and writes config.php. Once config.php exists it does nothing.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\Admin;
use Webmail\App;
use Webmail\Auth;
use Webmail\Config;
use Webmail\Crypto;
use Webmail\Db;
use Webmail\GhostParse;
use Webmail\GhostParseError;
use Webmail\Http;
use Webmail\Mailstore;
use Webmail\Schema;

Http::securityHeaders();
header('Cache-Control: no-store');

$e = fn ($v) => htmlspecialchars((string) $v, ENT_QUOTES | ENT_HTML5, 'UTF-8');

function page(string $title, string $body, int $step = 0): never
{
    $steps = ['Check', 'Database', 'GhostParse', 'Administrator', 'Mailboxes', 'Done'];
    $nav = '';
    foreach ($steps as $i => $s) {
        $nav .= '<li class="' . ($i < $step ? 'done' : ($i === $step ? 'on' : '')) . '">' . htmlspecialchars($s) . '</li>';
    }
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="robots" content="noindex"><title>' . htmlspecialchars($title) . ' · Install webmail</title>'
        . '<link rel="stylesheet" href="assets/app.css"></head><body class="installer"><main class="install-wrap">'
        . '<div class="brand"><span class="logo" aria-hidden="true"></span> Webmail setup</div>'
        . '<ol class="steps">' . $nav . '</ol><section class="card">' . $body . '</section>'
        . '<p class="fine">Your mail is stored encrypted in your own database. The installer locks itself when it finishes.</p></main></body></html>';
    exit;
}

if (Config::installed()) {
    page('Already installed', '<h1>Already installed</h1><p>This webmail is set up. <a class="btn btn-primary" href="./">Open it</a></p>'
        . '<p class="muted">To run the installer again, delete <code>config.php</code> (and empty the database tables) first.</p>', 5);
}

session_name('wminstall');
session_set_cookie_params(['httponly' => true, 'samesite' => 'Strict', 'secure' => Http::isHttps()]);
session_start();
$s = &$_SESSION;
$s['csrf'] ??= bin2hex(random_bytes(16));
$csrf = '<input type="hidden" name="csrf" value="' . $s['csrf'] . '">';
$step = (string) ($_GET['step'] ?? 'check');
$post = $_SERVER['REQUEST_METHOD'] === 'POST';
if ($post && !hash_equals($s['csrf'], (string) ($_POST['csrf'] ?? ''))) {
    page('Expired', '<h1>Please start again</h1><p>The form expired.</p><a class="btn" href="install.php">Start again</a>');
}
$error = '';
$v = fn (string $k, string $default = '') => $e($_POST[$k] ?? $s['form'][$k] ?? $default);
$detectedUrl = (Http::isHttps() ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost')
    . rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');

// ------------------------------------------------------------------------------------------------ 1. requirements
if ($step === 'check') {
    $dir = __DIR__;
    $checks = [
        ['PHP 8.1 or newer', PHP_VERSION_ID >= 80100, 'This server has PHP ' . PHP_VERSION . '. Choose PHP 8.1+ in your hosting control panel.'],
        ['Sodium (encryption)', extension_loaded('sodium'), 'Turn on the "sodium" PHP extension in your hosting control panel.'],
        ['PDO MySQL', extension_loaded('pdo_mysql'), 'Turn on the "pdo_mysql" PHP extension.'],
        ['cURL', extension_loaded('curl'), 'Turn on the "curl" PHP extension.'],
        ['mbstring', extension_loaded('mbstring'), 'Turn on the "mbstring" PHP extension.'],
        ['OpenSSL', extension_loaded('openssl'), 'Turn on the "openssl" PHP extension.'],
        ['config.php can be written', is_writable($dir) || (is_file("$dir/config.php") && is_writable("$dir/config.php")), "The folder isn't writable: you'll be shown config.php to upload yourself."],
    ];
    $hard = array_filter(array_slice($checks, 0, 6), fn ($c) => !$c[1]);
    $rows = '';
    foreach ($checks as [$name, $ok, $fix]) {
        $rows .= '<li class="' . ($ok ? 'ok' : 'bad') . '"><strong>' . $e($name) . '</strong>' . ($ok ? '' : '<span>' . $e($fix) . '</span>') . '</li>';
    }
    $https = Http::isHttps() ? '' : '<div class="notice warn">This page isn\'t on HTTPS. Use https:// for the webmail: GhostParse only sends email to https addresses, and passwords need it.</div>';
    page('Check', '<h1>Install your webmail</h1><p>It takes about five minutes. You need a MySQL database and a GhostParse API key.</p>'
        . $https . '<ul class="checks">' . $rows . '</ul>'
        . ($hard ? '<p class="error">Fix the items above, then reload this page.</p>' : '<a class="btn btn-primary" href="install.php?step=db">Start</a>'), 0);
}

// ------------------------------------------------------------------------------------------------ 2. database
if ($step === 'db') {
    if ($post) {
        $db = ['host' => trim($_POST['host'] ?? 'localhost'), 'port' => (int) ($_POST['port'] ?? 3306), 'name' => trim($_POST['name'] ?? ''),
            'user' => trim($_POST['user'] ?? ''), 'pass' => (string) ($_POST['pass'] ?? ''), 'prefix' => preg_replace('/\W/', '', $_POST['prefix'] ?? 'wm_') ?: 'wm_'];
        $s['form'] = array_merge($s['form'] ?? [], array_diff_key($db, ['pass' => 1]));
        try {
            $conn = new Db($db, $db['prefix']);
            $exists = $conn->value('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [$db['name'], $db['prefix'] . 'messages']);
            if ($exists) {
                $error = "This database already has webmail tables with the prefix {$db['prefix']}. Use another prefix or database.";
            } else {
                $s['db'] = $db;
                header('Location: install.php?step=ghostparse');
                exit;
            }
        } catch (\PDOException $ex) {
            $error = "Can't connect to the database: " . preg_replace('/^SQLSTATE\[\w+\] \[\d+\] /', '', $ex->getMessage());
        }
    }
    page('Database', '<h1>Your database</h1><p>Create an empty MySQL or MariaDB database and a user for it in your hosting control panel, then enter them here.</p>'
        . ($error ? '<div class="notice bad">' . $e($error) . '</div>' : '')
        . '<form method="post">' . $csrf
        . '<div class="row"><label class="field grow">Host<input name="host" value="' . $v('host', 'localhost') . '" required></label>'
        . '<label class="field short">Port<input name="port" type="number" value="' . $v('port', '3306') . '" required></label></div>'
        . '<label class="field">Database name<input name="name" value="' . $v('name') . '" required></label>'
        . '<label class="field">User<input name="user" value="' . $v('user') . '" required autocomplete="off"></label>'
        . '<label class="field">Password<input name="pass" type="password" autocomplete="new-password"></label>'
        . '<label class="field">Table prefix<input name="prefix" value="' . $v('prefix', 'wm_') . '"></label>'
        . '<button class="btn btn-primary">Connect</button></form>', 1);
}

// ------------------------------------------------------------------------------------------------ 3. GhostParse
if ($step === 'ghostparse') {
    if (empty($s['db'])) {
        header('Location: install.php?step=db');
        exit;
    }
    if ($post) {
        $gp = ['api_url' => rtrim(trim($_POST['api_url'] ?? ''), '/'), 'api_key' => trim($_POST['api_key'] ?? ''), 'webhook_secret' => trim($_POST['webhook_secret'] ?? '')];
        $s['form'] = array_merge($s['form'] ?? [], ['api_url' => $gp['api_url']]);
        if (!preg_match('#^https?://#', $gp['api_url'])) {
            $error = 'Enter the GhostParse address, like https://ghostparse.com';
        } elseif (!preg_match('/^whsec_[A-Za-z0-9+\/=]{32,}$/', $gp['webhook_secret'])) {
            $error = 'The signing secret starts with whsec_ (Dashboard → Inbound webhook → Signing secret).';
        } else {
            try {
                $me = (new GhostParse($gp['api_url'], $gp['api_key']))->me();
                $scopes = $me['api_key']['scopes'] ?? [];
                $missing = array_diff(['send', 'domains'], $scopes);
                if ($missing) {
                    $error = 'This API key needs the ' . implode(' and ', $missing) . ' permission' . (count($missing) > 1 ? 's' : '') . '. Create a key with Send and Domains ticked.';
                } else {
                    $s['gp'] = $gp;
                    $s['account'] = $me['account']['name'] ?? '';
                    header('Location: install.php?step=admin');
                    exit;
                }
            } catch (GhostParseError $ex) {
                $error = $ex->status === 401 ? 'GhostParse didn\'t accept that API key.' : $ex->getMessage();
            }
        }
    }
    page('GhostParse', '<h1>Connect GhostParse</h1><p>The webmail receives and sends through your GhostParse account. In the GhostParse dashboard:</p>'
        . '<ol class="howto"><li><strong>API keys → New key</strong>, with <em>Send</em> and <em>Domains</em> ticked.</li>'
        . '<li><strong>Inbound webhook → Signing secret</strong>: copy it (it starts with <code>whsec_</code>).</li></ol>'
        . ($error ? '<div class="notice bad">' . $e($error) . '</div>' : '')
        . '<form method="post">' . $csrf
        . '<label class="field">GhostParse address<input name="api_url" type="url" value="' . $v('api_url', 'https://ghostparse.com') . '" required></label>'
        . '<label class="field">API key<input name="api_key" required autocomplete="off" placeholder="ek_live_…"></label>'
        . '<label class="field">Webhook signing secret<input name="webhook_secret" required autocomplete="off" placeholder="whsec_…"></label>'
        . '<button class="btn btn-primary">Check and continue</button></form>', 2);
}

// ------------------------------------------------------------------------------------------------ 4. administrator
if ($step === 'admin') {
    if (empty($s['gp'])) {
        header('Location: install.php?step=ghostparse');
        exit;
    }
    if ($post) {
        $a = ['name' => trim($_POST['admin_name'] ?? ''), 'email' => trim($_POST['admin_email'] ?? ''), 'password' => (string) ($_POST['password'] ?? ''),
            'app_name' => trim($_POST['app_name'] ?? '') ?: 'Webmail', 'base_url' => rtrim(trim($_POST['base_url'] ?? ''), '/')];
        $s['form'] = array_merge($s['form'] ?? [], ['admin_name' => $a['name'], 'admin_email' => $a['email'], 'app_name' => $a['app_name'], 'base_url' => $a['base_url']]);
        if (!filter_var($a['email'], FILTER_VALIDATE_EMAIL)) {
            $error = 'Enter a valid email address to sign in with.';
        } elseif (mb_strlen($a['password']) < 10) {
            $error = 'Use a password of at least 10 characters.';
        } elseif ($a['password'] !== ($_POST['password2'] ?? '')) {
            $error = "The passwords don't match.";
        } elseif (!preg_match('#^https?://[^\s]+$#', $a['base_url'])) {
            $error = 'Enter the address this webmail is at.';
        } else {
            $s['admin'] = $a;
            header('Location: install.php?step=mailboxes');
            exit;
        }
    }
    page('Administrator', '<h1>Your administrator account</h1>'
        . ($error ? '<div class="notice bad">' . $e($error) . '</div>' : '')
        . '<form method="post">' . $csrf
        . '<label class="field">Your name<input name="admin_name" value="' . $v('admin_name') . '" required></label>'
        . '<label class="field">Email to sign in with<input name="admin_email" type="email" value="' . $v('admin_email') . '" required autocomplete="username"></label>'
        . '<div class="row"><label class="field grow">Password<input name="password" type="password" minlength="10" required autocomplete="new-password"></label>'
        . '<label class="field grow">Again<input name="password2" type="password" minlength="10" required autocomplete="new-password"></label></div>'
        . '<label class="field">Webmail name<input name="app_name" value="' . $v('app_name', $s['account'] ? $s['account'] . ' Mail' : 'Webmail') . '"></label>'
        . '<label class="field">Webmail address<input name="base_url" type="url" value="' . $v('base_url', $detectedUrl) . '" required>'
        . '<small>GhostParse sends incoming email to <code>…/webhook.php</code> here.</small></label>'
        . '<button class="btn btn-primary">Continue</button></form>', 3);
}

// ------------------------------------------------------------------------------------------------ 5. mailboxes, then install
if ($step === 'mailboxes') {
    if (empty($s['admin'])) {
        header('Location: install.php?step=admin');
        exit;
    }
    $gp = new GhostParse($s['gp']['api_url'], $s['gp']['api_key']);
    try {
        $addresses = [];
        foreach ($gp->domains() as $d) {
            foreach ($d['addresses'] ?? [] as $a) {
                if (empty($a['is_pattern'])) {
                    $addresses[] = ['address' => $a['address'], 'note' => ($d['inbound_ready'] ?? false) ? '' : 'domain not receiving yet', 'webhook' => $a['webhook_url'] ?? null];
                }
            }
        }
    } catch (GhostParseError $ex) {
        page('Mailboxes', '<h1>Mailboxes</h1><div class="notice bad">Couldn\'t read your GhostParse addresses: ' . $e($ex->getMessage()) . '</div><a class="btn" href="install.php?step=mailboxes">Try again</a>', 4);
    }
    if ($post) {
        $chosen = array_values(array_intersect(array_column($addresses, 'address'), (array) ($_POST['addresses'] ?? [])));
        $config = [
            'app_name' => $s['admin']['app_name'], 'base_url' => $s['admin']['base_url'], 'key' => $s['key'] ??= base64_encode(Crypto::newKey()),
            'db' => $s['db'], 'ghostparse' => $s['gp'], 'installed_at' => gmdate('c'), 'version' => App::VERSION,
        ];
        try {
            $app = new App(new Config($config), new Db($s['db'], $s['db']['prefix']), $gp);
            Schema::migrate($app->db);
            $uid = (new Auth($app))->createUser($s['admin']['email'], $s['admin']['name'], $s['admin']['password'], 'admin');
            $admin = new Admin($app);
            $connected = [];
            foreach ($chosen as $address) {
                $id = $admin->connectAddress($address, $s['admin']['app_name']);
                (new Mailstore($app))->grant($uid, $id);
                $connected[] = $address;
            }
        } catch (\Throwable $ex) {
            // Start clean next time: the database step only accepted a database without these tables.
            if (isset($app)) {
                try {
                    $app->db->run('SET FOREIGN_KEY_CHECKS = 0');
                    foreach (Schema::tables() as $t) {
                        $app->db->run("DROP TABLE IF EXISTS {{$t}}");
                    }
                    $app->db->run('SET FOREIGN_KEY_CHECKS = 1');
                } catch (\Throwable) {
                }
            }
            page('Mailboxes', '<h1>Install failed</h1><div class="notice bad">' . $e($ex->getMessage()) . '</div><a class="btn" href="install.php?step=mailboxes">Back</a>', 4);
        }
        $source = Config::render($config);
        $written = @file_put_contents(Config::path() . '.tmp', $source, LOCK_EX) !== false && @rename(Config::path() . '.tmp', Config::path());
        if ($written) {
            @chmod(Config::path(), 0640);
        }
        $_SESSION = [];
        session_destroy();
        $list = $connected ? '<ul class="checks">' . implode('', array_map(fn ($a) => '<li class="ok"><strong>' . $e($a) . '</strong></li>', $connected)) . '</ul>' : '<p>No mailboxes yet: add them under Settings → Mailboxes.</p>';
        $manual = $written ? '' : '<div class="notice warn"><strong>One last step:</strong> this folder isn\'t writable, so save the text below as <code>config.php</code> '
            . 'next to <code>index.php</code>, then open the webmail.</div><textarea class="config" readonly rows="14">' . $e($source) . '</textarea>';
        page('Done', '<h1>All set</h1><p>Your webmail is installed and the installer is locked. These addresses deliver here now:</p>' . $list . $manual
            . '<div class="notice warn"><strong>Back up <code>config.php</code></strong> somewhere safe: it holds the encryption key, and without it the stored mail can\'t be read.</div>'
            . '<a class="btn btn-primary" href="./">Open your webmail</a>', 5);
    }
    $rows = '';
    foreach ($addresses as $a) {
        $notes = array_filter([$a['note'] ? ucfirst($a['note']) . '.' : '',
            $a['webhook'] && $a['webhook'] !== $s['admin']['base_url'] . '/webhook.php' ? 'Its email goes to ' . $a['webhook'] . ' now; that stops.' : '']);
        $rows .= '<label class="check address"><input type="checkbox" name="addresses[]" value="' . $e($a['address']) . '" checked><span>' . $e($a['address'])
            . ($notes ? '<small class="muted">' . $e(implode(' ', $notes)) . '</small>' : '') . '</span></label>';
    }
    page('Mailboxes', '<h1>Your mailboxes</h1><p>Choose the GhostParse addresses to read and send from here. Each one\'s webhook is pointed at this webmail.</p>'
        . '<form method="post">' . $csrf . ($rows ?: '<p class="muted">Your account has no addresses yet: add them in GhostParse under Domains, or later here.</p>')
        . '<button class="btn btn-primary">Install</button></form>', 4);
}

header('Location: install.php');
