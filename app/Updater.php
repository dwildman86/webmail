<?php
declare(strict_types=1);

namespace Webmail;

/**
 * One-click updates for administrators. GhostParse publishes the newest webmail at
 * <api_url>/downloads/webmail-latest.json (version, zip, SHA-256, notes); this checks it now and then, and on request
 * downloads the zip, checks it, and copies the new files over these ones.
 *
 * Every release is signed with GhostParse's release key (Ed25519, kept off its servers: see its deploy/sign-webmail.mjs),
 * over its version and the zip's SHA-256. A release that isn't signed by one of RELEASE_KEYS is never installed, so a
 * taken-over server, domain or certificate can't push code to webmails.
 *
 * Kept: config.php, setup-preset.php and storage/ (the settings, the encryption key and uploaded files). Every file
 * that's replaced is copied to storage/updates/backup-<old version>/ first, and if anything goes wrong part way, the
 * old files are put back. The database is brought up to date by the next request, as after a manual upload.
 */
final class Updater
{
    /** How often the webmail asks GhostParse whether there's a newer release. */
    private const CHECK_SECONDS = 12 * 3600;
    private const MAX_ZIP_BYTES = 30 * 1024 * 1024;
    /** Never replaced: the settings and what's stored here. */
    private const KEEP = ['config.php', 'config.php.tmp', 'setup-preset.php'];
    /** The public keys releases are signed with (base64, Ed25519). A new key is added here a release before it's used. */
    public const RELEASE_KEYS = ['genSq3JLE1H+TbMTAojZk+JlbfNmh8NROWMhGtSVyUc='];

    /** @var string[] */
    private array $keys;

    /** @var callable(string): array{0: int, 1: string} Fetches a URL: [status, body]. Tests replace it. */
    private $fetch;

    /** @param string[]|null $keys Tests sign with their own key. */
    public function __construct(private App $app, private ?string $root = null, ?callable $fetch = null, ?array $keys = null)
    {
        $this->root ??= dirname(__DIR__);
        $this->fetch = $fetch ?? [$this, 'get'];
        $this->keys = $keys ?? self::RELEASE_KEYS;
    }

    /** What a release's signature covers: its version and its zip, so an old release can't be passed off as a new one. */
    public static function signed(string $version, string $sha256): string
    {
        return "ghostparse-webmail\n$version\n$sha256\n";
    }

    /** Whether a release was signed with one of the release keys. */
    private function signedByGhostParse(string $version, string $sha256, string $signature): bool
    {
        $sig = base64_decode($signature, true);
        if ($sig === false || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES) {
            return false;
        }
        foreach ($this->keys as $key) {
            $pk = base64_decode($key, true);
            if ($pk !== false && strlen($pk) === SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES && sodium_crypto_sign_verify_detached($sig, self::signed($version, $sha256), $pk)) {
                return true;
            }
        }
        return false;
    }

    private function manifestUrl(): string
    {
        return rtrim((string) ($this->app->config->get('ghostparse')['api_url'] ?? 'https://ghostparse.com'), '/') . '/downloads/webmail-latest.json';
    }

    /**
     * What's installed, what's newest, and whether this server can update itself.
     * @return array{current: string, latest: ?string, available: bool, notes: string, checked_at: ?int, can_update: bool, blockers: string[], error?: string}
     */
    public function check(bool $refresh = false): array
    {
        $cached = $this->app->db->value("SELECT v FROM {meta} WHERE k = 'update_check'");
        $state = $cached ? json_decode((string) $cached, true) : null;
        if ($refresh || !is_array($state) || ($state['checked_at'] ?? 0) < time() - self::CHECK_SECONDS) {
            try {
                $state = ['checked_at' => time(), 'release' => $this->manifest()];
            } catch (HttpError $e) {
                $state = ['checked_at' => time(), 'release' => $state['release'] ?? null, 'error' => $e->getMessage()];
            }
            $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('update_check', ?)", [json_encode($state)]);
        }
        $release = $state['release'] ?? null;
        $blockers = $this->blockers();
        $available = $release && version_compare((string) $release['version'], App::VERSION, '>');
        return ['current' => App::VERSION, 'latest' => $release['version'] ?? null, 'available' => (bool) $available,
            'notes' => (string) ($release['notes'] ?? ''), 'checked_at' => $state['checked_at'] ?? null,
            'can_update' => !$blockers, 'blockers' => $blockers] + (isset($state['error']) ? ['error' => $state['error']] : []);
    }

    /** The newest release, as GhostParse describes it. */
    private function manifest(): array
    {
        [$status, $body] = ($this->fetch)($this->manifestUrl());
        $m = $status === 200 ? json_decode($body, true) : null;
        if (!is_array($m) || !preg_match('/^\d+\.\d+\.\d+$/', (string) ($m['version'] ?? '')) || !preg_match('/^[a-f0-9]{64}$/', (string) ($m['sha256'] ?? ''))
            || !preg_match('#^https://#', (string) ($m['url'] ?? '')) && !$this->app->config->get('update_allow_http', false)) {
            throw new HttpError(502, "Couldn't check for updates at GhostParse" . ($status ? " (it answered $status)" : '') . '.', 'update_check_failed');
        }
        if (!$this->signedByGhostParse($m['version'], $m['sha256'], (string) ($m['signature'] ?? ''))) {
            throw new HttpError(502, "Webmail {$m['version']} isn't signed by GhostParse, so it won't be installed. Nothing was changed.", 'signature');
        }
        return ['version' => $m['version'], 'url' => (string) $m['url'], 'sha256' => $m['sha256'], 'size' => (int) ($m['size'] ?? 0),
            'notes' => mb_substr((string) ($m['notes'] ?? ''), 0, 4000)];
    }

    /** Why this server can't update itself (then it's done by uploading the zip, as before). @return string[] */
    public function blockers(): array
    {
        $out = [];
        if (!class_exists(\ZipArchive::class)) {
            $out[] = "PHP's zip extension isn't turned on here. Ask your host to turn it on, or update by uploading the new zip.";
        }
        foreach (['', '/app', '/assets', '/storage'] as $dir) {
            if (!is_writable($this->root . $dir)) {
                $out[] = 'The webmail can\'t write to its own folder' . ($dir ? " ($dir)" : '') . '. Give the web server write access to it, or update by uploading the new zip.';
                break;
            }
        }
        return $out;
    }

    /**
     * Download, check and install the newest release. Returns the version now installed.
     */
    public function install(): array
    {
        if ($blockers = $this->blockers()) {
            throw new HttpError(409, $blockers[0], 'cant_update');
        }
        $lock = (int) $this->app->db->value("SELECT GET_LOCK(CONCAT(DATABASE(), '.webmail_update'), 0)");
        if ($lock !== 1) {
            throw new HttpError(409, 'An update is already running. Give it a minute.', 'busy');
        }
        try {
            $release = $this->manifest();
            if (!version_compare($release['version'], App::VERSION, '>')) {
                throw new HttpError(409, 'This webmail is already up to date.', 'up_to_date');
            }
            $work = $this->root . '/storage/updates';
            if (!is_dir($work) && !@mkdir($work, 0700, true)) {
                throw new HttpError(500, "Couldn't make storage/updates for the download.", 'cant_update');
            }
            $zipFile = "$work/webmail-{$release['version']}.zip";
            [$status, $body] = ($this->fetch)($release['url']);
            if ($status !== 200 || $body === '' || strlen($body) > self::MAX_ZIP_BYTES) {
                throw new HttpError(502, "Couldn't download webmail {$release['version']}" . ($status ? " (GhostParse answered $status)" : '') . '. Nothing was changed.', 'download_failed');
            }
            if (!hash_equals($release['sha256'], hash('sha256', $body))) {
                throw new HttpError(502, "The download of webmail {$release['version']} didn't match its checksum. Nothing was changed: try again later.", 'checksum');
            }
            file_put_contents($zipFile, $body);
            try {
                $files = $this->read($zipFile, $release['version']);
                $this->apply($files, App::VERSION);
            } finally {
                @unlink($zipFile);
            }
            $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('updated', ?)", [json_encode(['from' => App::VERSION, 'to' => $release['version'], 'at' => time()])]);
            $this->app->db->run("DELETE FROM {meta} WHERE k = 'update_check'");
            if (function_exists('opcache_reset')) {
                @opcache_reset();
            }
            return ['from' => App::VERSION, 'version' => $release['version']];
        } finally {
            $this->app->db->value("SELECT RELEASE_LOCK(CONCAT(DATABASE(), '.webmail_update'))");
        }
    }

    /**
     * The files in a release zip, by path inside the webmail folder, after checking it's the webmail and the version
     * it says, and that no entry tries to leave the folder.
     * @return array<string, string>
     */
    public function read(string $zipFile, string $version): array
    {
        $zip = new \ZipArchive();
        if ($zip->open($zipFile) !== true) {
            throw new HttpError(502, 'The download isn\'t a zip file. Nothing was changed.', 'bad_zip');
        }
        $files = [];
        try {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = (string) $zip->getNameIndex($i);
                if (str_ends_with($name, '/')) {
                    continue;
                }
                if (!str_starts_with($name, 'webmail/')) {
                    throw new HttpError(502, 'The download isn\'t the webmail. Nothing was changed.', 'bad_zip');
                }
                $rel = substr($name, strlen('webmail/'));
                if ($rel === '' || str_contains($rel, '\\') || str_contains($rel, "\0") || str_starts_with($rel, '/')
                    || in_array('..', explode('/', $rel), true) || in_array('.', explode('/', $rel), true)) {
                    throw new HttpError(502, "The download has a file that isn't allowed ($name). Nothing was changed.", 'bad_zip');
                }
                $files[$rel] = (string) $zip->getFromIndex($i);
            }
        } finally {
            $zip->close();
        }
        $app = $files['app/App.php'] ?? '';
        if (!preg_match("/const VERSION = '" . preg_quote($version, '/') . "'/", $app) || !isset($files['index.php'], $files['api.php'])) {
            throw new HttpError(502, "The download doesn't contain webmail $version. Nothing was changed.", 'bad_zip');
        }
        return $files;
    }

    /** Copy the new files in, keeping a backup of each one replaced, and putting everything back if a copy fails. */
    public function apply(array $files, string $fromVersion): void
    {
        $backup = $this->root . '/storage/updates/backup-' . $fromVersion;
        $replaced = [];
        $created = [];
        try {
            foreach ($files as $rel => $content) {
                if (in_array($rel, self::KEEP, true)) {
                    continue;
                }
                $target = $this->root . '/' . $rel;
                // storage/ only gets its guard files, and only if they're missing.
                if (str_starts_with($rel, 'storage/') && file_exists($target)) {
                    continue;
                }
                $dir = dirname($target);
                if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
                    throw new HttpError(500, "Couldn't create $rel's folder.", 'write_failed');
                }
                if (is_dir($target)) {
                    throw new HttpError(500, "Couldn't write $rel: there's a folder in its place.", 'write_failed');
                }
                if (file_exists($target)) {
                    if (hash_file('sha256', $target) === hash('sha256', $content)) {
                        continue;
                    }
                    $copy = "$backup/$rel";
                    if (!is_dir(dirname($copy))) {
                        @mkdir(dirname($copy), 0700, true);
                    }
                    if (!@copy($target, $copy)) {
                        throw new HttpError(500, "Couldn't back up $rel before replacing it.", 'write_failed');
                    }
                    $replaced[$rel] = $copy;
                } else {
                    $created[] = $target;
                }
                // Written beside it, then swapped in: nobody ever loads half a file.
                $tmp = "$target.update-" . bin2hex(random_bytes(4));
                if (@file_put_contents($tmp, $content) !== strlen($content) || !@rename($tmp, $target)) {
                    @unlink($tmp);
                    throw new HttpError(500, "Couldn't write $rel.", 'write_failed');
                }
            }
        } catch (\Throwable $e) {
            foreach ($replaced as $rel => $copy) {
                @copy($copy, $this->root . '/' . $rel);
            }
            foreach ($created as $path) {
                @unlink($path);
            }
            throw $e instanceof HttpError ? new HttpError(500, $e->getMessage() . ' The webmail was put back as it was.', 'update_failed') : $e;
        }
    }

    /** @return array{0: int, 1: string} */
    private function get(string $url): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3, CURLOPT_TIMEOUT => 60,
            CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP, CURLOPT_USERAGENT => 'GhostParse-Webmail/' . App::VERSION]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$body === false ? 0 : $status, $body === false ? '' : (string) $body];
    }
}
