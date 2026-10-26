<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\Crypto;
use Webmail\GhostParse;
use Webmail\HttpError;
use Webmail\Mailstore;

final class CoreTest extends TestCase
{
    public function testEncryptionIsBoundToItsColumnAndKey(): void
    {
        $c = $this->app->crypto;
        $box = $c->encrypt('Where is my order?', 'messages.subject');
        $this->assertStringStartsWith('x1.', $box);
        $this->assertNotSame($box, $c->encrypt('Where is my order?', 'messages.subject'), 'a fresh nonce each time');
        $this->assertSame('Where is my order?', $c->decrypt($box, 'messages.subject'));
        try {
            $c->decrypt($box, 'messages.snippet');
            $this->fail('moved to another column');
        } catch (\RuntimeException) {
        }
        $other = new Crypto(Crypto::newKey());
        $this->expectException(\RuntimeException::class);
        $other->decrypt($box, 'messages.subject');
    }

    public function testNothingPersonalIsStoredInTheClear(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test', 'Acme Support', 'The Acme team');
        $store->storeInbound($this->inbound(['attachments' => [['filename' => 'receipt.pdf', 'content_type' => 'application/pdf', 'size' => 12, 'content' => base64_encode('PDF secret 1')]]]));
        (new Auth($this->app))->createUser('owner@acme.test', 'Olivia Owner', 'correct horse battery', 'admin');
        $dump = '';
        foreach (['users', 'mailboxes', 'messages', 'attachments', 'search'] as $t) {
            foreach ($this->app->db->all("SELECT * FROM {{$t}}") as $row) {
                $dump .= json_encode(array_map(fn ($v) => is_string($v) && !mb_check_encoding($v, 'UTF-8') ? bin2hex($v) : $v, $row)) . "\n";
            }
        }
        foreach (['jane@customer.example', 'Jane Doe', 'Where is my order', 'parcel', 'receipt.pdf', 'PDF secret', 'owner@acme.test', 'Olivia', 'support@acme.test', 'Acme Support'] as $secret) {
            $this->assertStringNotContainsStringIgnoringCase($secret, $dump, "$secret is in the database unencrypted");
        }
        $this->assertGreaterThan(0, $mb);
    }

    public function testInboundGoesToTheRightMailboxOnceAndIsSearchable(): void
    {
        $store = new Mailstore($this->app);
        $support = $store->createMailbox('support@acme.test');
        $sales = $store->createMailbox('sales@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam Agent', 'correct horse battery');
        $store->grant($uid, $support);

        $data = $this->inbound(['recipients' => [['address' => 'support+ticket-9@acme.test', 'base_address' => 'support@acme.test', 'tag' => 'ticket-9']]]);
        $this->assertCount(1, $store->storeInbound($data));
        $this->assertCount(0, $store->storeInbound($data), 'a repeated delivery is stored once');
        $this->assertCount(0, $store->storeInbound($this->inbound(['recipients' => [], 'envelope' => ['rcpt_to' => ['nobody@acme.test']]])), 'no matching mailbox');
        // Spam goes to Spam; an email to two of our mailboxes is in both.
        $store->storeInbound($this->inbound(['subject' => 'WIN A PRIZE', 'text' => 'Claim now', 'reply_text' => 'Claim now', 'html' => null, 'from' => ['address' => 'promo@spam.example', 'name' => null], 'spam' => ['score' => 15, 'action' => 'add header']]));
        $both = $this->inbound(['subject' => 'Partnership', 'text' => 'Shall we work together?', 'reply_text' => null, 'html' => null, 'recipients' => [['address' => 'support@acme.test', 'base_address' => 'support@acme.test'], ['address' => 'sales@acme.test', 'base_address' => 'sales@acme.test']]]);
        $this->assertCount(2, $store->storeInbound($both));

        $inbox = $store->list($uid, $support, 'inbox')['messages'];
        $this->assertSame(['Partnership', 'Where is my order #1042?'], array_column($inbox, 'subject'));
        $this->assertSame(['address' => 'jane@customer.example', 'name' => 'Jane Doe'], $inbox[1]['from']);
        $this->assertSame("Hi, my parcel hasn't arrived yet.", $inbox[1]['snippet']);
        $this->assertSame(['WIN A PRIZE'], array_column($store->list($uid, $support, 'spam')['messages'], 'subject'));
        $this->assertSame([], $store->list($uid, null, 'inbox', 1, '', true)['messages'], 'nothing starred');

        // Search by word, by sender, and every word must match.
        $this->assertSame(['Where is my order #1042?'], array_column($store->list($uid, null, 'all', 1, 'parcel')['messages'], 'subject'));
        $this->assertCount(2, $store->list($uid, null, 'all', 1, 'jane')['messages']);
        $this->assertSame([], $store->list($uid, null, 'all', 1, 'parcel partnership')['messages']);
        $this->assertSame(['Where is my order #1042?'], array_column($store->list($uid, null, 'all', 1, '1042')['messages'], 'subject'));

        // The other mailbox isn't this user's.
        $this->expectException(HttpError::class);
        $store->list($uid, $sales, 'inbox');
    }

    public function testReadingAConversationWithAttachmentsAndInlineImages(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $store->grant($uid, $mb);
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        [$first] = $store->storeInbound($this->inbound(['thread_id' => 'thr_1', 'html' => '<p>See <img src="cid:logo@x"></p>', 'attachments' => [
            ['filename' => 'logo.png', 'content_type' => 'image/png', 'size' => strlen($png), 'content_id' => '<logo@x>', 'disposition' => 'inline', 'content' => base64_encode($png)],
            ['filename' => 'receipt.pdf', 'content_type' => 'application/pdf', 'size' => 9, 'content' => base64_encode('%PDF-1.4!')],
        ]]));
        $store->storeInbound($this->inbound(['thread_id' => 'thr_1', 'subject' => 'Re: Where is my order #1042?', 'date' => '2026-10-02T09:00:00Z']));

        $view = $store->get($uid, $first['id']);
        $this->assertSame('Where is my order #1042?', $view['message']['subject']);
        $this->assertCount(2, $view['thread']);
        $this->assertStringContainsString('src="data:image/png;base64,', $view['message']['html']);
        $this->assertSame(['receipt.pdf'], array_column($view['message']['attachments'], 'filename'), 'the inline image is in the message, not listed');
        $this->assertTrue($view['message']['has_attachments']);
        $file = $store->attachment($uid, $view['message']['attachments'][0]['id']);
        $this->assertSame('%PDF-1.4!', $file['content']);
        $this->assertTrue($store->list($uid, $mb, 'inbox')['messages'][0]['read'], 'reading marks the whole conversation read');

        $this->assertSame(1, $store->update($uid, [$first['id']], ['starred' => true, 'folder' => 'archive']));
        $this->assertSame(['Where is my order #1042?'], array_column($store->list($uid, $mb, 'archive')['messages'], 'subject'));
        $this->assertSame(0, $store->delete($uid, [$first['id']]), 'only Trash, Spam and Drafts can be deleted for good');
        $store->update($uid, [$first['id']], ['folder' => 'trash']);
        $this->assertSame(1, $store->delete($uid, [$first['id']]));
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {attachments}'), 'attachments go with it');
    }

    public function testEmailGoesOutUnderTheSendersNameUnlessTheMailboxHasItsOwn(): void
    {
        $store = new Mailstore($this->app);
        // As installs before 1.7.2 left it: the webmail's own name on the mailbox.
        $mine = $store->createMailbox('olive@acme.test', (string) $this->app->config->get('app_name'), '');
        $team = $store->createMailbox('support@acme.test', 'Acme Support', '');
        $uid = (new Auth($this->app))->createUser('olive@acme.test', 'Olive Hart', 'correct horse battery');
        $store->grant($uid, $mine);
        $store->grant($uid, $team);
        $this->answers['POST /v1/emails'] = fn (array $b) => [202, ['id' => 'out_' . count($this->requests), 'message_id' => '<o@acme.test>', 'thread_id' => 'thr_1', 'accepted' => $b['to'], 'suppressed' => []]];
        $user = ['id' => $uid, 'name' => 'Olive Hart'];

        $store->send($user, $mine, ['to' => 'jane@customer.example', 'subject' => 'Hello', 'text' => 'Hi']);
        $this->assertSame(['address' => 'olive@acme.test', 'name' => 'Olive Hart'], end($this->requests)['body']['from'], 'the person, not the webmail');
        $this->assertSame('', $store->mailbox($uid, $mine)['display_name'], 'and the From list shows no app name either');
        $store->send($user, $team, ['to' => 'jane@customer.example', 'subject' => 'Hello', 'text' => 'Hi']);
        $this->assertSame(['address' => 'support@acme.test', 'name' => 'Acme Support'], end($this->requests)['body']['from'], 'a team name set on purpose stays');
    }

    public function testSendingThroughGhostParseKeepsACopyInSentInTheSameConversation(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test', 'Acme Support', '');
        $auth = new Auth($this->app);
        $uid = $auth->createUser('agent@acme.test', 'Sam Agent', 'correct horse battery');
        $store->grant($uid, $mb);
        [$incoming] = $store->storeInbound($this->inbound(['thread_id' => 'thr_42', 'message_id' => '<q1@customer.example>', 'references' => ['<earlier@acme.test>']]));
        $this->answers['POST /v1/emails'] = fn (array $b) => [202, ['id' => 'out_1', 'message_id' => '<out_1@acme.test>', 'thread_id' => 'thr_other', 'accepted' => $b['to'], 'suppressed' => []]];

        $user = ['id' => $uid, 'name' => 'Sam Agent'];
        $sent = $store->send($user, $mb, ['to' => 'Jane <jane@customer.example>', 'subject' => 'Re: Where is my order #1042?', 'html' => '<p>It ships <b>today</b>.</p>',
            'reply_to_id' => $incoming['id'], 'attachments' => [['filename' => 'label.pdf', 'content_type' => 'application/pdf', 'content' => base64_encode('LABEL')]]]);
        $req = $this->requests[0];
        $this->assertSame(['POST', '/v1/emails'], [$req['method'], $req['path']]);
        $this->assertContains('Authorization: Bearer ek_live_test', $req['headers']);
        $this->assertSame(['address' => 'support@acme.test', 'name' => 'Acme Support'], $req['body']['from']);
        $this->assertSame(['jane@customer.example'], $req['body']['to']);
        $this->assertSame('<q1@customer.example>', $req['body']['in_reply_to']);
        $this->assertSame(['<earlier@acme.test>', '<q1@customer.example>'], $req['body']['references']);
        $this->assertSame('It ships today.', $req['body']['text']);
        $this->assertSame('label.pdf', $req['body']['attachments'][0]['filename']);

        $view = $store->get($uid, $sent['id']);
        $this->assertSame('sent', $view['message']['folder']);
        $this->assertCount(2, $view['thread'], 'the reply joins the customer\'s conversation');
        $this->assertSame('LABEL', $store->attachment($uid, $view['message']['attachments'][0]['id'])['content']);
        $this->assertSame(['jane@customer.example'], $store->contacts($uid));

        // GhostParse refusing: a clear error, and nothing in Sent.
        $this->answers['POST /v1/emails'] = fn () => [422, ['error' => 'domain_not_verified', 'message' => 'acme.test is not verified for sending']];
        try {
            $store->send($user, $mb, ['to' => 'x@y.example', 'subject' => 'Hi', 'text' => 'Hello']);
            $this->fail('should not send');
        } catch (HttpError $e) {
            $this->assertSame('Not sent: acme.test is not verified for sending', $e->getMessage());
        }
        $this->assertCount(1, $store->list($uid, $mb, 'sent')['messages']);
        $this->expectExceptionMessage("not-an-address isn't a valid email address");
        $store->send($user, $mb, ['to' => 'not-an-address', 'subject' => 'x', 'text' => 'y']);
    }

    public function testDrafts(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $store->grant($uid, $mb);
        $user = ['id' => $uid, 'name' => 'Sam'];
        $d1 = $store->saveDraft($user, $mb, ['to' => 'half-typed@', 'subject' => 'Draft one', 'text' => 'Hello']);
        $d2 = $store->saveDraft($user, $mb, ['to' => 'jane@customer.example', 'subject' => 'Draft two', 'text' => 'Hello again', 'draft_id' => $d1]);
        $drafts = $store->list($uid, $mb, 'drafts')['messages'];
        $this->assertSame(['Draft two'], array_column($drafts, 'subject'));
        $this->answers['POST /v1/emails'] = fn () => [202, ['id' => 'out_2', 'message_id' => '<out_2@acme.test>', 'thread_id' => 'thr_2']];
        $store->send($user, $mb, ['to' => 'jane@customer.example', 'subject' => 'Draft two', 'text' => 'Hello again', 'draft_id' => $d2]);
        $this->assertSame([], $store->list($uid, $mb, 'drafts')['messages']);
    }

    public function testSignInIsLimitedAndPasswordsAreArgon2(): void
    {
        $auth = new Auth($this->app);
        $uid = $auth->createUser('Owner@Acme.test', 'Olivia', 'correct horse battery', 'admin');
        $hash = $this->app->db->value('SELECT password_hash FROM {users} WHERE id = ?', [$uid]);
        $this->assertStringStartsWith('$argon2id$', $hash);
        $_SESSION = [];
        $this->assertSame($uid, $auth->login('owner@acme.test', 'correct horse battery', '203.0.113.1'), 'emails are case-insensitive');
        $this->assertNull($auth->user(), 'a password alone never reads mail');
        $this->assertSame(['uid' => $uid, 'stage' => 'enrol'], array_intersect_key($auth->pending(), ['uid' => 1, 'stage' => 1]));
        $this->assertSame('Owner@Acme.test', $auth->pending()['email']);
        try {
            $auth->createUser('owner@acme.test', 'Again', 'correct horse battery');
            $this->fail('duplicate');
        } catch (HttpError $e) {
            $this->assertSame(409, $e->status);
        }
        for ($i = 0; $i < 10; $i++) {
            try {
                $auth->login('owner@acme.test', 'wrong password!', '203.0.113.9');
            } catch (HttpError $e) {
                $this->assertSame(401, $e->status);
            }
        }
        try {
            $auth->login('owner@acme.test', 'correct horse battery', '203.0.113.9');
            $this->fail('should be limited');
        } catch (HttpError $e) {
            $this->assertSame(429, $e->status, 'even the right password waits once the account is being guessed at');
        }
        $this->expectExceptionMessage('at least 10 characters');
        $auth->createUser('new@acme.test', 'New', 'short');
    }

    public function testWebhookSignatures(): void
    {
        $secret = 'whsec_' . base64_encode(random_bytes(24));
        $old = 'whsec_' . base64_encode(random_bytes(24));
        $body = json_encode(['id' => 'evt_1', 'type' => 'email.received', 'data' => ['subject' => 'Hi']]);
        $now = 1_800_000_000;
        $sign = fn (string $s, string $b = null, int $ts = null) => 'v1,' . base64_encode(hash_hmac('sha256', "evt_1." . ($ts ?? $now) . '.' . ($b ?? $body), base64_decode(substr($s, 6)), true));
        $headers = ['Webhook-Id' => 'evt_1', 'Webhook-Timestamp' => (string) $now, 'Webhook-Signature' => $sign($secret)];
        $this->assertSame('Hi', GhostParse::verify($body, $headers, [$secret], 300, $now)['data']['subject']);
        // While rotating: the new and old signatures; an app with only the old secret still accepts it.
        $this->assertSame('evt_1', GhostParse::verify($body, ['webhook-id' => 'evt_1', 'webhook-timestamp' => (string) $now, 'webhook-signature' => $sign($secret) . ' ' . $sign($old)], [$old], 300, $now)['id']);
        foreach ([
            'changed body' => [str_replace('Hi', 'Ho', $body), $headers],
            'wrong secret' => [$body, ['webhook-signature' => $sign('whsec_' . base64_encode(random_bytes(24)))] + $headers],
            'too old' => [$body, ['webhook-timestamp' => (string) ($now - 600), 'webhook-signature' => $sign($secret, null, $now - 600)] + array_change_key_case($headers)],
            'unsigned' => [$body, []],
        ] as $case => [$b, $h]) {
            try {
                GhostParse::verify($b, $h, [$secret], 300, $now);
                $this->fail("accepted: $case");
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testSearchWords(): void
    {
        $this->assertSame(['jane.doe@example.com', 'jane', 'doe', 'example', 'com', 'order', '1042'], Crypto::words('Jane.Doe@Example.com: Order #1042'));
        $this->assertContains('café', Crypto::words('Le Café'));
    }
}
