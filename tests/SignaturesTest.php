<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Signatures;

final class SignaturesTest extends TestCase
{
    private array $domain;

    protected function setUp(): void
    {
        parent::setUp();
        // GhostParse, as far as signatures go: one domain, its address, and edits to them.
        $this->domain = ['id' => 'dom_1', 'name' => 'acme.test', 'disclaimer' => null,
            'addresses' => [['id' => 'adr_1', 'address' => 'support@acme.test', 'display_name' => null, 'position' => null, 'signature' => null]]];
        $this->answers['GET /v1/domains'] = fn () => [200, ['domains' => [$this->domain]]];
        $this->answers['PATCH /v1/domains/dom_1/addresses/adr_1'] = function (array $b) {
            $this->domain['addresses'][0] = array_merge($this->domain['addresses'][0], $b);
            return [200, $this->domain['addresses'][0]];
        };
        $this->answers['PATCH /v1/domains/dom_1'] = function (array $b) {
            $this->domain = array_merge($this->domain, $b);
            return [200, $this->domain];
        };
        $this->answers['POST /v1/emails'] = fn (array $b) => [202, ['id' => 'out_1', 'message_id' => '<out_1@acme.test>', 'thread_id' => 'thr_1', 'accepted' => $b['to'], 'suppressed' => []]];
    }

    private function mailbox(string $signature = ''): array
    {
        $store = new Mailstore($this->app);
        $id = $store->createMailbox('support@acme.test', 'Acme Support', $signature);
        $uid = (new Auth($this->app))->createUser('sam@acme.test', 'Sam Agent', 'correct horse battery', 'user');
        $store->grant($uid, $id);
        return [$store, ['id' => $uid, 'name' => 'Sam Agent'], $store->mailbox($uid, $id)];
    }

    private function emails(): array
    {
        return array_values(array_filter($this->requests, fn ($r) => $r['path'] === '/v1/emails'));
    }

    public function testTheSignatureIsReadFromAndSavedToGhostParse(): void
    {
        [$store, $user, $mb] = $this->mailbox();
        $sig = new Signatures($this->app);
        $this->assertSame(['mailbox_id' => $mb['id'], 'address' => 'support@acme.test', 'display_name' => '', 'position' => '', 'signature' => '',
            'domain' => 'acme.test', 'disclaimer' => '', 'can_edit_disclaimer' => false], $sig->get($mb, false));

        $saved = $sig->save($mb, ['display_name' => ' Acme Support ', 'position' => 'Customer care', 'signature' => "Call 0161 555 0100\r\nacme.test\x07"], false);
        $this->assertSame(['display_name' => 'Acme Support', 'position' => 'Customer care', 'signature' => "Call 0161 555 0100\nacme.test"],
            array_intersect_key($saved, array_flip(['display_name', 'position', 'signature'])), 'tidied, control characters dropped');
        $this->assertSame('Acme Support', $store->mailbox($user['id'], $mb['id'])['display_name'], 'the From name here follows it');

        // Clearing a field sends null, as the API expects.
        $sig->save($mb, ['position' => '  '], false);
        $this->assertNull($this->domain['addresses'][0]['position']);
    }

    public function testOnlyAdministratorsChangeTheDomainsDisclaimer(): void
    {
        [, , $mb] = $this->mailbox();
        $sig = new Signatures($this->app);
        try {
            $sig->save($mb, ['disclaimer' => 'Confidential.'], false);
            $this->fail('not an administrator');
        } catch (HttpError $e) {
            $this->assertSame(403, $e->status);
        }
        $this->assertNull($this->domain['disclaimer']);
        $saved = $sig->save($mb, ['disclaimer' => 'This email is confidential.'], true);
        $this->assertSame(['disclaimer' => 'This email is confidential.', 'can_edit_disclaimer' => true], array_intersect_key($saved, array_flip(['disclaimer', 'can_edit_disclaimer'])));
    }

    public function testGhostParseAddsTheSignatureUnlessTheMessageLeavesItOut(): void
    {
        [$store, $user, $mb] = $this->mailbox();
        $store->send($user, $mb['id'], ['to' => 'jane@customer.example', 'subject' => 'Hi', 'text' => 'Hello']);
        $store->send($user, $mb['id'], ['to' => 'jane@customer.example', 'subject' => 'Hi', 'text' => 'Hello again', 'signature' => false]);
        [$first, $second] = $this->emails();
        $this->assertTrue($first['body']['signature']);
        $this->assertFalse($second['body']['signature']);
        $this->assertSame('Hello', $first['body']['text'], 'nothing added here');
    }

    public function testASignatureFromBefore150MovesToGhostParse(): void
    {
        [$store, $user, $mb] = $this->mailbox("Sam\nAcme Ltd");
        $store->send($user, $mb['id'], ['to' => 'jane@customer.example', 'subject' => 'Hi', 'text' => 'Hello']);
        $this->assertSame("Sam\nAcme Ltd", $this->domain['addresses'][0]['signature'], 'moved to GhostParse');
        $this->assertSame('Acme Support', $this->domain['addresses'][0]['display_name'], 'with the name, as the address had none');
        $this->assertSame('', $store->mailbox($user['id'], $mb['id'])['signature'], 'and not kept here');
        $email = $this->emails()[0]['body'];
        $this->assertTrue($email['signature']);
        $this->assertSame('Hello', $email['text']);

        // An address that already has a signature on GhostParse keeps it.
        $this->domain['addresses'][0]['signature'] = 'Set in the dashboard';
        $store->updateMailbox($mb['id'], ['signature' => 'Old webmail one']);
        (new Signatures($this->app))->get($store->mailbox($user['id'], $mb['id']), false);
        $this->assertSame('Set in the dashboard', $this->domain['addresses'][0]['signature']);
        $this->assertSame('', $store->mailbox($user['id'], $mb['id'])['signature']);
    }

    public function testIfGhostParseCantTakeTheOldSignatureItsAddedHereAsBefore(): void
    {
        [$store, $user, $mb] = $this->mailbox('Sam at Acme');
        $this->answers['PATCH /v1/domains/dom_1/addresses/adr_1'] = fn () => [503, ['error' => 'unavailable', 'message' => 'Try again']];
        $store->send($user, $mb['id'], ['to' => 'jane@customer.example', 'subject' => 'Hi', 'text' => 'Hello', 'html' => '<p>Hello</p>']);
        $email = $this->emails()[0]['body'];
        $this->assertFalse($email['signature']);
        $this->assertSame("Hello\n\n-- \nSam at Acme", $email['text']);
        $this->assertStringEndsWith('<div class="signature">-- <br>Sam at Acme</div>', $email['html']);
        $this->assertSame('Sam at Acme', $store->mailbox($user['id'], $mb['id'])['signature'], 'kept for next time');
    }
}
