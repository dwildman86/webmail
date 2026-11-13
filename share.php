<?php
// A Files share link (share.php?t=…): view and download a shared file or folder, or send files into a folder (a file
// request). No sign-in: the link is the key, with a password if its owner set one. Off unless an administrator turned
// share links on (Settings → Files). Checked by the firewall; wrong passwords count towards blocking an address.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\App;
use Webmail\Config;
use Webmail\FileLinks;
use Webmail\Files;
use Webmail\Http;
use Webmail\HttpError;
use Webmail\Schema;
use Webmail\Waf;

Http::securityHeaders();
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
if (!Config::installed()) {
    http_response_code(503);
    exit;
}
$e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
$token = (string) ($_GET['t'] ?? '');
$action = (string) ($_GET['a'] ?? '');
$appName = (string) Config::load()->get('app_name', 'Webmail');

/** The page around everything shown here. */
$page = function (string $title, string $body, int $status = 200) use ($e, $appName): never {
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    $v = App::VERSION;
    echo "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        . "<meta name=\"robots\" content=\"noindex, nofollow\"><meta name=\"referrer\" content=\"no-referrer\"><title>{$e($title)} · {$e($appName)}</title>"
        . "<link rel=\"icon\" href=\"assets/icons/icon.svg\" type=\"image/svg+xml\"><link rel=\"stylesheet\" href=\"assets/app.css?v=$v\"><link rel=\"stylesheet\" href=\"assets/share.css?v=$v\">"
        . "<script src=\"assets/share.js?v=$v\" defer></script></head><body class=\"share-page\"><main class=\"share-card\">"
        . "<p class=\"share-brand\">{$e($appName)}</p>$body</main></body></html>";
    exit;
};
$json = function (array $data, int $status = 200): never {
    Http::json($data, $status);
};
$api = str_starts_with($action, 'upload');

try {
    $app = App::get();
    Schema::upgrade($app->db);
    $waf = new Waf($app);
    $waf->guard('share');
    $links = new FileLinks($app);
    $files = new Files($app);
    [$link, $node] = $links->resolve($token);
    $self = 'share.php?t=' . rawurlencode($token);

    // The password, when there is one.
    if ($action === 'unlock' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
        if ($links->unlock($link, (string) ($_POST['password'] ?? ''))) {
            header("Location: $self", true, 303);
            exit;
        }
        $waf->penalise(Http::ip(), 'failed_link_password', 2, $waf->request('share'), 'Wrong share link password');
        $wrong = true;
    }
    if (!$links->unlocked($link)) {
        if ($api) {
            $json(['message' => 'This link needs its password.'], 401);
        }
        $page('Password needed', '<h1>This link has a password</h1><p class="muted">Ask whoever sent it, if you don\'t have it.</p>'
            . (!empty($wrong) ? '<p class="notice bad">That isn\'t the password.</p>' : '')
            . "<form method=\"post\" action=\"{$e($self)}&amp;a=unlock\" class=\"share-form\"><label class=\"field\">Password<input type=\"password\" name=\"password\" required autofocus autocomplete=\"off\"></label>"
            . '<button class="btn btn-primary">Open</button></form>', 401);
    }

    // A file request: files sent in, in pieces (like the webmail's own uploads).
    if ($link['kind'] === 'request') {
        if ($action === 'upload/start') {
            $in = Http::body();
            $r = $files->startUpload(null, null, (string) ($in['name'] ?? ''), (int) ($in['size'] ?? -1), null, false, $link);
            $links->touched($link);
            $json(array_intersect_key($r, ['upload' => 1, 'piece' => 1, 'received' => 1, 'done' => 1]));
        }
        if ($action === 'upload/piece') {
            $r = $files->appendUpload(null, (string) ($_GET['u'] ?? ''), (int) ($_GET['offset'] ?? -1),
                (string) file_get_contents('php://input', false, null, 0, Files::UPLOAD_PIECE + 1), $link);
            $json(['received' => $r['received'], 'done' => $r['done']]);
        }
        $folder = $files->name($node);
        $page("Send files to $folder", "<h1>Send files</h1><p class=\"muted\">They'll go to the folder <strong>{$e($folder)}</strong>. You can't see what's in it, or what others have sent.</p>"
            . "<div id=\"share-upload\" data-start=\"{$e($self)}&amp;a=upload/start\" data-piece=\"{$e($self)}&amp;a=upload/piece\" data-max=\"" . ($files->settings()['max_file_mb'] * 1024 * 1024) . '">'
            . '<label class="drop"><input type="file" multiple id="share-files"><span>Choose files, or drop them here</span></label><ul class="share-progress" id="share-progress"></ul></div>');
    }

    // Viewing and downloading.
    if ($action === 'download') {
        $target = $links->within($link, (int) ($_GET['id'] ?? $node['id']));
        if ($target['kind'] !== 'file') {
            throw new HttpError(422, "That's a folder.", 'not_file');
        }
        $inline = !empty($_GET['inline']);
        $range = $_SERVER['HTTP_RANGE'] ?? null;
        // A download counts once, not for each piece of a video or preview.
        if (!$inline && (!$range || str_starts_with((string) $range, 'bytes=0-'))) {
            $links->counted($link);
            $files->log('link_download', (int) $target['id'], null, [], $link);
        }
        $files->send($target, $files->currentVersion($target), $inline, $range);
    }

    $show = $node;
    if ($node['kind'] === 'folder' && !empty($_GET['id'])) {
        $show = $links->within($link, (int) $_GET['id']);
    }
    $links->touched($link);
    $fileRow = function (array $n) use ($e, $self, $files): string {
        $name = $files->name($n);
        if ($n['kind'] === 'folder') {
            return "<li class=\"share-item\"><a href=\"{$e($self)}&amp;id={$n['id']}\">📁 {$e($name)}</a></li>";
        }
        return "<li class=\"share-item\"><span>{$e($name)} <small class=\"muted\">" . Files::human((int) $n['size']) . "</small></span>"
            . "<a class=\"btn btn-sm\" href=\"{$e($self)}&amp;a=download&amp;id={$n['id']}\">Download</a></li>";
    };
    $expiry = $link['expires_at'] ? '<p class="muted small">This link works until ' . $e(gmdate('j M Y', strtotime($link['expires_at'] . ' UTC'))) . '.</p>' : '';
    if ($show['kind'] === 'file') {
        $name = $files->name($show);
        $src = "$self&a=download&id={$show['id']}&inline=1";
        $mime = $show['mime'];
        $preview = match (true) {
            str_starts_with($mime, 'image/') && in_array($mime, Files::INLINE, true) => "<img class=\"share-preview\" src=\"{$e($src)}\" alt=\"{$e($name)}\">",
            $mime === 'application/pdf' => "<iframe class=\"share-preview pdf\" src=\"{$e($src)}\" title=\"{$e($name)}\"></iframe>",
            str_starts_with($mime, 'video/') && in_array($mime, Files::INLINE, true) => "<video class=\"share-preview\" src=\"{$e($src)}\" controls preload=\"metadata\"></video>",
            str_starts_with($mime, 'audio/') && in_array($mime, Files::INLINE, true) => "<audio src=\"{$e($src)}\" controls preload=\"metadata\"></audio>",
            default => '',
        };
        $page($name, "<h1 class=\"share-name\">{$e($name)}</h1><p class=\"muted\">" . Files::human((int) $show['size']) . '</p>' . $preview
            . "<p><a class=\"btn btn-primary\" href=\"{$e($self)}&amp;a=download&amp;id={$show['id']}\">Download</a></p>$expiry");
    }
    $children = $app->db->all('SELECT * FROM {file_nodes} WHERE parent_id = ? AND trashed_at IS NULL', [$show['id']]);
    usort($children, fn ($a, $b) => [$a['kind'] === 'folder' ? 0 : 1, mb_strtolower($files->name($a))] <=> [$b['kind'] === 'folder' ? 0 : 1, mb_strtolower($files->name($b))]);
    $up = (int) $show['id'] !== (int) $node['id'] ? "<p><a href=\"{$e($self)}" . ((int) $show['parent_id'] !== (int) $node['id'] ? "&amp;id={$show['parent_id']}" : '') . '">← Back</a></p>' : '';
    $page($files->name($show), "<h1 class=\"share-name\">📁 {$e($files->name($show))}</h1>$up"
        . ($children ? '<ul class="share-list">' . implode('', array_map($fileRow, $children)) . '</ul>' : '<p class="muted">This folder is empty.</p>') . $expiry);
} catch (HttpError $ex) {
    if ($api) {
        $json(['message' => $ex->getMessage(), 'error' => $ex->errorCode], $ex->status);
    }
    $page('Link not available', '<h1>Sorry</h1><p>' . $e($ex->getMessage()) . '</p>', $ex->status >= 400 && $ex->status < 600 ? $ex->status : 400);
} catch (\Throwable $ex) {
    error_log('webmail share link: ' . $ex->getMessage());
    if ($api) {
        $json(['message' => 'Something went wrong.'], 500);
    }
    $page('Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a moment.</p>', 500);
}
