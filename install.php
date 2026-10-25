<?php
// The installer wizard. It checks the server, sets up the database, connects GhostParse, creates the first
// administrator and mailboxes, and writes config.php. Once config.php exists it does nothing.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\Config;
use Webmail\Crypto;
use Webmail\Db;
use Webmail\GhostParse;
use Webmail\Http;
use Webmail\InstallError;
use Webmail\Installer;

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

// Set up from GhostParse ("Install webmail in cPanel"): it made the database and wrote setup-preset.php with it and
// the GhostParse connection. Only the person with the one-time link can use it, and it's deleted once installed.
$presetFile = __DIR__ . '/setup-preset.php';
$preset = is_file($presetFile) ? (require $presetFile) : null;

if (Config::installed()) {
    if ($preset !== null) {
        @unlink($presetFile);
    }
    page('Already installed', '<h1>Already installed</h1><p>This webmail is set up. <a class="btn btn-primary" href="./">Open it</a></p>'
        . '<p class="muted">To run the installer again, delete <code>config.php</code> (and empty the database tables) first.</p>', 5);
}

$detectedUrl = (Http::isHttps() ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost')
    . rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');

// Installed by an app installer (Softaculous, Installatron) or a script: it gave every setting in setup-preset.php with
// 'auto' => true, then opened this page (or the first visitor does). Finish now, once.
if (is_array($preset) && !empty($preset['auto'])) {
    $lock = fopen($presetFile, 'r');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
        page('Installing', '<h1>Installing…</h1><p>The webmail is being set up right now. Reload this page in a moment.</p>');
    }
    if (!Config::installed()) {
        $preset['base_url'] = ($preset['base_url'] ?? '') ?: $detectedUrl;
        try {
            $done = Installer::unattended($preset);
        } catch (InstallError $ex) {
            flock($lock, LOCK_UN);
            page('Install', '<h1>Almost there</h1><div class="notice bad">' . $e($ex->getMessage()) . '</div>'
                . '<p>Fix this in your app installer (or in <code>setup-preset.php</code>) and reload this page. Or delete <code>setup-preset.php</code> and reload to use the installer wizard instead.</p>');
        }
    }
    flock($lock, LOCK_UN);
    @unlink($presetFile);
    $list = !empty($done['connected']) ? '<ul class="checks">' . implode('', array_map(fn ($a) => '<li class="ok"><strong>' . $e($a) . '</strong></li>', $done['connected'])) . '</ul>' : '';
    page('Done', '<h1>All set</h1><p>Your webmail is installed.' . ($list ? ' These addresses deliver here now:' : '') . '</p>' . $list
        . (isset($done) && !$done['written'] ? '<div class="notice warn"><strong>One last step:</strong> this folder isn\'t writable, so save the text below as <code>config.php</code> next to <code>index.php</code>.</div><textarea class="config" readonly rows="14">' . $e($done['config']) . '</textarea>' : '')
        . '<div class="notice warn"><strong>Back up <code>config.php</code></strong> somewhere safe: it holds the encryption key, and without it the stored mail can\'t be read.</div>'
        . '<a class="btn btn-primary" href="./">Sign in</a>', 5);
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
if (is_array($preset)) {
    if (isset($_GET['token'])) {
        $token = is_string($_GET['token']) ? $_GET['token'] : '';
        if (!hash_equals((string) ($preset['token_sha256'] ?? ''), hash('sha256', $token))) {
            page('Setup link', '<h1>That setup link doesn\'t match</h1><p>Copy the whole link from your GhostParse dashboard, or install the webmail there again for a new one.</p>');
        }
        if (strtotime((string) ($preset['expires_at'] ?? '')) < time()) {
            page('Setup link', '<h1>That setup link has expired</h1><p>Install the webmail from your GhostParse dashboard again for a new one (choose a new folder, or delete this one in cPanel first).</p>');
        }
        session_regenerate_id(true);
        $s['preset'] = true;
        $s['db'] = $preset['db'];
        $s['gp'] = $preset['ghostparse'];
        $s['account'] = '';
        $s['form'] = ['base_url' => $preset['base_url'] ?? '', 'app_name' => $preset['app_name'] ?? '', 'admin_email' => $preset['admin_email'] ?? ''];
        header('Location: install.php?step=check');
        exit;
    }
    if (empty($s['preset'])) {
        page('Setup link', '<h1>Finish setting up from GhostParse</h1><p>This webmail was installed from GhostParse. Open the setup link it gave you to finish (it works until setup is finished, for up to 7 days).</p>');
    }
}
$fromPreset = !empty($s['preset']);
$error = '';
$v = fn (string $k, string $default = '') => $e($_POST[$k] ?? $s['form'][$k] ?? $default);

// ------------------------------------------------------------------------------------------------ 1. requirements
if ($step === 'check') {
    $checks = Installer::requirements(__DIR__);
    if ($fromPreset) {
        try {
            new Db($s['db'], $s['db']['prefix']);
            $dbOk = true;
        } catch (\PDOException) {
            $dbOk = false;
        }
        array_splice($checks, 6, 0, [['The database GhostParse made', $dbOk, "Can't connect to it yet. Wait a minute and reload; if it still fails, check it in cPanel → MySQL Databases."]]);
    }
    $hard = array_filter($checks, fn ($c) => !$c[1] && $c[0] !== 'config.php can be written');
    $rows = '';
    foreach ($checks as [$name, $ok, $fix]) {
        $rows .= '<li class="' . ($ok ? 'ok' : 'bad') . '"><strong>' . $e($name) . '</strong>' . ($ok ? '' : '<span>' . $e($fix) . '</span>') . '</li>';
    }
    $https = Http::isHttps() ? '' : '<div class="notice warn">This page isn\'t on HTTPS. Use https:// for the webmail: GhostParse only sends email to https addresses, and passwords need it.</div>';
    page('Check', '<h1>Install your webmail</h1><p>' . ($fromPreset ? 'GhostParse has made the database and connected your account: just your sign-in and mailboxes to go.' : 'It takes about five minutes. You need a MySQL database and a GhostParse API key.') . '</p>'
        . $https . '<ul class="checks">' . $rows . '</ul>'
        . ($hard ? '<p class="error">Fix the items above, then reload this page.</p>' : '<a class="btn btn-primary" href="install.php?step=' . ($fromPreset ? 'admin' : 'db') . '">Start</a>'), 0);
}

// ------------------------------------------------------------------------------------------------ 2. database
if ($step === 'db' || ($step === 'ghostparse' && $fromPreset)) {
    if ($fromPreset) {
        header('Location: install.php?step=admin');
        exit;
    }
    if ($post) {
        $s['form'] = array_merge($s['form'] ?? [], array_diff_key($_POST, ['pass' => 1, 'csrf' => 1]));
        try {
            $s['db'] = Installer::checkDatabase($_POST);
            header('Location: install.php?step=ghostparse');
            exit;
        } catch (InstallError $ex) {
            $error = $ex->getMessage();
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
        $s['form'] = array_merge($s['form'] ?? [], ['api_url' => rtrim(trim((string) ($_POST['api_url'] ?? '')), '/')]);
        try {
            $checked = Installer::checkGhostParse($_POST);
            $s['gp'] = $checked['gp'];
            $s['account'] = $checked['account'];
            header('Location: install.php?step=admin');
            exit;
        } catch (InstallError $ex) {
            $error = $ex->getMessage();
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
        $s['form'] = array_merge($s['form'] ?? [], ['admin_name' => trim((string) ($_POST['admin_name'] ?? '')), 'admin_email' => trim((string) ($_POST['admin_email'] ?? '')),
            'app_name' => trim((string) ($_POST['app_name'] ?? '')), 'base_url' => trim((string) ($_POST['base_url'] ?? ''))]);
        try {
            if (trim((string) ($_POST['admin_name'] ?? '')) === '') {
                throw new InstallError('Enter your name.');
            }
            if (($_POST['password'] ?? '') !== ($_POST['password2'] ?? '')) {
                throw new InstallError("The passwords don't match.");
            }
            $s['admin'] = Installer::checkAdmin(['name' => $_POST['admin_name'] ?? '', 'email' => $_POST['admin_email'] ?? '', 'password' => $_POST['password'] ?? '',
                'app_name' => $_POST['app_name'] ?? '', 'base_url' => $_POST['base_url'] ?? '']);
            header('Location: install.php?step=mailboxes');
            exit;
        } catch (InstallError $ex) {
            $error = $ex->getMessage();
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
    try {
        $addresses = Installer::addresses(new GhostParse($s['gp']['api_url'], $s['gp']['api_key']));
    } catch (InstallError $ex) {
        page('Mailboxes', '<h1>Mailboxes</h1><div class="notice bad">' . $e($ex->getMessage()) . '</div><a class="btn" href="install.php?step=mailboxes">Try again</a>', 4);
    }
    if ($post) {
        try {
            $s['key'] ??= base64_encode(Crypto::newKey());
            $done = Installer::install($s['db'], $s['gp'], $s['admin'], (array) ($_POST['addresses'] ?? []), $s['key']);
        } catch (InstallError $ex) {
            page('Mailboxes', '<h1>Install failed</h1><div class="notice bad">' . $e($ex->getMessage()) . '</div><a class="btn" href="install.php?step=mailboxes">Back</a>', 4);
        }
        $connected = $done['connected'];
        $written = $done['written'];
        $source = $done['config'];
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
