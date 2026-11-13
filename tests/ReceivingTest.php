<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Admin;
use Webmail\Due;
use Webmail\Mailstore;

/** A domain whose receiving is off at GhostParse, or whose MX record sends its email elsewhere: what the webmail does. */
final class ReceivingTest extends TestCase
{
    private bool $receiving = false;
    private bool $mxOk = false;

    protected function setUp(): void
    {
        parent::setUp();
        $this->app->db->run("DELETE FROM {meta} WHERE k IN ('checkin_at', 'receiving_checked')");
        $this->answers['POST /v1/webmail/heartbeat'] = fn () => [200, ['ok' => true]];
        $this->answers['GET /v1/domains'] = fn () => [200, ['domains' => [$this->domain()]]];
        $this->answers['GET /v1/me'] = fn () => [200, ['account' => ['id' => 'acc_1']]];
        $this->answers['PATCH /v1/domains/dom_1/addresses/adr_1'] = fn () => [200, ['ok' => true]];
        $this->answers['PATCH /v1/domains/dom_1'] = function (array $b) {
            $this->receiving = $b['inbound_enabled'] ?? $this->receiving;
            return [200, $this->domain()];
        };
        $this->answers['POST /v1/domains/dom_1/verify'] = fn () => [200, ['domain' => $this->domain(), 'checks' => ['dkim' => ['ok' => true, 'found' => []],
            'mx' => $this->mxOk ? ['ok' => true, 'found' => ['10 mx.ghostparse.test']]
                : ['ok' => false, 'found' => ['5 mail.mejl.test', '10 mx.ghostparse.test'], 'error' => 'Mail goes to mail.mejl.test first']]]];
    }

    private function domain(): array
    {
        return ['id' => 'dom_1', 'name' => 'mejl.test', 'inbound_enabled' => $this->receiving, 'inbound_ready' => $this->receiving && $this->mxOk, 'sending_ready' => true,
            'records' => [['kind' => 'dkim', 'verified' => true], ['kind' => 'mx', 'type' => 'MX', 'host' => 'mejl.test', 'value' => 'mx.ghostparse.test', 'priority' => 10, 'verified' => $this->mxOk]],
            'addresses' => [['id' => 'adr_1', 'address' => 'nope@mejl.test', 'is_pattern' => false, 'can_send' => true, 'can_receive' => true, 'webhook_url' => 'https://mail.example.com/webmail/webhook.php']]];
    }

    private function patches(): array
    {
        return array_values(array_filter($this->requests, fn ($r) => $r['method'] === 'PATCH' && $r['path'] === '/v1/domains/dom_1'));
    }

    public function testAnAddressWithoutSendingAndReceivingFlagsCountsAsBoth(): void
    {
        $this->answers['GET /v1/domains'] = fn () => [200, ['domains' => [['id' => 'dom_1', 'name' => 'mejl.test',
            'addresses' => [['id' => 'adr_1', 'address' => 'hello@mejl.test'], ['id' => 'adr_2', 'address' => 'news@mejl.test', 'can_send' => true, 'can_receive' => false]]]]]];
        $list = (new Admin($this->app))->ghostparseAddresses();
        $this->assertSame([[true, true], [true, false]], array_map(fn ($a) => [$a['can_send'], $a['can_receive']], $list));
    }

    public function testConnectingAnAddressTurnsOnReceivingForItsDomain(): void
    {
        (new Admin($this->app))->connectAddress('nope@mejl.test');
        $this->assertSame([['inbound_enabled' => true]], array_column($this->patches(), 'body'));
        $this->assertTrue($this->receiving);
        // Already on: left alone.
        (new Admin($this->app))->connectAddress('nope@mejl.test');
        $this->assertCount(1, $this->patches());
    }

    public function testOnceForAMailboxConnectedBeforeTheUpdateAndNeverAgainAfterSomeoneTurnsItOff(): void
    {
        (new Mailstore($this->app))->createMailbox('nope@mejl.test'); // as connected by 1.17.0
        $due = new Due($this->app);
        $this->assertTrue($due->pending());
        $due->run();
        $this->assertTrue($this->receiving, 'turned on in the background after the update');
        $this->assertFalse($due->pending(), 'checked once');
        // Turned off at GhostParse on purpose: the webmail doesn't turn it back on.
        $this->receiving = false;
        $admin = new Admin($this->app);
        $this->assertSame([], $admin->ensureReceiving());
        $this->assertFalse($admin->domainSummary([$this->domain()])[0]['receiving']);
        $this->assertCount(1, $this->patches());
    }

    public function testTheAdministratorSeesWhyAndTurnsItOnThenChecksTheMxRecord(): void
    {
        (new Mailstore($this->app))->createMailbox('nope@mejl.test');
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('receiving_auto', '[\"dom_1\"]')"); // already tried once
        $admin = new Admin($this->app);
        $d = $admin->domainSummary($this->app->gp->domains())[0];
        $this->assertSame(['mejl.test', false, false, false, 1], [$d['name'], $d['ready'], $d['receiving'], $d['mx_ok'], $d['mailboxes']]);
        $this->assertSame(['host' => 'mejl.test', 'value' => 'mx.ghostparse.test', 'priority' => 10], $d['mx']);
        $this->assertStringContainsString('receiving is switched off', $admin->status()['problems'][0]);

        $r = $admin->turnOnReceiving('dom_1');
        $this->assertTrue($r['domain']['receiving']);
        $this->assertSame([false, 'Mail goes to mail.mejl.test first'], [$r['mx']['ok'], $r['mx']['error']]);
        $this->assertStringContainsString('its MX record has to point at GhostParse', $admin->status()['problems'][0]);

        $this->mxOk = true;
        $r = $admin->checkDomain('dom_1');
        $this->assertTrue($r['domain']['ready']);
        $this->assertSame([], $admin->status()['problems']);

        $this->expectExceptionMessage("isn't on your GhostParse account");
        $admin->turnOnReceiving('dom_other');
    }

    public function testChecksInWithGhostParseOnceADay(): void
    {
        $this->answers['POST /v1/webmail/heartbeat'] = fn () => [200, ['ok' => true]];
        (new Mailstore($this->app))->createMailbox('nope@mejl.test');
        $due = new Due($this->app);
        $due->run();
        $hb = array_values(array_filter($this->requests, fn ($r) => $r['path'] === '/v1/webmail/heartbeat'));
        $this->assertSame([['version' => \Webmail\App::VERSION, 'url' => 'https://mail.example.com/webmail', 'users' => 0, 'mailboxes' => 1]], array_column($hb, 'body'));
        $this->assertContains('User-Agent: ghostparse-webmail/' . \Webmail\App::VERSION, $hb[0]['headers'], 'which GhostParse recognises it by');
        $this->assertFalse($due->pending(), 'not again today');
        $this->app->db->run("UPDATE {meta} SET v = ? WHERE k = 'checkin_at'", [gmdate('Y-m-d H:i:s', time() - 90000)]);
        $this->assertTrue($due->pending(), 'tomorrow');
    }
}
