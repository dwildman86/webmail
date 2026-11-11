<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\Due;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Prefs;
use Webmail\Scheduler;

/** Send later, snooze, and Due, which does both when their time comes. */
final class LaterTest extends TestCase
{
    private Mailstore $store;
    private int $mb;
    private array $olive;
    private array $pushed = [];
    private int $status = 202;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new Mailstore($this->app);
        $this->mb = $this->store->createMailbox('olive@acme.test');
        $id = (new Auth($this->app))->createUser('olive@acme.test', 'Olive Hart', 'correct horse battery', 'user');
        $this->olive = ['id' => $id, 'name' => 'Olive Hart', 'email' => 'olive@acme.test', 'role' => 'user'];
        $this->store->grant($id, $this->mb);
        $this->answers['POST /v1/emails'] = fn (array $b) => $this->status >= 400
            ? [$this->status, ['error' => 'nope', 'message' => $this->status >= 500 ? 'GhostParse is down' : 'Recipient refused']]
            : [202, ['id' => 'out_' . count($this->requests), 'message_id' => '<o' . count($this->requests) . '@acme.test>', 'thread_id' => 'thr_x', 'accepted' => $b['to'], 'suppressed' => []]];
    }

    private function scheduler(): Scheduler
    {
        $s = new Scheduler($this->app);
        $s->notifyUser = function (int $userId, array $payload) { $this->pushed[] = [$userId, $payload]; };
        return $s;
    }

    private function due(): Due
    {
        $d = new Due($this->app);
        $d->onWoken = function (array $woken) { $this->pushed[] = ['woken', array_column($woken, 'id')]; };
        $d->scheduler = $this->scheduler();
        return $d;
    }

    /** Pretend $seconds have passed, for everything that's waiting. */
    private function later(int $seconds): void
    {
        $this->app->db->run('UPDATE {scheduled} SET send_at = DATE_SUB(send_at, INTERVAL ? SECOND), claimed_at = DATE_SUB(claimed_at, INTERVAL ? SECOND)', [$seconds, $seconds]);
        $this->app->db->run('UPDATE {messages} SET snoozed_until = DATE_SUB(snoozed_until, INTERVAL ? SECOND) WHERE snoozed_until IS NOT NULL', [$seconds]);
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

    private function sentCount(): int
    {
        return count(array_filter($this->requests, fn ($r) => $r['path'] === '/v1/emails'));
    }

    public function testAScheduledEmailIsSentWhenItsDueAndNotBefore(): void
    {
        $draft = $this->store->saveDraft($this->olive, $this->mb, ['to' => 'jane@customer.example', 'subject' => 'Monday', 'text' => 'Draft']);
        $at = new \DateTimeImmutable('+2 hours');
        $s = $this->scheduler()->schedule($this->olive, $this->mb, ['to' => 'jane@customer.example', 'subject' => 'See you Monday', 'text' => 'Hi Jane',
            'html' => '<p>Hi Jane</p>', 'draft_id' => $draft, 'attachments' => [['filename' => 'a.txt', 'content_type' => 'text/plain', 'content' => base64_encode('A')]]], $at);
        $this->assertSame(['waiting', 'See you Monday', ['jane@customer.example'], 1], [$s['status'], $s['subject'], $s['to'], $s['attachments']]);
        $this->assertSame(gmdate('c', $at->getTimestamp()), $s['send_at']);
        $this->assertNull($this->app->db->value('SELECT id FROM {messages} WHERE id = ?', [$draft]), 'no longer a draft');
        $this->assertStringNotContainsString('Jane', (string) $this->app->db->value('SELECT payload_enc FROM {scheduled}'), 'encrypted');

        $this->assertSame(['woken' => 0, 'sent' => 0, 'reminded' => 0], $this->due()->run());
        $this->assertSame(0, $this->sentCount());

        $this->later(2 * 3600);
        $this->assertSame(['woken' => 0, 'sent' => 1, 'reminded' => 0], $this->due()->run());
        $req = end($this->requests);
        $this->assertSame(['jane@customer.example'], $req['body']['to']);
        $this->assertSame('See you Monday', $req['body']['subject']);
        $this->assertSame('a.txt', $req['body']['attachments'][0]['filename']);
        $this->assertSame([], $this->scheduler()->list($this->olive['id']), 'gone from the queue');
        $this->assertSame(['See you Monday'], array_column($this->store->list($this->olive['id'], $this->mb, 'sent')['messages'], 'subject'), 'and in Sent');
        $this->assertSame(['woken' => 0, 'sent' => 0, 'reminded' => 0], $this->due()->run(), 'never twice');
        $this->assertSame(1, $this->sentCount());
    }

    public function testMistakesShowWhenSchedulingNotWhenItsDue(): void
    {
        $at = new \DateTimeImmutable('+1 day');
        $s = $this->scheduler();
        $this->fails(fn () => $s->schedule($this->olive, $this->mb, ['to' => 'not an address', 'text' => 'x'], $at), 422, '/valid email/');
        $this->fails(fn () => $s->schedule($this->olive, $this->mb, ['text' => 'x'], $at), 422, '/recipient/');
        $this->fails(fn () => $s->schedule($this->olive, $this->mb, ['to' => 'a@b.test'], new \DateTimeImmutable('-1 hour')), 422, '/future|from now/');
        $this->fails(fn () => $s->schedule($this->olive, $this->mb, ['to' => 'a@b.test'], new \DateTimeImmutable('+2 years')), 422, '/year/');
        $this->fails(fn () => $s->schedule($this->olive, $this->mb, ['to' => 'a@b.test', 'shared_draft_id' => 3], $at), 422, '/together/');
        $this->fails(fn () => Scheduler::time('next blursday'), 422);
        $this->fails(fn () => $s->schedule($this->olive, 999, ['to' => 'a@b.test'], $at), 404);
    }

    public function testSendNowRescheduleAndTakeBack(): void
    {
        $s = $this->scheduler();
        $a = $s->schedule($this->olive, $this->mb, ['to' => 'a@customer.example', 'subject' => 'A', 'text' => 'a'], new \DateTimeImmutable('+1 day'));
        $b = $s->schedule($this->olive, $this->mb, ['to' => 'b@customer.example', 'subject' => 'B', 'text' => 'b', 'cc' => 'c@customer.example'], new \DateTimeImmutable('+2 days'));
        $later = new \DateTimeImmutable('+3 days');
        $this->assertSame(gmdate('c', $later->getTimestamp()), $s->reschedule($this->olive, $a['id'], $later)['send_at']);
        $this->assertSame(['B', 'A'], array_column($s->list($this->olive['id']), 'subject'), 'soonest first');

        $s->sendNow($this->olive, $a['id']);
        $this->assertSame(1, $this->sentCount());
        $payload = $s->cancel($this->olive, $b['id']);
        $this->assertSame(['b@customer.example', 'c@customer.example', 'B', $this->mb], [$payload['to'], $payload['cc'], $payload['subject'], $payload['mailbox_id']]);
        $this->assertSame([], $s->list($this->olive['id']));
        $this->fails(fn () => $s->cancel($this->olive, $b['id']), 404);

        // Someone else's can't be touched.
        $kim = ['id' => (new Auth($this->app))->createUser('kim@acme.test', 'Kim', 'correct horse battery', 'user'), 'role' => 'user'];
        $c = $s->schedule($this->olive, $this->mb, ['to' => 'a@customer.example', 'text' => 'a'], new \DateTimeImmutable('+1 day'));
        $this->fails(fn () => $s->sendNow($kim, $c['id']), 404);
        $this->fails(fn () => $s->cancel($kim, $c['id']), 404);
        $this->assertSame([], $s->list($kim['id']));
    }

    public function testFailuresAreKeptWithTheReasonAndOutagesAreTriedAgain(): void
    {
        $s = $this->scheduler();
        $s->schedule($this->olive, $this->mb, ['to' => 'a@customer.example', 'subject' => 'Outage', 'text' => 'a'], new \DateTimeImmutable('+1 hour'));
        $this->later(3600);
        $this->status = 502;
        $this->assertSame(0, $this->due()->run()['sent']);
        $row = $s->list($this->olive['id'])[0];
        $this->assertSame('waiting', $row['status'], 'tried again later');
        $this->assertGreaterThan(time() + 60, strtotime($row['send_at']));
        $this->assertStringContainsString('GhostParse is down', (string) $row['error']);
        $this->status = 202;
        $this->later(3600);
        $this->assertSame(1, $this->due()->run()['sent']);

        $s->schedule($this->olive, $this->mb, ['to' => 'b@customer.example', 'subject' => 'Refused', 'text' => 'b'], new \DateTimeImmutable('+1 hour'));
        $this->later(3600);
        $this->status = 422;
        $this->due()->run();
        $row = $s->list($this->olive['id'])[0];
        $this->assertSame('failed', $row['status']);
        $this->assertStringContainsString('Recipient refused', (string) $row['error']);
        $this->assertSame($this->olive['id'], $this->pushed[0][0] ?? null);
        $this->assertStringContainsString('Refused', $this->pushed[0][1]['body']);
        // A failed one can be sent again once it's fixed, or given a new time.
        $this->status = 202;
        $s->reschedule($this->olive, $row['id'], new \DateTimeImmutable('+1 hour'));
        $this->assertSame('waiting', $s->list($this->olive['id'])[0]['status']);
        $this->assertNull($s->list($this->olive['id'])[0]['error']);
    }

    public function testASendThatWasCutOffIsNeverSentTwice(): void
    {
        $s = $this->scheduler();
        $x = $s->schedule($this->olive, $this->mb, ['to' => 'a@customer.example', 'subject' => 'Cut off', 'text' => 'a'], new \DateTimeImmutable('+1 hour'));
        $this->app->db->run("UPDATE {scheduled} SET status = 'sending', claimed_at = ? WHERE id = ?", [gmdate('Y-m-d H:i:s'), $x['id']]);
        $this->fails(fn () => $s->sendNow($this->olive, $x['id']), 409);
        $this->fails(fn () => $s->cancel($this->olive, $x['id']), 409);
        $this->later(3600);
        $this->due()->run();
        $row = $s->list($this->olive['id'])[0];
        $this->assertSame('failed', $row['status']);
        $this->assertStringContainsString('check Sent', (string) $row['error']);
        $this->assertSame(0, $this->sentCount());
    }

    public function testSnoozeHidesAnEmailUntilItsTimeThenItsBackOnTopUnread(): void
    {
        $older = $this->store->storeInbound($this->inbound(['date' => '2026-09-01T10:00:00Z', 'recipients' => [['address' => 'olive@acme.test']]]))[0]['id'];
        $newer = $this->store->storeInbound($this->inbound(['date' => '2026-10-01T10:00:00Z', 'recipients' => [['address' => 'olive@acme.test']]]))[0]['id'];
        $this->store->update($this->olive['id'], [$older], ['read' => true]);
        $this->fails(fn () => $this->store->snooze($this->olive['id'], [$older], new \DateTimeImmutable('-1 hour')), 422);
        $this->assertSame(1, $this->store->snooze($this->olive['id'], [$older], new \DateTimeImmutable('+3 hours')));

        $this->assertSame([$newer], array_column($this->store->list($this->olive['id'], $this->mb, 'inbox')['messages'], 'id'));
        $snoozed = $this->store->list($this->olive['id'], $this->mb, 'snoozed')['messages'];
        $this->assertSame([$older], array_column($snoozed, 'id'));
        $this->assertNotNull($snoozed[0]['snoozed_until']);
        $this->assertSame(1, $this->store->mailboxesFor($this->olive['id'])[0]['snoozed']);
        $this->assertContains($older, array_column($this->store->list($this->olive['id'], $this->mb, 'all', 1, 'parcel')['messages'], 'id'), 'search still finds it');

        $this->assertSame(0, $this->due()->run()['woken']);
        $this->later(3 * 3600);
        $this->assertSame(1, $this->due()->run()['woken']);
        $inbox = $this->store->list($this->olive['id'], $this->mb, 'inbox')['messages'];
        $this->assertSame([$older, $newer], array_column($inbox, 'id'), 'back on top');
        $this->assertFalse($inbox[0]['read'], 'unread');
        $this->assertSame([['woken', [$older]]], $this->pushed);
    }

    public function testSnoozingFromArchiveBringsItBackToTheInboxAndMovingItUnsnoozes(): void
    {
        $id = $this->store->storeInbound($this->inbound(['recipients' => [['address' => 'olive@acme.test']]]))[0]['id'];
        $this->store->update($this->olive['id'], [$id], ['folder' => 'archive']);
        $this->store->snooze($this->olive['id'], [$id], new \DateTimeImmutable('+1 day'));
        $this->assertSame([], $this->store->list($this->olive['id'], $this->mb, 'archive')['messages']);
        $this->store->update($this->olive['id'], [$id], ['folder' => 'trash']);
        $this->assertNull($this->app->db->value('SELECT snoozed_until FROM {messages} WHERE id = ?', [$id]), 'deleting it ends the snooze');
        $this->store->update($this->olive['id'], [$id], ['folder' => 'archive']);
        $this->store->snooze($this->olive['id'], [$id], new \DateTimeImmutable('+1 day'));
        $this->assertSame(1, $this->store->snooze($this->olive['id'], [$id], null), 'unsnoozed by hand');
        $this->assertSame('archive', $this->app->db->value('SELECT folder FROM {messages} WHERE id = ?', [$id]));
        $this->store->snooze($this->olive['id'], [$id], new \DateTimeImmutable('+1 day'));
        $this->later(86400);
        $this->due()->run();
        $this->assertSame('inbox', $this->app->db->value('SELECT folder FROM {messages} WHERE id = ?', [$id]));
    }

    public function testOnlyOneRequestDoesTheDueWorkAtATime(): void
    {
        $this->scheduler()->schedule($this->olive, $this->mb, ['to' => 'a@customer.example', 'text' => 'a'], new \DateTimeImmutable('+1 hour'));
        $this->later(3600);
        $other = new \PDO(sprintf('mysql:host=%s;port=%d;dbname=%s', $this->config['db']['host'], $this->config['db']['port'], $this->config['db']['name']), $this->config['db']['user'], $this->config['db']['pass']);
        $lock = Due::lockName($this->app);
        $other->query("SELECT GET_LOCK('$lock', 0)");
        $this->assertNull($this->due()->run(), 'busy');
        $other->query("SELECT RELEASE_LOCK('$lock')");
        $this->assertSame(1, $this->due()->run()['sent']);
    }

    public function testUndoSendDelayIsAPersonalSetting(): void
    {
        $p = new Prefs($this->app);
        $this->assertSame(['undo_send' => 10, 'attach_check' => true, 'cc_check' => true, 'app_prompts' => true], $p->get($this->olive['id']));
        $this->assertSame(['undo_send' => 30, 'attach_check' => true, 'cc_check' => true, 'app_prompts' => true], $p->save($this->olive['id'], ['undo_send' => 30, 'theme' => 'pink']));
        $this->assertSame(['undo_send' => 30, 'attach_check' => false, 'cc_check' => true, 'app_prompts' => true], $p->save($this->olive['id'], ['attach_check' => false]));
        $this->assertSame(['undo_send' => 30, 'attach_check' => false, 'cc_check' => true, 'app_prompts' => true], $p->get($this->olive['id']));
        $this->assertFalse($p->save($this->olive['id'], ['app_prompts' => false])['app_prompts'], 'stop suggesting the app');
        $this->fails(fn () => $p->save($this->olive['id'], ['undo_send' => 7]), 422);
    }
}
