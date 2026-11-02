<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Notifier;

/** The buttons on a new-mail notification: Mark as read, Archive and Reply, without opening the app. */
final class PushActionsTest extends TestCase
{
    private Mailstore $store;
    private Notifier $n;
    private int $mb;
    private int $uid;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new Mailstore($this->app);
        $this->mb = $this->store->createMailbox('support@acme.test');
        $this->uid = (new Auth($this->app))->createUser('sam@acme.test', 'Sam Agent', 'correct horse battery');
        $this->store->grant($this->uid, $this->mb);
        $this->n = new Notifier($this->app);
        $this->answers['POST /v1/emails'] = fn (array $b) => [202, ['id' => 'out_1', 'message_id' => '<out_1@acme.test>', 'thread_id' => 'thr_x', 'accepted' => $b['to'], 'suppressed' => []]];
    }

    private function receive(array $overrides = []): int
    {
        return $this->store->storeInbound($this->inbound($overrides))[0]['id'];
    }

    private function row(int $id): array
    {
        return $this->app->db->one('SELECT folder, is_read FROM {messages} WHERE id = ?', [$id]);
    }

    private function fails(callable $fn, int $status, string $pattern = '/./'): void
    {
        try {
            $fn();
        } catch (HttpError $e) {
            $this->assertSame($status, $e->status, $e->getMessage());
            $this->assertMatchesRegularExpression($pattern, $e->getMessage());
            return;
        }
        $this->fail("no error, expected $status");
    }

    public function testTheNotificationCarriesWhatItsButtonsNeed(): void
    {
        $id = $this->receive();
        $pushed = [];
        $this->n->transport = function (string $url, array $headers, string $body) use (&$pushed) {
            $pushed[] = $body;
            return 201;
        };
        $payload = $this->n->mailPayload($this->uid, $id, ['title' => 'Jane Doe', 'tag' => "m$id", 'url' => "./#m=$id"]);
        $this->assertSame($id, $payload['message_id']);
        $this->assertSame(1, $payload['unread']);
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/', $payload['token']);
        $this->assertLessThan(3000, strlen(json_encode($payload)), 'well within what a push message can carry');
        $this->assertSame(['ok' => true, 'unread' => 0], $this->n->act($payload['token'], 'read'));
        $this->assertSame(['folder' => 'inbox', 'is_read' => 1], $this->row($id));
    }

    public function testArchiveMovesTheConversationOutOfTheInbox(): void
    {
        $first = $this->receive(['thread_id' => 'thr_a']);
        $second = $this->receive(['thread_id' => 'thr_a', 'subject' => 'Re: order']);
        $other = $this->receive(['thread_id' => 'thr_b']);
        $out = $this->n->act($this->n->actionToken($this->uid, $second), 'archive');
        $this->assertSame(1, $out['unread'], 'the other conversation is still unread');
        $this->assertSame('archive', $this->row($first)['folder']);
        $this->assertSame('archive', $this->row($second)['folder']);
        $this->assertSame('inbox', $this->row($other)['folder']);
    }

    public function testReplySendsFromTheMailboxInTheSameThread(): void
    {
        $id = $this->receive(['message_id' => '<q1@customer.example>', 'reply_to' => [['address' => 'orders@customer.example', 'name' => null]]]);
        $out = $this->n->act($this->n->actionToken($this->uid, $id), 'reply', "  Thanks Jane, it ships today.\r\nSam  ");
        $this->assertIsInt($out['sent'], 'the Sent copy');
        $req = end($this->requests);
        $this->assertSame('/v1/emails', $req['path']);
        $this->assertSame(['orders@customer.example'], $req['body']['to'], 'to the Reply-To address');
        $this->assertSame('support@acme.test', $req['body']['from']['address']);
        $this->assertSame('Re: Where is my order #1042?', $req['body']['subject']);
        $this->assertSame('<q1@customer.example>', $req['body']['in_reply_to']);
        $this->assertSame("Thanks Jane, it ships today.\nSam", $req['body']['text']);
        $this->assertSame('<div>Thanks Jane, it ships today.<br />' . "\nSam</div>", $req['body']['html']);
        $this->assertSame(1, $this->row($id)['is_read'], 'and the email is read now');
        $this->assertSame(['Re: Where is my order #1042?'], array_column($this->store->list($this->uid, $this->mb, 'sent')['messages'], 'subject'));
        $this->assertSame(0, $out['unread']);
    }

    public function testATokenOnlyWorksForItsPersonAndEmailAndNotForever(): void
    {
        $id = $this->receive();
        $token = $this->n->actionToken($this->uid, $id);
        [$claims, $mac] = explode('.', $token);
        // Changed in any way: refused.
        $forged = Notifier::b64u(str_replace('"m":' . $id, '"m":' . ($id + 1), Notifier::unb64u($claims))) . '.' . $mac;
        $this->fails(fn () => $this->n->act($forged, 'read'), 403);
        $this->fails(fn () => $this->n->act($claims . '.' . strrev($mac), 'read'), 403);
        $this->fails(fn () => $this->n->act('', 'read'), 403);
        $this->fails(fn () => $this->n->act($token, 'delete'), 422);
        $this->fails(fn () => $this->n->act($token, 'reply', '   '), 422, '/Write a reply/');
        // Too old.
        $this->fails(fn () => $this->n->act($token, 'read', '', time() + Notifier::ACTION_TTL + 1), 403, '/too old/');
        $this->assertSame(0, $this->row($id)['is_read'], 'nothing done');
        // Signed out everywhere (a password change): every notification's buttons stop working.
        $this->app->db->run('UPDATE {users} SET session_version = session_version + 1 WHERE id = ?', [$this->uid]);
        $this->fails(fn () => $this->n->act($token, 'read'), 403, '/signed out/');
        // A fresh one works; but not once they've lost access to the mailbox, or are disabled.
        $fresh = $this->n->actionToken($this->uid, $id);
        $this->store->revoke($this->uid, $this->mb);
        $this->fails(fn () => $this->n->act($fresh, 'read'), 404);
        $this->store->grant($this->uid, $this->mb);
        $this->app->db->run('UPDATE {users} SET disabled = 1 WHERE id = ?', [$this->uid]);
        $this->fails(fn () => $this->n->act($fresh, 'read'), 403);
        $this->assertSame(0, $this->row($id)['is_read']);
        $this->assertSame([], array_filter($this->requests, fn ($r) => $r['path'] === '/v1/emails'));
    }
}
