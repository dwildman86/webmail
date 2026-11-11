<?php
// A calendar's private feed link (calendar.php?t=…), for seeing it in a phone's or computer's calendar app
// (Apple Calendar, Google Calendar, Outlook: "subscribe" or "add by URL"). Read-only; made and turned off by each
// member under the calendar's settings in the webmail. No sign-in: the link is the key, so it's kept like a password.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\App;
use Webmail\Calendar;
use Webmail\Config;
use Webmail\Schema;

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
if (!Config::installed()) {
    http_response_code(503);
    exit;
}
try {
    $app = App::get();
    Schema::upgrade($app->db);
    (new \Webmail\Waf($app))->guard('feed');
    $cal = new Calendar($app);
    $found = $cal->byFeed((string) ($_GET['t'] ?? ''));
    if (!$found) {
        usleep(random_int(100000, 300000)); // guessing links is slow
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        exit("This calendar link doesn't work any more. Get a new one from the webmail.\n");
    }
    header('Content-Type: text/calendar; charset=utf-8');
    header('Content-Disposition: inline; filename="calendar.ics"');
    echo $cal->ics($found['id'], $found['name']);
} catch (\Throwable $e) {
    error_log('webmail calendar feed: ' . $e->getMessage());
    http_response_code(500);
}
