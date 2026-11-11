<?php
// Sends scheduled email, brings back snoozed email and sends calendar reminders when they're due. The webmail does this by itself while it's being
// used and when email arrives; where the hosting has cron, calling this every minute makes it happen on time even when
// nobody has the webmail open:
//
//   * * * * * curl -fsS https://your-site/webmail/due.php >/dev/null
//
// It only does what's already due, so it's safe for anyone to call.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\App;
use Webmail\Config;
use Webmail\Due;
use Webmail\Schema;

header('Content-Type: application/json');
header('Cache-Control: no-store');
if (!Config::installed()) {
    http_response_code(503);
    exit('{"error":"not_installed"}');
}
try {
    $app = App::get();
    Schema::upgrade($app->db);
    $r = (new Due($app))->run(25);
    echo json_encode($r === null ? ['ok' => true, 'busy' => true] : ['ok' => true] + $r);
} catch (\Throwable $e) {
    error_log('webmail due: ' . $e->getMessage());
    http_response_code(500);
    echo '{"error":"server_error"}';
}
