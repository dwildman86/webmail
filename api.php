<?php
// The JSON API the interface uses: api.php?a=<action>. Signed-in actions need the session cookie, and changes the
// CSRF token in X-CSRF-Token.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\Admin;
use Webmail\App;
use Webmail\Auth;
use Webmail\Config;
use Webmail\Http;
use Webmail\HttpError;
use Webmail\Mailstore;

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

    // Before sign-in.
    if ($action === 'login' && $method === 'POST') {
        $in = Http::body();
        $auth->login((string) ($in['email'] ?? ''), (string) ($in['password'] ?? ''), Http::ip());
        Http::json(['ok' => true, 'csrf' => Auth::csrfToken()]);
    }
    if ($action === 'session') {
        \Webmail\Schema::upgrade($app->db); // after uploading a new version
        $user = $auth->user();
        if (!$user) {
            Http::json(['user' => null, 'app' => ['name' => $app->config->get('app_name', 'Webmail'), 'passkeys' => (int) $app->db->value('SELECT COUNT(*) FROM {passkeys}') > 0]], 401);
        }
        Http::json(['user' => $user, 'csrf' => Auth::csrfToken(), 'mailboxes' => $store->mailboxesFor($user['id']),
            'app' => ['name' => $app->config->get('app_name', 'Webmail'), 'version' => App::VERSION, 'vapid_public_key' => \Webmail\Notifier::supported() ? (new \Webmail\Notifier($app))->vapid()['public'] : null]]);
    }
    if (class_exists(\Webmail\Passkeys::class) && str_starts_with($action, 'passkey/login')) {
        (new \Webmail\Passkeys($app))->route($action, $method, null);
    }

    $user = $auth->requireUser();
    if ($method !== 'GET') {
        Auth::checkCsrf();
    }

    switch ("$method $action") {
        case 'POST logout':
            $auth->logout();
            Http::json(['ok' => true]);
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
            $style = '<style>html{color-scheme:light}body{margin:0;padding:16px 20px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d2330;background:#fff;word-wrap:break-word}'
                . 'img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit;margin:0}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #d6dbe4;color:#5b6475}a{color:#2563eb}</style>';
            if ($m['html']) {
                $html = preg_replace('#<script\b[^>]*>.*?</script>#is', '', (string) $m['html']);
                echo '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">' . $style . '</head><body>' . $html . $sizer . '</body></html>';
            } else {
                $text = $esc($m['text']);
                $text = preg_replace('#(https?://[^\s<>"]+)#', '<a href="$1" rel="noopener noreferrer">$1</a>', $text);
                $text = preg_replace('/^(&gt;.*)$/m', '<span style="color:#5b6475">$1</span>', $text);
                echo '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">' . $style . '</head><body><pre>' . $text . '</pre>' . $sizer . '</body></html>';
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
            Http::json(['contacts' => $store->contacts($user['id'])]);
        case 'POST mailbox':
            $in = Http::body();
            $id = (int) ($in['id'] ?? 0);
            if (!in_array($id, array_column($store->mailboxesFor($user['id']), 'id'), true)) {
                throw new HttpError(404, 'Mailbox not found', 'not_found');
            }
            $store->updateMailbox($id, array_intersect_key($in, array_flip(['display_name', 'signature'])));
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
