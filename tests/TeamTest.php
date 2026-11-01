<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Inbound;
use Webmail\Mailstore;
use Webmail\Notifier;
use Webmail\Team;

final class TeamTest extends TestCase
{
    private Mailstore $store;
    private int $support;
    private array $alex;
    private array $sarah;
    private array $kim;
    private array $pushed = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new Mailstore($this->app);
        $this->support = $this->store->createMailbox('support@acme.test');
        $auth = new Auth($this->app);
        $mk = function (string $email, string $name, string $role = 'user') use ($auth) {
            return ['id' => $auth->createUser($email, $name, 'correct horse battery', $role), 'name' => $name, 'email' => $email, 'role' => $role];
        };
        $this->alex = $mk('alex@acme.test', 'Alex Morgan', 'admin');
        $this->sarah = $mk('sarah.jones@acme.test', 'Sarah Jones');
        $this->kim = $mk('kim@acme.test', 'Kim Lee'); // can't read support@
        $this->store->grant($this->alex['id'], $this->support);
        $this->store->grant($this->sarah['id'], $this->support);
    }

    private function team(): Team
    {
        $t = new Team($this->app);
        $t->notifyUser = function (int $userId, array $payload) { $this->pushed[] = [$userId, $payload]; };
        return $t;
    }

    private function receive(array $overrides = []): int
    {
        $stored = $this->store->storeInbound($this->inbound($overrides));
        return $stored[0]['id'];
    }

    private function fails(callable $fn, int $status, string $pattern = '/./'): HttpError
    {
        try {
            $fn();
        } catch (HttpError $e) {
            $this->assertSame($status, $e->status, $e->getMessage());
            $this->assertMatchesRegularExpression($pattern, $e->getMessage());
            return $e;
        }
        $this->fail("no error, expected $status");
    }

    public function testNotesAreForTheMailboxsPeopleAndMentionsNotify(): void
    {
        $team = $this->team();
        $id = $this->receive(['thread_id' => 'thr_refund']);
        $note = $team->addNote($this->alex, $id, "@Sarah I replied to this client, please process their refund.\n@sarah.jones and @nobody");
        $this->assertSame('note', $note['kind']);
        $this->assertSame([$this->sarah['id']], $note['mentions']);
        $this->assertSame([[$this->sarah['id'], ['title' => 'Alex Morgan mentioned you', 'body' => "@Sarah I replied to this client, please process their refund.\n@sarah.jones and @nobody",
            'tag' => 'note' . $note['id'], 'url' => './#m=' . $id]]], $this->pushed);
        $this->assertStringNotContainsString('refund', (string) $this->app->db->value('SELECT body_enc FROM {thread_notes}'), 'encrypted');

        // Sarah sees it on any message of the conversation; Kim (not on the mailbox) can't, or add one.
        $reply = $this->receive(['thread_id' => 'thr_refund', 'subject' => 'Re: refund']);
        $seen = $team->thread($this->sarah, $reply);
        $this->assertTrue($seen['shared']);
        $this->assertSame(['Alex Morgan'], array_column($seen['notes'], 'name'));
        $this->assertFalse($seen['notes'][0]['mine']);
        $this->fails(fn () => $team->thread($this->kim, $id), 404);
        $this->fails(fn () => $team->addNote($this->kim, $id, 'hi'), 404);
        $this->fails(fn () => $team->addNote($this->alex, $id, '   '), 422);

        // Only your own notes (or an administrator) can delete them.
        $this->fails(fn () => $team->deleteNote($this->sarah, $note['id']), 403);
        $mine = $team->addNote($this->sarah, $id, 'Done, refunded £12.');
        $team->deleteNote($this->sarah, $mine['id']);
        $team->deleteNote($this->alex, $note['id']);
        $this->assertSame([], $team->thread($this->alex, $id)['notes']);
    }

    public function testAssignmentStatusAndTheList(): void
    {
        $team = $this->team();
        $id = $this->receive(['thread_id' => 'thr_a']);
        $other = $this->receive(['thread_id' => 'thr_b']);
        $t = $team->assign($this->alex, $id, ['assignee_id' => $this->sarah['id'], 'status' => 'in_progress']);
        $this->assertSame($this->sarah['id'], $t['assignee_id']);
        $this->assertSame('in_progress', $t['status']);
        $this->assertSame('assigned this to Sarah Jones and marked this In progress', $t['notes'][0]['body']);
        $this->assertSame($this->sarah['id'], $this->pushed[0][0]);
        $this->assertSame('Alex Morgan assigned you a conversation', $this->pushed[0][1]['title']);
        $this->fails(fn () => $team->assign($this->alex, $id, ['assignee_id' => $this->kim['id']]), 422, '/can\'t read this mailbox/');
        $this->fails(fn () => $team->assign($this->alex, $id, ['status' => 'done']), 422);
        // Setting what it already is records nothing.
        $this->assertCount(1, $team->assign($this->alex, $id, ['assignee_id' => $this->sarah['id']])['notes']);

        // The list shows it, and narrows to mine / unassigned / a status.
        $list = $this->store->list($this->sarah['id'], null, 'inbox');
        $byId = array_column($list['messages'], null, 'id');
        $this->assertSame(['assignee_id' => $this->sarah['id'], 'assignee' => 'Sarah Jones', 'status' => 'in_progress'], $byId[$id]['team']);
        $this->assertSame(['assignee_id' => null, 'assignee' => null, 'status' => 'open'], $byId[$other]['team']);
        $ids = fn (string $f) => array_column($this->store->list($this->sarah['id'], null, 'inbox', 1, '', false, $f)['messages'], 'id');
        $this->assertSame([$id], $ids('mine'));
        $this->assertSame([], array_column($this->store->list($this->alex['id'], null, 'inbox', 1, '', false, 'mine')['messages'], 'id'));
        $this->assertSame([$other], $ids('unassigned'));
        $this->assertSame([$id], $ids('in_progress'));
        $this->assertSame([$other], $ids('open'));

        // Resolved, then the customer writes again: open again.
        $team->assign($this->sarah, $id, ['status' => 'resolved']);
        $this->assertSame([$id], $ids('resolved'));
        $inbound = new Inbound($this->app);
        $key = base64_decode(substr($this->config['ghostparse']['webhook_secret'], 6));
        $body = json_encode(['id' => 'evt_again', 'type' => 'email.received', 'data' => $this->inbound(['thread_id' => 'thr_a', 'subject' => 'Re: still waiting'])]);
        $ts = time();
        $inbound->handle($body, ['webhook-id' => 'evt_again', 'webhook-timestamp' => (string) $ts, 'webhook-signature' => 'v1,' . base64_encode(hash_hmac('sha256', "evt_again.$ts.$body", $key, true))]);
        $t = $team->thread($this->sarah, $id);
        $this->assertSame('open', $t['status']);
        $this->assertSame('reopened: a new email arrived', end($t['notes'])['body']);
        $this->assertNull(end($t['notes'])['name'], 'nobody did it: the webmail did');

        // A mailbox only one person reads isn't shared: no team details in its list.
        $solo = $this->store->createMailbox('alex@acme.test');
        $this->store->grant($this->alex['id'], $solo);
        $mine = $this->store->storeInbound($this->inbound(['to' => [['address' => 'alex@acme.test', 'name' => null]], 'recipients' => [['address' => 'alex@acme.test', 'base_address' => 'alex@acme.test', 'tag' => null]], 'envelope' => ['rcpt_to' => ['alex@acme.test']]]))[0]['id'];
        $this->assertArrayNotHasKey('team', array_column($this->store->list($this->alex['id'], $solo, 'inbox')['messages'], null, 'id')[$mine]);
        $this->assertFalse($team->thread($this->alex, $mine)['shared']);
    }

    public function testASharedReplyIsWrittenTogetherAndSentByEither(): void
    {
        $team = $this->team();
        $id = $this->receive(['thread_id' => 'thr_c']);
        $d = $team->startDraft($this->alex, $id, ['to' => 'jane@customer.example', 'subject' => 'Re: order', 'html' => '<p>Hi Jane,</p>', 'text' => 'Hi Jane,']);
        $this->assertSame(1, $d['version']);
        $this->assertSame([], $d['editors']);
        // Sarah joins the same one (one per conversation), and each sees the other.
        $joined = $team->startDraft($this->sarah, $id, ['html' => 'ignored']);
        $this->assertSame($d['id'], $joined['id']);
        $this->assertSame('<p>Hi Jane,</p>', $joined['fields']['html']);
        $this->assertSame(['Alex Morgan'], array_column($joined['editors'], 'name'));
        $this->assertSame('Alex Morgan', $team->thread($this->sarah, $id)['draft']['started_by']);

        // Saves are made to a version: a save based on an older one is refused with the newer one.
        $v2 = $team->saveDraft($this->sarah, $d['id'], 1, array_merge($joined['fields'], ['html' => '<p>Hi Jane,</p><p>Refund done.</p>']));
        $this->assertSame(2, $v2['version']);
        $this->assertSame('Sarah Jones', $v2['updated_by']);
        $e = $this->fails(fn () => $team->saveDraft($this->alex, $d['id'], 1, ['html' => '<p>Hello Jane,</p>']), 409);
        $this->assertSame(2, $e->data['draft']['version']);
        $this->assertSame('<p>Hi Jane,</p><p>Refund done.</p>', $e->data['draft']['fields']['html']);
        $this->assertTrue($team->draft($this->alex, $d['id'], true)['editors'][0]['typing'], 'Sarah just typed');
        $this->assertStringNotContainsString('Refund', (string) $this->app->db->value('SELECT fields_enc FROM {shared_drafts}'), 'encrypted');
        $this->fails(fn () => $team->draft($this->kim, $d['id'], true), 404);

        // Alex sends it: it's gone for both, and the conversation says who sent it.
        $this->answers['POST /v1/emails'] = fn () => [200, ['id' => 'out_1', 'message_id' => '<out1@acme.test>']];
        $this->store->send($this->alex, $this->support, ['to' => 'jane@customer.example', 'subject' => 'Re: order', 'html' => '<p>Hi Jane,</p><p>Refund done.</p>',
            'reply_to_id' => $id, 'shared_draft_id' => $d['id']]);
        $this->fails(fn () => $team->draft($this->sarah, $d['id'], true), 404, '/sent or deleted/');
        $t = $team->thread($this->sarah, $id);
        $this->assertNull($t['draft']);
        $this->assertSame(['started a shared reply', 'sent the shared reply'], array_column($t['notes'], 'body'));

        // Only for shared mailboxes.
        $solo = $this->store->createMailbox('alex@acme.test');
        $this->store->grant($this->alex['id'], $solo);
        $mine = $this->store->storeInbound($this->inbound(['recipients' => [['address' => 'alex@acme.test', 'base_address' => 'alex@acme.test', 'tag' => null]], 'envelope' => ['rcpt_to' => ['alex@acme.test']]]))[0]['id'];
        $this->fails(fn () => $team->startDraft($this->alex, $mine, []), 422, '/no one to write with/');
    }
}
