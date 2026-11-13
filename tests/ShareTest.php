<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Due;
use Webmail\Waf;

/** The firewall's hourly summary of attacks for GhostParse: what's in it, what isn't, and switching it off. */
final class ShareTest extends TestCase
{
    private array $sent = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->app->db->run("DELETE FROM {meta} WHERE k = 'threat_share'");
        $this->answers['POST /v1/webmail/threats'] = function (array $b) {
            $this->sent[] = $b['reports'];
            return [200, ['ok' => true, 'kept' => count($b['reports'])]];
        };
    }

    private function attack(string $ip, string $rule, int $times = 1): void
    {
        $req = ['method' => 'POST', 'endpoint' => 'api', 'action' => 'login', 'headers' => ['user-agent' => 'curl/8'], 'query' => [], 'body' => []];
        for ($i = 0; $i < $times; $i++) {
            (new Waf($this->app))->penalise($ip, $rule, 1, $req, 'secret detail with someone@example.com', 'blocked');
        }
    }

    public function testASummaryOfAttacksGoesHourlyWithNothingFromTheRequests(): void
    {
        $this->attack('45.13.22.9', 'failed_invalid_login', 3);
        $this->attack('45.13.22.9', 'sqli');
        $this->attack('10.0.0.5', 'sqli');            // private: not sent
        $this->attack('185.220.101.4', 'deny_list');  // the administrators' own list: not sent
        $this->attack('185.220.101.4', 'failed_csrf'); // an expired form: not sent
        $due = new Due($this->app);
        $this->assertTrue($due->pending());
        $due->run();

        $this->assertCount(1, $this->sent);
        $by = array_column($this->sent[0], null, 'kind');
        $this->assertSame(['failed_invalid_login', 'sqli'], array_keys($by));
        $this->assertSame(['45.13.22.9', 3, 'blocked'], [$by['failed_invalid_login']['ip'], $by['failed_invalid_login']['count'], $by['failed_invalid_login']['action']]);
        $this->assertSame(['ip', 'kind', 'action', 'count', 'first_at', 'last_at'], array_keys($by['sqli']));
        $this->assertStringNotContainsString('example.com', json_encode($this->sent), 'nothing from the requests');

        // Not again within the hour, and only new events after it.
        $this->assertFalse($due->pending());
        $this->app->db->run("UPDATE {meta} SET v = JSON_SET(v, '$.at', ?) WHERE k = 'threat_share'", [time() - 3700]);
        $this->assertFalse($due->pending(), 'nothing new to send');
        $this->attack('45.13.22.9', 'path_probe');
        $due->run();
        $this->assertSame([['path_probe', 1]], array_map(fn ($r) => [$r['kind'], $r['count']], $this->sent[1]));
        $this->assertNotNull((new Waf($this->app))->status()['shared_at']);
    }

    public function testSwitchedOffNothingIsSent(): void
    {
        (new Waf($this->app))->save(['share' => false], '192.0.2.1');
        $this->assertFalse((new Waf($this->app))->settings()['share']);
        $this->attack('45.13.22.9', 'sqli');
        (new Due($this->app))->run();
        $this->assertSame([], $this->sent);
    }

    public function testGhostParseUnreachableTheSameEventsGoNextTime(): void
    {
        $this->answers['POST /v1/webmail/threats'] = fn () => [503, ['error' => 'unavailable']];
        $this->attack('45.13.22.9', 'sqli', 2);
        (new Due($this->app))->run();
        $this->answers['POST /v1/webmail/threats'] = function (array $b) {
            $this->sent[] = $b['reports'];
            return [200, ['ok' => true]];
        };
        $this->app->db->run("UPDATE {meta} SET v = JSON_SET(v, '$.at', ?) WHERE k = 'threat_share'", [time() - 3700]);
        (new Due($this->app))->run();
        $this->assertSame(2, $this->sent[0][0]['count']);
    }
}
