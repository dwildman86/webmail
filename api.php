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
        $user = $auth->user();
        if (!$user) {
            Http::json(['user' => null, 'app' => ['name' => $app->config->get('app_name', 'Webmail')]], 401);
        }
        Http::json(['user' => $user, 'csrf' => Auth::csrfToken(), 'mailboxes' => $store->mailboxesFor($user['id']),
            'app' => ['name' => $app->config->get('app_name', 'Webmail'), 'version' => App::VERSION, 'vapid_public_key' => $app->config->get('vapid')['public'] ?? null]]);
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
