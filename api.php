<?php
// The JSON API the interface uses: api.php?a=<action>. Signed-in actions need the session cookie, and changes the
// CSRF token in X-CSRF-Token.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\AddressBook;
use Webmail\Admin;
use Webmail\App;
use Webmail\Auth;
use Webmail\Config;
use Webmail\Http;
use Webmail\HttpError;
use Webmail\Importer;
use Webmail\Mailstore;
use Webmail\Mfa;
use Webmail\Signatures;

Http::securityHeaders();
if (!Config::installed()) {
    Http::json(['error' => 'not_installed', 'message' => 'Run the installer first'], 503);
}

$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
Auth::startSession($base);

$action = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    $app = App::get();
    $auth = new Auth($app);
    $store = new Mailstore($app);
    $int = fn (string $k) => (int) ($_GET[$k] ?? 0);

    \Webmail\Schema::upgrade($app->db); // after uploading a new version: one quick check
    $mfa = new Mfa($app);

    // Before sign-in. The password is the first step; the second (an authenticator code, a recovery code or a
    // passkey) is required before anything else.
    if ($action === 'login' && $method === 'POST') {
        $in = Http::body();
        $auth->login((string) ($in['email'] ?? ''), (string) ($in['password'] ?? ''), Http::ip());
        Http::json(['ok' => true, 'csrf' => Auth::csrfToken()] + secondStep($auth, $mfa));
    }
    if ($action === 'session') {
        $user = $auth->user();
        if (!$user) {
            Http::json(['user' => null, 'csrf' => Auth::csrfToken(), 'app' => ['name' => $app->config->get('app_name', 'Webmail'),
                'passkeys' => (int) $app->db->value('SELECT COUNT(*) FROM {passkeys}') > 0]] + secondStep($auth, $mfa), 401);
        }
        Http::json(['user' => $user, 'csrf' => Auth::csrfToken(), 'mailboxes' => $store->mailboxesFor($user['id']),
            'app' => ['name' => $app->config->get('app_name', 'Webmail'), 'version' => App::VERSION, 'vapid_public_key' => \Webmail\Notifier::supported() ? (new \Webmail\Notifier($app))->vapid()['public'] : null]]);
    }
    if (class_exists(\Webmail\Passkeys::class) && str_starts_with($action, 'passkey/login')) {
        (new \Webmail\Passkeys($app))->route($action, $method, null);
    }
    if ($action === 'logout' && $method === 'POST') {
        $auth->logout();
        Http::json(['ok' => true]);
    }

    // The second step, for a session that has only done its password.
    $pending = $auth->user() ? null : $auth->pending();
    if ($pending && ($action === 'mfa/verify' || str_starts_with($action, 'mfa/setup') || str_starts_with($action, 'passkey/register'))) {
        if ($method !== 'GET') {
            Auth::checkCsrf();
        }
        $in = $method === 'POST' ? Http::body() : [];
        $done = function (array $codes) use ($auth, $pending) {
            $auth->begin($pending['uid']);
            Http::json(['ok' => true, 'csrf' => Auth::csrfToken(), 'recovery_codes' => $codes]);
        };
        if ($pending['stage'] === 'verify' && "$method $action" === 'POST mfa/verify') {
            $mfa->verify($pending['uid'], (string) ($in['code'] ?? ''));
            $done([]);
        }
        // Setting up a second step is only for someone who has none: anyone else has to use theirs first.
        if ($pending['stage'] === 'enrol') {
            $who = ['id' => $pending['uid'], 'email' => $pending['email'], 'name' => $pending['name']];
            switch ("$method $action") {
                case 'GET mfa/setup':
                    Http::json($mfa->beginSetup($pending['email']));
                case 'POST mfa/setup':
                    $done($mfa->confirmSetup($pending['uid'], (string) ($in['code'] ?? '')));
                case 'GET passkey/register/options':
                    Http::json((new \Webmail\Passkeys($app))->registerOptions($who));
                case 'POST passkey/register':
                    (new \Webmail\Passkeys($app))->register($pending['uid'], $in);
                    $done($mfa->newRecoveryCodes($pending['uid']));
            }
        }
        throw new HttpError(403, 'Finish signing in first', 'second_step_required');
    }

    $user = $auth->requireUser();
    if ($method !== 'GET') {
        Auth::checkCsrf();
    }

    switch ("$method $action") {
        case 'GET mfa/status':
            Http::json($mfa->status($user['id']));
        // Changing the authenticator app or getting new recovery codes needs the password again.
        case 'GET mfa/setup':
            Http::json($mfa->beginSetup($user['email']));
        case 'POST mfa/setup':
            $in = Http::body();
            $auth->confirmPassword($user['id'], (string) ($in['password'] ?? ''));
            Http::json(['ok' => true, 'recovery_codes' => $mfa->confirmSetup($user['id'], (string) ($in['code'] ?? ''))]);
        case 'POST mfa/recovery-codes':
            $auth->confirmPassword($user['id'], (string) (Http::body()['password'] ?? ''));
            Http::json(['recovery_codes' => $mfa->newRecoveryCodes($user['id'])]);
        case 'GET messages':
            Http::json($store->list($user['id'], $int('mailbox') ?: null, (string) ($_GET['folder'] ?? 'inbox'), max(1, $int('page')),
                (string) ($_GET['q'] ?? ''), ($_GET['starred'] ?? '') === '1'));
        case 'GET message':
            Http::json($store->get($user['id'], $int('id'), ($_GET['peek'] ?? '') !== '1'));
        case 'GET body':
            // The message as its own document, shown in a sandboxed frame: no scripts, no forms, and remote images
            // only when asked for (they can tell the sender you opened it).
            $m = $store->get($user['id'], $int('id'), false)['message'];
            $images = ($_GET['images'] ?? '') === '1';
            header('Content-Type: text/html; charset=utf-8');
            header('Cache-Control: private, no-store');
            header('X-Content-Type-Options: nosniff');
            // One script runs in the frame: ours, carrying this response's nonce, which tells the page how tall the
            // message is. The email's own scripts and inline handlers have no nonce, so they never run.
            $nonce = base64_encode(random_bytes(16));
            header("Content-Security-Policy: default-src 'none'; script-src 'nonce-$nonce'; style-src 'unsafe-inline'; font-src data:; img-src data:" . ($images ? ' https: http:' : '')
                . "; sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'");
            $esc = fn ($t) => htmlspecialchars((string) $t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $sizer = '<script nonce="' . $nonce . '">(function(){var last=0;function report(){var h=Math.ceil(document.documentElement.scrollHeight);'
                . 'if(h!==last){last=h;parent.postMessage({webmailFrame:' . $int('id') . ',height:h},"*");}}'
                . 'addEventListener("load",report);if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement);}report();})();</script>';
            $html = $m['html'] ? preg_replace('#<script\b[^>]*>.*?</script>#is', '', (string) $m['html']) : null;
            // Dark mode follows the device. Plain email and simply formatted email are shown dark; an email designed
            // with its own backgrounds stays as its sender drew it (on light), unless it says it has a dark version.
            $designed = $html !== null && preg_match('/bgcolor\s*=|background(?:-color)?\s*:\s*+(?!transparent|none|inherit|initial)/i', $html)
                && !preg_match('/prefers-color-scheme\s*:\s*dark/i', $html);
            $style = '<style>html{color-scheme:light' . ($designed ? '' : ' dark') . '}body{margin:0;padding:16px 20px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d2330;background:#fff;word-wrap:break-word}'
                . 'img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit;margin:0}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #d6dbe4;color:#5b6475}a{color:#2563eb}.q{color:#5b6475}'
                . ($designed ? '' : '@media (prefers-color-scheme:dark){body{color:#e8ecf3;background:#151a22}body *{color:inherit!important;background-color:transparent!important;border-color:#323b4a!important}'
                    . 'a,a *{color:#7aa7ff!important}blockquote,.q{color:#9aa5ba!important}blockquote{border-left-color:#3a4456!important}hr{border-color:#323b4a}}')
                . '</style>';
            // Cloudflare's "email address obfuscation" rewrites addresses in HTML pages into "[email protected]" and
            // needs a script to put them back, which can't run here: these markers tell it to leave the email alone.
            if ($html !== null) {
                echo '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">' . $style . '</head><body><!--email_off-->' . $html . '<!--/email_off-->' . $sizer . '</body></html>';
            } else {
                $text = $esc($m['text']);
                $text = preg_replace('#(https?://[^\s<>"]+)#', '<a href="$1" rel="noopener noreferrer">$1</a>', $text);
                $text = preg_replace('/^(&gt;.*)$/m', '<span class="q">$1</span>', $text);
                echo '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">' . $style . '</head><body><!--email_off--><pre>' . $text . '</pre><!--/email_off-->' . $sizer . '</body></html>';
            }
            exit;
        case 'POST messages/update':
            $in = Http::body();
            Http::json(['updated' => $store->update($user['id'], (array) ($in['ids'] ?? []), array_intersect_key($in, array_flip(['read', 'starred', 'folder'])))]);
        case 'POST messages/delete':
            Http::json(['deleted' => $store->delete($user['id'], (array) (Http::body()['ids'] ?? []))]);
        case 'GET attachment':
            $file = $store->attachment($user['id'], $int('id'));
            $name = preg_replace('/[^\w.\- ]+/u', '_', $file['filename']) ?: 'attachment';
            // Downloaded, never shown in the page: an attachment can't run as part of the webmail.
            header('Content-Type: application/octet-stream');
            header("Content-Disposition: attachment; filename=\"$name\"; filename*=UTF-8''" . rawurlencode($file['filename']));
            header('Content-Length: ' . strlen($file['content']));
            header('Cache-Control: private, no-store');
            header("Content-Security-Policy: default-src 'none'; sandbox");
            echo $file['content'];
            exit;
        case 'POST send':
            $in = Http::body();
            Http::json($store->send($user, (int) ($in['mailbox_id'] ?? 0), $in));
        case 'POST draft':
            $in = Http::body();
            Http::json(['id' => $store->saveDraft($user, (int) ($in['mailbox_id'] ?? 0), $in)]);
        case 'GET contacts':
            // Suggestions while writing: both address books, then people written to before.
            Http::json(['contacts' => (new AddressBook($app))->suggestions($user['id'])]);
        case 'GET book':
            $book = new AddressBook($app);
            Http::json(['personal' => $book->list($user['id']), 'shared' => $book->list(AddressBook::SHARED), 'can_edit_shared' => $user['role'] === 'admin']);
        case 'POST book/save':
            $in = Http::body();
            $owner = AddressBook::owner($user, (string) ($in['book'] ?? 'personal'));
            AddressBook::checkCanEdit($user, $owner);
            Http::json(['id' => (new AddressBook($app))->save($owner, $in, isset($in['id']) ? (int) $in['id'] : null)]);
        case 'POST book/delete':
            $in = Http::body();
            $owner = AddressBook::owner($user, (string) ($in['book'] ?? 'personal'));
            AddressBook::checkCanEdit($user, $owner);
            Http::json(['deleted' => (new AddressBook($app))->delete($owner, (array) ($in['ids'] ?? []))]);
        case 'POST book/import':
            $in = Http::body();
            $owner = AddressBook::owner($user, (string) ($in['book'] ?? 'personal'));
            AddressBook::checkCanEdit($user, $owner);
            Http::json((new AddressBook($app))->import($owner, (string) ($in['text'] ?? ''), (string) ($in['filename'] ?? '')));
        case 'GET book/export':
            $shared = ($_GET['book'] ?? '') === 'shared';
            $vcf = (new AddressBook($app))->exportVcard($shared ? AddressBook::SHARED : $user['id']);
            header('Content-Type: text/vcard; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . ($shared ? 'shared-contacts' : 'my-contacts') . '.vcf"');
            header('Cache-Control: private, no-store');
            header("Content-Security-Policy: default-src 'none'; sandbox");
            echo $vcf;
            exit;
        // Importing email from an old mailbox (IMAP) or a file (.mbox, .eml). The page keeps asking for steps while open.
        case 'GET imports':
            Http::json(['imports' => (new Importer($app))->list($user), 'chunk_bytes' => Importer::CHUNK_BYTES]);
        case 'GET import/local':
            Http::json(['mailboxes' => (new Importer($app))->localMailboxes()]);
        case 'POST import/maildir':
            $in = Http::body();
            Http::json((new Importer($app))->startMaildir($user, (int) ($in['mailbox_id'] ?? 0), (string) ($in['address'] ?? ''), (array) ($in['folders'] ?? [])), 201);
        case 'POST import/probe':
            $in = Http::body();
            Http::json((new Importer($app))->probe($in, !empty($in['oauth']) ? importOAuth($app) : null));
        case 'POST import/imap':
            $in = Http::body();
            $oauth = !empty($in['oauth']) ? importOAuth($app) : null;
            $job = (new Importer($app))->startImap($user, (int) ($in['mailbox_id'] ?? 0), $in, (array) ($in['folders'] ?? []), $oauth);
            unset($_SESSION['import_oauth']); // the import keeps it now (encrypted), until it's forgotten
            Http::json($job, 201);
        // Sign in with Google / Microsoft (GhostParse brokers it): providers, start, then claim the handle it sends back.
        case 'GET import/oauth/providers':
            try {
                Http::json(['providers' => $app->gp->mailOAuthProviders()]);
            } catch (\Webmail\GhostParseError) {
                Http::json(['providers' => []]);
            }
        case 'POST import/oauth/start':
            try {
                Http::json(['url' => $app->gp->mailOAuthStart((string) (Http::body()['provider'] ?? ''), $app->baseUrl() . '/')]);
            } catch (\Webmail\GhostParseError $e) {
                throw new HttpError($e->status === 404 ? 404 : 502, $e->getMessage(), 'oauth');
            }
        case 'POST import/oauth/claim':
            try {
                $claim = $app->gp->mailOAuthClaim((string) (Http::body()['handle'] ?? ''));
            } catch (\Webmail\GhostParseError $e) {
                throw new HttpError(422, $e->getMessage(), 'oauth');
            }
            $settings = Importer::oauthSettings($claim);
            $_SESSION['import_oauth'] = $app->crypto->encryptJson($settings, 'session.import_oauth');
            Http::json(['provider' => $settings['provider'], 'email' => $settings['username']]);
        case 'POST import/file':
            $in = Http::body();
            Http::json((new Importer($app))->startFile($user, (int) ($in['mailbox_id'] ?? 0), (string) ($in['filename'] ?? 'mail.mbox'), (int) ($in['size'] ?? 0), (string) ($in['folder'] ?? 'archive')), 201);
        case 'POST import/chunk':
            // The file's bytes, as the request body (not JSON), in order.
            Http::json((new Importer($app))->appendChunk($user, $int('id'), $int('offset'), (string) file_get_contents('php://input', false, null, 0, Importer::CHUNK_BYTES + 1)));
        case 'POST import/step':
            session_write_close(); // the step takes ~20 seconds: don't hold the session for the rest of the app
            Http::json((new Importer($app))->step($user, (int) (Http::body()['id'] ?? 0)));
        case 'POST import/again':
            Http::json((new Importer($app))->again($user, (int) (Http::body()['id'] ?? 0)));
        case 'POST import/forget':
            Http::json((new Importer($app))->forget($user, (int) (Http::body()['id'] ?? 0)));
        case 'POST import/delete':
            (new Importer($app))->delete($user, (int) (Http::body()['id'] ?? 0));
            Http::json(['ok' => true]);
        case 'GET mailbox/signature':
            // The From name, position, signature and the domain's disclaimer, from GhostParse.
            Http::json((new Signatures($app))->get($store->mailbox($user['id'], $int('id')), $user['role'] === 'admin'));
        case 'POST mailbox/signature':
            $in = Http::body();
            $mailbox = $store->mailbox($user['id'], (int) ($in['id'] ?? 0));
            Http::json((new Signatures($app))->save($mailbox, array_intersect_key($in, array_flip(['display_name', 'position', 'signature', 'disclaimer'])),
                $user['role'] === 'admin'));
        case 'POST mailbox':
            // Before 1.5.0 the settings saved the name and signature here; both are on GhostParse now.
            $in = Http::body();
            $mailbox = $store->mailbox($user['id'], (int) ($in['id'] ?? 0));
            (new Signatures($app))->save($mailbox, array_intersect_key($in, array_flip(['display_name', 'signature'])), false);
            Http::json(['ok' => true]);
        case 'POST password':
            $in = Http::body();
            (new Admin($app))->changePassword($user['id'], (string) ($in['current'] ?? ''), (string) ($in['new'] ?? ''));
            Http::json(['ok' => true]);
    }

    if (str_starts_with($action, 'admin/')) {
        $auth->requireAdmin();
        (new Admin($app))->route($action, $method, $user);
    }
    if (class_exists(\Webmail\Passkeys::class) && str_starts_with($action, 'passkey/')) {
        (new \Webmail\Passkeys($app))->route($action, $method, $user);
    }
    if (class_exists(\Webmail\Notifier::class) && str_starts_with($action, 'push/')) {
        (new \Webmail\Notifier($app))->route($action, $method, $user);
    }
    throw new HttpError(404, 'Unknown action', 'not_found');
} catch (HttpError $e) {
    Http::json(['error' => $e->errorCode, 'message' => $e->getMessage()], $e->status);
} catch (\Throwable $e) {
    error_log('webmail api: ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    Http::json(['error' => 'server_error', 'message' => 'Something went wrong. The details are in the server log.'], 500);
}

/** What a session that has done its password still needs: ['mfa' => 'verify' | 'enrol', …], or nothing. */
/** The mailbox just signed in with Google or Microsoft, waiting in this session to be imported. */
function importOAuth(App $app): array
{
    $s = isset($_SESSION['import_oauth']) ? $app->crypto->decryptJson($_SESSION['import_oauth'], 'session.import_oauth') : null;
    if (!is_array($s)) {
        throw new HttpError(409, 'Sign in with Google or Microsoft again: that sign-in has gone.', 'oauth');
    }
    return $s;
}

function secondStep(Auth $auth, Mfa $mfa): array
{
    $p = $auth->pending();
    if (!$p) {
        return [];
    }
    return ['mfa' => $p['stage'], 'methods' => $p['stage'] === 'verify' ? $mfa->status($p['uid']) : null];
}
