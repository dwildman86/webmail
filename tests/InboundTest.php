<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Admin;
use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Inbound;
use Webmail\Mailstore;

final class InboundTest extends TestCase
{
    private function signed(array $event, ?int $ts = null): array
    {
        $body = json_encode($event);
        $ts ??= time();
        $key = base64_decode(substr($this->config['ghostparse']['webhook_secret'], 6));
        $sig = 'v1,' . base64_encode(hash_hmac('sha256', "{$event['id']}.$ts.$body", $key, true));
        return [$body, ['webhook-id' => $event['id'], 'webhook-timestamp' => (string) $ts, 'webhook-signature' => $sig, 'content-type' => 'application/json']];
    }

    public function testStoresSignedEmailOnceAndRefusesForgeries(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $store->grant($uid, $mb);
        $inbound = new Inbound($this->app);
        $notified = [];
        $inbound->onNewMail[] = function (array $stored, array $data) use (&$notified) {
            $notified[] = [$stored, $data['subject']];
        };
        $event = ['id' => 'evt_1', 'type' => 'email.received', 'data' => $this->inbound()];
        [$body, $headers] = $this->signed($event);

        $this->assertSame([200, ['ok' => true, 'stored' => 1]], $inbound->handle($body, $headers));
        $this->assertSame([200, ['ok' => true, 'duplicate' => true]], $inbound->handle($body, $headers), 'a retried event is taken once');
        $this->assertCount(1, $notified);
        $this->assertSame('Where is my order #1042?', $notified[0][1]);
        $this->assertCount(1, $store->list($uid, $mb, 'inbox')['messages']);

        $this->assertSame(400, $inbound->handle(str_replace('1042', '9999', $body), $headers)[0], 'changed body');
        $this->assertSame(400, $inbound->handle($body, ['webhook-id' => 'evt_1'])[0], 'unsigned');
        [$oldBody, $oldHeaders] = $this->signed(['id' => 'evt_old'] + $event, time() - 3600);
        $this->assertSame(400, $inbound->handle($oldBody, $oldHeaders)[0], 'replayed an hour later');
        [$test, $testHeaders] = $this->signed(['id' => 'evt_t', 'type' => 'webhook.test', 'data' => []]);
        $this->assertSame(200, $inbound->handle($test, $testHeaders)[0]);
        $this->assertCount(1, $store->list($uid, $mb, 'inbox')['messages']);
    }

    public function testMultipartAttachmentsAreCheckedAgainstTheSignedEvent(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $store->grant($uid, $mb);
        $file = tempnam(sys_get_temp_dir(), 'wm');
        file_put_contents($file, 'INVOICE-BYTES');
        $data = $this->inbound(['attachments' => [['filename' => 'invoice.pdf', 'content_type' => 'application/pdf', 'size' => 13, 'content' => null,
            'part' => 'attachment_0', 'sha256' => hash('sha256', 'INVOICE-BYTES')]]]);
        [$body, $headers] = $this->signed(['id' => 'evt_m', 'type' => 'email.received', 'data' => $data]);
        $inbound = new Inbound($this->app);

        $tampered = tempnam(sys_get_temp_dir(), 'wm');
        file_put_contents($tampered, 'SOMETHING-ELSE');
        $this->assertSame(400, $inbound->handle($body, $headers, ['attachment_0' => $tampered])[0]);
        $this->assertSame(200, $inbound->handle($body, $headers, ['attachment_0' => $file])[0]);
        $msg = $store->get($uid, $store->list($uid, $mb, 'inbox')['messages'][0]['id'])['message'];
        $this->assertSame('INVOICE-BYTES', $store->attachment($uid, $msg['attachments'][0]['id'])['content']);
    }

    public function testConnectingAGhostParseAddressPointsItsWebhookHere(): void
    {
        $this->answers['GET /v1/domains'] = fn () => [200, ['domains' => [[
            'id' => 'dom_1', 'name' => 'acme.test', 'inbound_ready' => true, 'sending_ready' => true,
            'addresses' => [
                ['id' => 'adr_1', 'address' => 'support@acme.test', 'is_pattern' => false, 'can_send' => false, 'can_receive' => true, 'webhook_url' => null],
                ['id' => 'adr_2', 'address' => 'ticket-*@acme.test', 'is_pattern' => true, 'can_send' => false, 'can_receive' => true],
            ],
        ]]]];
        $this->answers['PATCH /v1/domains/dom_1/addresses/adr_1'] = fn (array $b) => [200, ['ok' => true]];
        $admin = new Admin($this->app);
        $this->assertSame(['support@acme.test'], array_column($admin->ghostparseAddresses(), 'address'), 'patterns aren\'t mailboxes');

        $id = $admin->connectAddress('Support@Acme.test', 'Acme Support');
        $patch = end($this->requests);
        $this->assertSame('/v1/domains/dom_1/addresses/adr_1', $patch['path']);
        $this->assertSame(['can_send' => true, 'can_receive' => true, 'webhook_url' => 'https://mail.example.com/webmail/webhook.php'], $patch['body']);
        $this->assertSame($id, $admin->connectAddress('support@acme.test'), 'connecting again keeps the same mailbox');
        $this->assertTrue($admin->ghostparseAddresses()[0]['connected']);

        $this->expectException(HttpError::class);
        $this->expectExceptionMessage("isn't an address on your GhostParse account");
        $admin->connectAddress('sales@acme.test');
    }
}
