<?php
// A video meeting (meet.php?r=…): the page, and the little API its browsers use to find each other (Meet). Sound
// and video go directly between the people in it; nothing of the meeting reaches this server. People signed in here
// join straight away; anyone else with the link gives their name and waits until someone lets them in.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\App;
use Webmail\Auth;
use Webmail\Config;
use Webmail\Http;
use Webmail\HttpError;
use Webmail\Meet;
use Webmail\Schema;
use Webmail\Waf;

Http::securityHeaders();
// This page, and only this page, may use the camera, microphone and screen sharing (when the person allows it).
header('Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=()');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
if (!Config::installed()) {
    http_response_code(503);
    exit;
}
$e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
$token = (string) ($_GET['r'] ?? '');
$action = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$appName = (string) Config::load()->get('app_name', 'Webmail');
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');

$page = function (string $title, string $body, int $status = 200, array $data = []) use ($e, $appName): never {
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    $v = App::VERSION;
    $attrs = '';
    foreach ($data as $k => $val) {
        $attrs .= ' data-' . $k . '="' . $e((string) $val) . '"';
    }
    echo "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
        . "<meta name=\"robots\" content=\"noindex, nofollow\"><meta name=\"referrer\" content=\"no-referrer\"><meta name=\"color-scheme\" content=\"dark\"><title>{$e($title)} · {$e($appName)}</title>"
        . "<link rel=\"icon\" href=\"assets/icons/icon.svg\" type=\"image/svg+xml\"><link rel=\"stylesheet\" href=\"assets/app.css?v=$v\"><link rel=\"stylesheet\" href=\"assets/meet.css?v=$v\">"
        . ($data ? "<script src=\"assets/meet.js?v=$v\" defer></script>" : '') . "</head><body class=\"meet-page\"$attrs>$body</body></html>";
    exit;
};
$notFound = fn (string $message, int $status) => $page('Meeting', '<main class="meet-card"><p class="meet-brand">' . $e($appName) . '</p><h1>Can\'t join this meeting</h1><p class="muted">'
    . $e($message) . '</p></main>', $status);

try {
    $app = App::get();
    Schema::upgrade($app->db);
    $meet = new Meet($app);
    $secret = (string) ($_SERVER['HTTP_X_MEET_PEER'] ?? '');
    $peerAction = in_array($action, ['poll', 'signal', 'state', 'admit', 'remove', 'lock', 'leave'], true);
    // The firewall looks at the page and at joining. Everything after is asked every second or two by someone already
    // in (their 256-bit key in X-Meet-Peer), which the firewall's request counting would otherwise take for an attack.
    if (!$peerAction) {
        (new Waf($app))->guard('meet');
    }
    Auth::startSession($base, $app);
    try {
        $user = (new Auth($app))->user();
    } catch (HttpError) {
        $user = null;
    }
    session_write_close(); // asked often: the session isn't held while the meeting is

    if ($action === '') {
        if ($method !== 'GET') {
            throw new HttpError(405, 'Not allowed', 'method');
        }
        $room = $meet->room($token);
        $info = $meet->describe($room, $user);
        $page($room['title'], '<noscript><main class="meet-card"><h1>' . $e($room['title']) . '</h1><p>Meetings need JavaScript turned on.</p></main></noscript><div id="meet"></div>', 200, [
            'room' => $token, 'title' => $room['title'], 'app' => $appName, 'max' => $info['max'], 'guests' => $info['guests'] ? '1' : '0', 'recording' => $info['recording'] ? '1' : '0', 'host' => $info['host'] ? '1' : '0',
            'member' => $user ? ($user['name'] !== '' ? $user['name'] : $user['email']) : '', 'csrf' => $user ? Auth::csrfToken() : '', 'webmail' => $base . '/',
        ]);
    }
    if ($method !== 'POST') {
        throw new HttpError(405, 'Not allowed', 'method');
    }
    $in = $action === 'leave' && str_starts_with((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'text/plain')
        ? (json_decode((string) file_get_contents('php://input', false, null, 0, 4096), true) ?: []) : Http::body();
    $room = $meet->room($token);
    if ($action === 'join') {
        if ($user) {
            Auth::checkCsrf();
        }
        $joined = $meet->join($room, $user, (string) ($in['name'] ?? ''));
        Http::json($joined + ['ice_servers' => $joined['status'] === 'in' || $user ? $meet->iceServers() : [], 'host' => $meet->describe($room, $user)['host']], 201);
    }
    if ($action === 'ice') {
        // A guest let in from the lobby: the networks to connect through (only for someone in the meeting).
        $peer = $meet->peer($room, $secret);
        if ($peer['status'] !== 'in') {
            throw new HttpError(403, 'You\'re not in the meeting yet.', 'not_in');
        }
        Http::json(['ice_servers' => $meet->iceServers()]);
    }
    if (!$peerAction) {
        throw new HttpError(404, 'Unknown action', 'not_found');
    }
    // sendBeacon (leaving as the tab closes) can't set headers: the key comes in the body then.
    $peer = $meet->peer($room, $secret !== '' ? $secret : (string) ($in['peer'] ?? ''));
    $peerUser = $peer['user_id'] !== null && $user && (int) $peer['user_id'] === $user['id'] ? $user : null;
    switch ($action) {
        case 'poll':
            Http::json($meet->poll($room, $peer, (int) ($in['after'] ?? 0)));
        case 'signal':
            Http::json(['sent' => $meet->signal($room, $peer, is_array($in['messages'] ?? null) ? $in['messages'] : [])]);
        case 'state':
            Http::json(['state' => $meet->setState($peer, is_array($in['state'] ?? null) ? $in['state'] : [])]);
        case 'admit':
            $meet->admit($room, $peer, (int) ($in['peer_id'] ?? 0), !empty($in['allow']));
            Http::json(['ok' => true]);
        case 'remove':
            $meet->remove($room, $peer, $peerUser, (int) ($in['peer_id'] ?? 0));
            Http::json(['ok' => true]);
        case 'lock':
            $meet->lock($room, $peer, $peerUser, !empty($in['locked']));
            Http::json(['ok' => true]);
        case 'leave':
            $meet->leave($peer);
            Http::json(['ok' => true]);
    }
} catch (HttpError $err) {
    if ($action === '') {
        $notFound($err->getMessage(), $err->status);
    }
    Http::json(['error' => $err->errorCode, 'message' => $err->getMessage()], $err->status);
} catch (\Throwable $err) {
    error_log('webmail meet: ' . $err->getMessage());
    if ($action === '') {
        $notFound('Something went wrong on the server. Try again in a minute.', 500);
    }
    Http::json(['error' => 'server_error', 'message' => 'Something went wrong. Try again.'], 500);
}
