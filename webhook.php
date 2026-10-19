<?php
// GhostParse delivers incoming email here. Set this file's URL as the webhook of each address the webmail receives
// for (the installer does it for you).
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\App;
use Webmail\Config;
use Webmail\Inbound;
use Webmail\Notifier;

header('Content-Type: application/json');
header('Cache-Control: no-store');
if (!Config::installed()) {
    http_response_code(503);
    exit('{"error":"not_installed"}');
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('{"error":"method_not_allowed"}');
}
try {
    $app = App::get();
    $inbound = new Inbound($app);
    if (class_exists(Notifier::class)) {
        $inbound->onNewMail[] = [new Notifier($app), 'newMail'];
    }
    $multipart = str_starts_with(strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? '')), 'multipart/form-data');
    $files = [];
    foreach ($_FILES as $name => $f) {
        if (($f['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK) {
            $files[$name] = $f['tmp_name'];
        }
    }
    [$status, $out] = $inbound->handle($multipart ? (string) ($_POST['event'] ?? '') : (string) file_get_contents('php://input'), Inbound::requestHeaders(), $files);
} catch (\Throwable $e) {
    // 500: GhostParse retries, then the sender's server tries again later, so the email isn't lost.
    error_log('webmail webhook: ' . $e->getMessage());
    [$status, $out] = [500, ['error' => 'server_error']];
}
http_response_code($status);
echo json_encode($out);
