<?php
// Locked out by the sign-in rules (the office's address changed, or the only passkey was lost)? On the server, in the
// webmail's folder:
//
//   php security-reset.php              turns off trusted networks and passkeys only (Settings → Security), and
//                                       clears the firewall's blocks and block list (Settings → Firewall)
//   php security-reset.php --user=you@example.com   also clears that person's own trusted networks
//
// Then sign in as usual and set them again. Only from the command line: on the web it doesn't exist.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require __DIR__ . '/app/bootstrap.php';

use Webmail\App;
use Webmail\Auth;
use Webmail\Config;

if (!Config::installed()) {
    fwrite(STDERR, "The webmail isn't installed here.\n");
    exit(1);
}
$app = App::get();
\Webmail\Schema::upgrade($app->db);
$app->db->run("DELETE FROM {meta} WHERE k = 'security_policy'");
echo "Trusted networks and passkeys only are off.\n";
$app->db->run('UPDATE {waf_ips} SET blocked_until = NULL, score = 0, blocks = 0');
$waf = json_decode((string) $app->db->value("SELECT v FROM {meta} WHERE k = 'waf'"), true) ?: [];
$waf['deny'] = [];
$app->db->run("REPLACE INTO {meta} (k, v) VALUES ('waf', ?)", [json_encode($waf)]);
echo "The firewall's blocks and block list are cleared (it's still on: Settings → Firewall).\n";
// Files: every share link off (new ones can be made once things are safe).
$links = (new \Webmail\FileLinks($app))->revokeEverything();
echo $links ? "$links Files share link(s) turned off.\n" : "No Files share links were on.\n";
$opts = getopt('', ['user:']);
if (!empty($opts['user'])) {
    $n = $app->db->run('UPDATE {users} SET allowed_ips_enc = NULL WHERE email_bidx = ?', [(new Auth($app))->emailIndex((string) $opts['user'])])->rowCount();
    echo $n ? "{$opts['user']} can sign in from anywhere again.\n" : "No change for {$opts['user']} (no such user, or no networks of their own).\n";
}
