<?php
// Install the webmail without the browser wizard: for app installers (Softaculous, Installatron), scripts and
// command-line hosting. Run it with PHP 8.1+ from the webmail's folder:
//
//   php install-cli.php --db-name=acme_mail --db-user=acme_mail --db-pass=… \
//     --api-key=ek_live_… --webhook-secret=whsec_… \
//     --admin-email=you@example.com --admin-password=… --base-url=https://example.com/mail
//
// Optional: --db-host (localhost), --db-port (3306), --db-prefix (wm_), --api-url (https://ghostparse.com),
// --admin-name, --app-name, --mailboxes (all, or a comma-separated list of addresses). Or give it all as JSON:
// --json=settings.json (the same names, with _ for -, or the nested form Webmail\Installer::unattended takes).
// It prints JSON and exits 0 when installed, 1 when not (with the reason), 2 for a usage error.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require __DIR__ . '/app/bootstrap.php';

use Webmail\InstallError;
use Webmail\Installer;

$names = ['db-host', 'db-port', 'db-name', 'db-user', 'db-pass', 'db-prefix', 'api-url', 'api-key', 'webhook-secret',
    'admin-name', 'admin-email', 'admin-password', 'base-url', 'app-name', 'mailboxes', 'json', 'help'];
$opts = getopt('', array_map(fn ($n) => $n === 'help' ? $n : "$n:", $names));
if (isset($opts['help']) || $opts === []) {
    fwrite(STDERR, "Usage: php install-cli.php --db-name=… --db-user=… --db-pass=… --api-key=… --webhook-secret=… --admin-email=… --admin-password=… --base-url=…\n"
        . "See the top of install-cli.php for every option.\n");
    exit(isset($opts['help']) ? 0 : 2);
}

$flat = [];
if (isset($opts['json'])) {
    $raw = @file_get_contents((string) $opts['json']);
    $decoded = $raw === false ? null : json_decode($raw, true);
    if (!is_array($decoded)) {
        fwrite(STDERR, "Can't read {$opts['json']} as JSON.\n");
        exit(2);
    }
    if (isset($decoded['db']) && is_array($decoded['db'])) {
        $input = $decoded;
    }
    foreach ($decoded as $k => $v) {
        $flat[str_replace('_', '-', (string) $k)] = $v;
    }
}
foreach ($opts as $k => $v) {
    $flat[$k] = is_array($v) ? end($v) : $v;
}
$get = fn (string $k, $default = null) => array_key_exists($k, $flat) && $flat[$k] !== '' ? $flat[$k] : $default;
$mailboxes = $get('mailboxes', 'all');
$input ??= [
    'db' => ['host' => $get('db-host', 'localhost'), 'port' => $get('db-port', 3306), 'name' => $get('db-name', ''), 'user' => $get('db-user', ''),
        'pass' => $get('db-pass', ''), 'prefix' => $get('db-prefix', 'wm_')],
    'ghostparse' => ['api_url' => $get('api-url', 'https://ghostparse.com'), 'api_key' => $get('api-key', ''), 'webhook_secret' => $get('webhook-secret', '')],
    'admin' => ['name' => $get('admin-name', ''), 'email' => $get('admin-email', ''), 'password' => $get('admin-password', '')],
    'base_url' => $get('base-url', ''),
    'app_name' => $get('app-name'),
    'mailboxes' => is_array($mailboxes) ? $mailboxes : (strtolower(trim((string) $mailboxes)) === 'all' ? 'all' : array_values(array_filter(array_map('trim', explode(',', (string) $mailboxes))))),
];
if ($input['app_name'] === null) {
    unset($input['app_name']);
}

try {
    $done = Installer::unattended($input);
} catch (InstallError $ex) {
    echo json_encode(['installed' => false, 'error' => $ex->getMessage()], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), "\n";
    exit(1);
}
echo json_encode([
    'installed' => true,
    'config_written' => $done['written'],
    'config_path' => $done['path'],
    'mailboxes' => $done['connected'],
] + ($done['written'] ? [] : ['config' => $done['config']]), JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), "\n";
exit(0);
