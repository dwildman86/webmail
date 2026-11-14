<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\Due;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Meet;

final class MeetTest extends TestCase
{
    private Meet $meet;
    private array $sarah;
    private array $kim;
    private array $alex;

    protected function setUp(): void
    {
        parent::setUp();
        $this->meet = new Meet($this->app);
        $auth = new Auth($this->app);
        $mk = fn (string $email, string $name, string $role = 'user') => ['id' => $auth->createUser($email, $name, 'correct horse battery', $role), 'name' => $name, 'email' => $email, 'role' => $role];
        $this->sarah = $mk('sarah@acme.test', 'Sarah Jones');
        $this->kim = $mk('kim@acme.test', 'Kim Lee');
        $this->alex = $mk('alex@acme.test', 'Alex Morgan', 'admin');
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

    private function peerRow(array $room, array $joined): array
    {
        return $this->meet->peer($room, $joined['secret']);
    }

    public function testMeetingLinksAreRandomHashedAndExpire(): void
    {
        $m = $this->meet->create($this->sarah, '  Quarterly   review ');
        $this->assertSame('Quarterly review', $m['title']);
        $this->assertMatchesRegularExpression('#^https://mail\.example\.com/webmail/meet\.php\?r=[A-Za-z0-9_-]{22}$#', $m['url']);
        $row = $this->app->db->one('SELECT * FROM {meet_rooms} WHERE id = ?', [$m['id']]);
        $this->assertSame(hash('sha256', $m['token']), $row['token_hash']);
        $this->assertStringNotContainsString('Quarterly', $row['title_enc']);
        $this->assertStringNotContainsString($m['token'], $row['token_enc']);
        $this->assertSame('Quarterly review', $this->meet->room($m['token'])['title']);
        $this->fails(fn () => $this->meet->room('nope-nope-nope-nope'), 404, '/expired/');
        $this->app->db->run('UPDATE {meet_rooms} SET expires_at = ? WHERE id = ?', [gmdate('Y-m-d H:i:s', time() - 1), $m['id']]);
        $this->fails(fn () => $this->meet->room($m['token']), 404);
        // Default name, and from an email: its subject.
        $this->assertSame('Meeting with Kim Lee', $this->meet->create($this->kim)['title']);
    }

    public function testMeetingFromAnEmailTakesItsSubjectAndOnlyIfItsYours(): void
    {
        $store = new Mailstore($this->app);
        $box = $store->createMailbox('support@acme.test');
        $store->grant($this->sarah['id'], $box);
        $id = $store->storeInbound($this->inbound(['to' => ['support@acme.test'], 'subject' => 'Broken boiler at No. 4']))[0]['id'];
        $this->assertSame('Broken boiler at No. 4', $this->meet->create($this->sarah, '', $id)['title']);
        $this->assertFalse((bool) $this->app->db->value('SELECT 1 FROM {messages} WHERE id = ? AND is_read = 1', [$id]), 'starting a meeting doesn\'t mark it read');
        $this->expectException(HttpError::class);
        $this->meet->create($this->kim, '', $id);
    }

    public function testMembersJoinGuestsWaitAndAreLetIn(): void
    {
        $m = $this->meet->create($this->sarah, 'Call');
        $room = $this->meet->room($m['token']);
        $s = $this->meet->join($room, $this->sarah, 'ignored');
        $this->assertSame(['in', 'Sarah Jones', true], [$s['status'], $s['name'], $s['member']]);
        $this->assertSame(43, strlen($s['secret']));
        $this->assertFalse((bool) $this->app->db->value('SELECT 1 FROM {meet_peers} WHERE secret_hash = ?', [$s['secret']]));

        $this->fails(fn () => $this->meet->join($room, null, '  '), 422, '/name/');
        $g = $this->meet->join($room, null, "Pat\u{202E} Customer\n");
        $this->assertSame('lobby', $g['status']);
        $this->assertSame('Pat Customer', $g['name']);

        // The guest sees nothing of the meeting while waiting; Sarah sees them knock.
        $gp = $this->meet->poll($room, $this->peerRow($room, $g), 0);
        $this->assertSame(['lobby', [], []], [$gp['status'], $gp['people'], $gp['lobby']]);
        $sp = $this->meet->poll($room, $this->peerRow($room, $s), 0);
        $this->assertSame(['Sarah Jones'], array_column($sp['people'], 'name'));
        $this->assertTrue($sp['people'][0]['host']);
        $this->assertSame([['id' => $g['id'], 'name' => 'Pat Customer', 'member' => false, 'host' => false]], array_map(fn ($p) => array_diff_key($p, ['joined_at' => 1]), $sp['lobby']));

        // A guest can't let anyone in.
        $g2 = $this->meet->join($room, null, 'Sam');
        $this->meet->admit($room, $this->peerRow($room, $s), $g['id'], true);
        $this->fails(fn () => $this->meet->admit($room, $this->peerRow($room, $g), $g2['id'], true), 403, '/account/');
        $this->meet->admit($room, $this->peerRow($room, $s), $g2['id'], false);
        $this->assertSame('denied', $this->meet->poll($room, $this->peerRow($room, $g2), 0)['status']);
        $gp = $this->meet->poll($room, $this->peerRow($room, $g), 0);
        $this->assertSame('in', $gp['status']);
        $this->assertSame([], $gp['lobby'], 'guests aren\'t shown the lobby');
        $this->assertSame(['Sarah Jones', 'Pat Customer'], array_column($gp['people'], 'name'));

        // Guests turned off: only people with an account.
        $this->meet->saveSettings(['guests' => false]);
        $this->fails(fn () => $this->meet->join($room, null, 'Jo'), 403, '/account/');
        $this->assertSame('in', $this->meet->join($room, $this->kim, '')['status']);
    }

    public function testConnectionDetailsGoOnlyToThePersonAndAreDeletedOnceFetched(): void
    {
        $room = $this->meet->room($this->meet->create($this->sarah)['token']);
        $s = $this->meet->join($room, $this->sarah, '');
        $k = $this->meet->join($room, $this->kim, '');
        $g = $this->meet->join($room, null, 'Waiting Guest');
        $sp = $this->peerRow($room, $s);
        $sdp = ['type' => 'offer', 'sdp' => "v=0\r\no=- 1 2 IN IP4 192.0.2.1\r\n"];
        $sent = $this->meet->signal($room, $sp, [['to' => $k['id'], 'kind' => 'offer', 'data' => $sdp], ['to' => $k['id'], 'kind' => 'ice', 'data' => ['candidate' => 'candidate:1 1 udp 1 192.0.2.1 5000 typ host']],
            ['to' => $g['id'], 'kind' => 'offer', 'data' => $sdp], ['to' => $s['id'], 'kind' => 'offer', 'data' => $sdp], ['to' => $k['id'], 'kind' => 'evil', 'data' => 1]]);
        $this->assertSame(2, $sent, 'not to someone in the lobby, not to yourself, only known kinds');
        $raw = $this->app->db->value('SELECT payload_enc FROM {meet_signals} LIMIT 1');
        $this->assertStringNotContainsString('192.0.2.1', $raw, 'kept encrypted');

        $kp = $this->meet->poll($room, $this->peerRow($room, $k), 0);
        $this->assertSame(['offer', 'ice'], array_column($kp['signals'], 'kind'));
        $this->assertSame($sdp, $kp['signals'][0]['data']);
        $this->assertSame($s['id'], $kp['signals'][0]['from']);
        $this->assertSame([], $this->meet->poll($room, $sp, 0)['signals']);
        $last = end($kp['signals'])['id'];
        $this->assertSame([], $this->meet->poll($room, $this->peerRow($room, $k), $last)['signals']);
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {meet_signals}'), 'deleted once received');

        // Someone in the lobby can't send anything; nor can anyone too much.
        $this->fails(fn () => $this->meet->signal($room, $this->peerRow($room, $g), [['to' => $s['id'], 'kind' => 'offer', 'data' => $sdp]]), 403);
        $this->fails(fn () => $this->meet->signal($room, $sp, [['to' => $k['id'], 'kind' => 'offer', 'data' => str_repeat('x', 70000)]]), 413);
        $this->fails(fn () => $this->meet->signal($room, $sp, array_fill(0, 61, ['to' => $k['id'], 'kind' => 'ice', 'data' => 1])), 413);
        // Another meeting's key isn't this one's.
        $other = $this->meet->room($this->meet->create($this->kim)['token']);
        $this->fails(fn () => $this->meet->peer($other, $s['secret']), 401);
    }

    public function testSixAtMostAndTheGoneDontCount(): void
    {
        $room = $this->meet->room($this->meet->create($this->sarah)['token']);
        $host = $this->meet->join($room, $this->sarah, '');
        $guests = [];
        for ($i = 1; $i <= 5; $i++) {
            $guests[] = $g = $this->meet->join($room, null, "Guest $i");
            $this->meet->admit($room, $this->peerRow($room, $host), $g['id'], true);
        }
        $extra = $this->meet->join($room, null, 'Seventh');
        $this->fails(fn () => $this->meet->admit($room, $this->peerRow($room, $host), $extra['id'], true), 409, '/full.*6/');
        $this->fails(fn () => $this->meet->join($room, $this->kim, ''), 409);
        // One closes their laptop: after a while they no longer count, and the seat is free.
        $this->app->db->run('UPDATE {meet_peers} SET seen_at = ? WHERE id = ?', [gmdate('Y-m-d H:i:s', time() - Meet::GONE_AFTER - 5), $guests[0]['id']]);
        $this->assertSame('in', $this->meet->join($room, $this->kim, '')['status']);
        // Back from sleep, the meeting full again: out, to join again.
        $this->assertSame('left', $this->meet->poll($room, $this->peerRow($room, $guests[0]), 0)['status']);
        $this->meet->leave($this->peerRow($room, $guests[1]));
        $this->meet->admit($room, $this->peerRow($room, $host), $extra['id'], true);
        $this->assertCount(6, $this->meet->poll($room, $this->peerRow($room, $host), 0)['people']);
    }

    public function testStateRecordingHostPowersAndLocking(): void
    {
        $room = $this->meet->room($this->meet->create($this->sarah)['token']);
        $s = $this->meet->join($room, $this->sarah, '');
        $k = $this->meet->join($room, $this->kim, '');
        $g = $this->meet->join($room, null, 'Guest');
        $this->meet->admit($room, $this->peerRow($room, $k), $g['id'], true);

        $this->assertSame(['a' => true, 'v' => false, 'r' => true], $this->meet->setState($this->peerRow($room, $k), ['a' => 1, 'v' => 0, 'r' => true, 'x' => 'nope']));
        $this->fails(fn () => $this->meet->setState($this->peerRow($room, $g), ['r' => true]), 403, '/record/');
        $people = $this->meet->poll($room, $this->peerRow($room, $s), 0)['people'];
        $this->assertSame(['a' => true, 'v' => false, 'r' => true], $people[1]['state']);

        // Only whoever started it (or an administrator) removes people and locks it.
        $this->fails(fn () => $this->meet->remove($room, $this->peerRow($room, $k), $this->kim, $g['id']), 403);
        $this->meet->remove($room, $this->peerRow($room, $s), $this->sarah, $g['id']);
        $this->assertSame('removed', $this->meet->poll($room, $this->peerRow($room, $g), 0)['status']);
        $knock = $this->meet->join($room, null, 'Knocking');
        $this->meet->lock($room, $this->peerRow($room, $s), $this->sarah, true);
        $this->assertSame('denied', $this->meet->poll($room, $this->peerRow($room, $knock), 0)['status']);
        $room = $this->meet->room($this->tokenOf($room));
        $this->fails(fn () => $this->meet->join($room, null, 'Late'), 403, '/locked/');
        $this->assertSame('in', $this->meet->join($room, $this->alex, '')['status'], 'people with an account still can');

        // Ending it: everyone out, the link dead.
        $this->fails(fn () => $this->meet->end($this->kim, (int) $room['id']), 404);
        $this->meet->end($this->sarah, (int) $room['id']);
        $this->assertSame('ended', $this->meet->poll($room, $this->peerRow($room, $k), 0)['status']);
        $this->fails(fn () => $this->meet->room($this->tokenOf($room)), 404);
    }

    private function tokenOf(array $room): string
    {
        return (string) $this->app->crypto->decrypt($room['token_enc'], 'meet.token');
    }

    public function testIceServersComeFromGhostParseAndAreKeptForAWhile(): void
    {
        $calls = 0;
        $this->answers['POST /v1/webmail/turn'] = function () use (&$calls) {
            $calls++;
            return [200, ['ice_servers' => [['urls' => ['stun:stun.example.test:3478']], ['urls' => ['turn:turn.example.test:3478?transport=udp'], 'username' => '1999999999:acct-meet', 'credential' => 'c2VjcmV0']],
                'ttl' => 14400, 'relay' => true]];
        };
        $servers = $this->meet->iceServers();
        $this->assertSame('1999999999:acct-meet', $servers[1]['username']);
        $this->assertSame(['turn:turn.example.test:3478?transport=udp'], $servers[1]['urls']);
        $this->meet->iceServers();
        $this->assertSame(1, $calls, 'cached');
        $this->assertStringNotContainsString('c2VjcmV0', (string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'meet_ice'"));
        // GhostParse unreachable: a public STUN server, asked again later.
        $this->app->db->run("DELETE FROM {meta} WHERE k = 'meet_ice'");
        $this->answers['POST /v1/webmail/turn'] = fn () => [503, ['error' => 'down', 'message' => 'Down']];
        $this->assertSame([['urls' => ['stun:stun.l.google.com:19302']]], $this->meet->iceServers());
    }

    public function testHousekeepingAndTurningMeetingsOff(): void
    {
        $m = $this->meet->create($this->sarah);
        $room = $this->meet->room($m['token']);
        $s = $this->meet->join($room, $this->sarah, '');
        $k = $this->meet->join($room, $this->kim, '');
        $this->meet->signal($room, $this->peerRow($room, $s), [['to' => $k['id'], 'kind' => 'ice', 'data' => 1]]);
        $old = gmdate('Y-m-d H:i:s', time() - 3 * 86400);
        $this->app->db->run('UPDATE {meet_signals} SET created_at = ?', [$old]);
        $this->assertTrue($this->meet->cleanupDue());
        (new Due($this->app))->run(5);
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {meet_signals}'));
        $this->assertSame(2, (int) $this->app->db->value('SELECT COUNT(*) FROM {meet_peers}'));
        $this->assertFalse($this->meet->cleanupDue(), 'not again for five minutes');
        $this->app->db->run("DELETE FROM {meta} WHERE k = 'meet_cleaned'");
        $this->app->db->run('UPDATE {meet_peers} SET seen_at = ?', [$old]);
        $this->app->db->run('UPDATE {meet_rooms} SET expires_at = ?', [$old]);
        $this->meet->cleanup();
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {meet_rooms}'));
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {meet_peers}'));

        $this->fails(fn () => $this->meet->saveSettings(['days' => 0]), 422);
        $this->meet->saveSettings(['enabled' => false]);
        $this->fails(fn () => $this->meet->create($this->sarah), 403, '/turned off/');
        $this->assertSame(['enabled' => false, 'guests' => true, 'days' => 30], $this->meet->settings());
    }

    public function testGhostParsesLimitsForThisOrganisationWin(): void
    {
        $this->answers['GET /v1/me'] = fn () => [200, ['account' => ['id' => 'acct'], 'features' => ['meetings' => ['enabled' => true, 'max_people' => 3, 'guests' => false, 'recording' => false, 'relay' => true]]]];
        $this->assertSame(['enabled' => true, 'guests' => false, 'recording' => false, 'max' => 3], array_intersect_key($this->meet->effective(), ['enabled' => 1, 'guests' => 1, 'recording' => 1, 'max' => 1]));
        $room = $this->meet->room($this->meet->create($this->sarah)['token']);
        $s = $this->meet->join($room, $this->sarah, '');
        $this->meet->join($room, $this->kim, '');
        $this->meet->join($room, $this->alex, '');
        $e = $this->fails(fn () => $this->meet->join($room, $this->alex, ''), 409, '/already has 3 people/');
        $this->assertSame('meeting_full', $e->errorCode);
        $poll = $this->meet->poll($room, $this->peerRow($room, $s), 0);
        $this->assertTrue($poll['full']);
        $this->assertSame(3, $poll['max']);
        $this->fails(fn () => $this->meet->join($room, null, 'A guest'), 403, '/account/');
        $this->fails(fn () => $this->meet->setState($this->peerRow($room, $s), ['r' => true]), 403, '/Recording/');
        $this->assertSame(3, $this->meet->describe($room, $this->sarah)['max']);
        // Asked once, then remembered for 10 minutes.
        $asked = count(array_filter($this->requests, fn ($r) => $r['path'] === '/v1/me'));
        $this->meet->effective();
        $this->assertSame($asked, count(array_filter($this->requests, fn ($r) => $r['path'] === '/v1/me')));

        // Turned off altogether.
        $this->answers['GET /v1/me'] = fn () => [200, ['features' => ['meetings' => ['enabled' => false]]]];
        $this->meet->policy(true);
        $this->fails(fn () => $this->meet->create($this->sarah), 403, '/GhostParse/');
    }

    public function testGhostParseUnreachableKeepsTheLastAnswerAndDoesntAskOnEveryRequest(): void
    {
        $this->answers['GET /v1/me'] = fn () => [200, ['features' => ['meetings' => ['enabled' => true, 'max_people' => 4]]]];
        $this->assertSame(4, $this->meet->effective()['max']);
        $this->answers['GET /v1/me'] = fn () => [503, ['error' => 'down', 'message' => 'Down']];
        $this->assertSame(4, $this->meet->policy(true)['max_people']);
        $asked = count($this->requests);
        $this->meet->effective();
        $this->meet->effective();
        $this->assertSame($asked, count($this->requests), 'not asked again for a minute');
    }

    public function testUsageIsReportedAsCountsOnlyAndBringsThePolicy(): void
    {
        $this->answers['GET /v1/me'] = fn () => [200, ['features' => ['meetings' => ['enabled' => true]]]];
        $sent = [];
        $this->answers['POST /v1/webmail/meetings'] = function (array $body) use (&$sent) {
            $sent[] = $body;
            return [200, ['ok' => true, 'policy' => ['enabled' => true, 'max_people' => 5, 'guests' => true, 'recording' => true, 'relay' => true]]];
        };
        $this->assertFalse($this->meet->reportDue(), 'nothing to say yet');
        $room = $this->meet->room($this->meet->create($this->sarah, 'Private: the Henderson account')['token']);
        $s = $this->meet->join($room, $this->sarah, '');
        $g = $this->meet->join($room, null, 'Pat Customer');
        $this->meet->admit($room, $this->peerRow($room, $s), $g['id'], true);
        $this->meet->setState($this->peerRow($room, $s), ['r' => true]);
        $this->assertTrue($this->meet->reportDue());
        $this->meet->report();
        $this->assertCount(1, $sent);
        $this->assertSame(['active_meetings' => 1, 'people_now' => 2, 'guests_now' => 1, 'meetings_started' => 1, 'people_joined' => 2, 'guests_joined' => 1,
            'person_minutes' => 0, 'peak_people' => 2, 'full_refusals' => 0, 'recordings' => 1], $sent[0]);
        $this->assertStringNotContainsString('Henderson', json_encode($sent));
        $this->assertStringNotContainsString('Pat', json_encode($sent));
        // The policy came back with it; the counts sent were taken off.
        $this->assertSame(5, $this->meet->effective()['max']);
        $this->assertFalse($this->meet->reportDue(), 'not again within five minutes');
        $this->app->db->run("UPDATE {meta} SET v = ? WHERE k = 'meet_report'", [json_encode(['at' => time() - 600, 'active' => 1])]);
        $this->meet->leave($this->peerRow($room, $s));
        $this->meet->leave($this->peerRow($room, $g));
        $this->assertTrue($this->meet->reportDue(), 'meetings ended since the last report: said once more');
        $this->meet->report();
        $this->assertSame(['active_meetings' => 0, 'people_now' => 0, 'meetings_started' => 0, 'people_joined' => 0, 'recordings' => 0],
            array_intersect_key($sent[1], ['active_meetings' => 1, 'people_now' => 1, 'meetings_started' => 1, 'people_joined' => 1, 'recordings' => 1]));
        $this->app->db->run("UPDATE {meta} SET v = ? WHERE k = 'meet_report'", [json_encode(['at' => time() - 600, 'active' => 0])]);
        $this->assertFalse($this->meet->reportDue(), 'then quiet');
    }

    public function testMeetingsTurnedAwayWhenFullAreCounted(): void
    {
        $this->answers['GET /v1/me'] = fn () => [200, ['features' => ['meetings' => ['enabled' => true, 'max_people' => 2]]]];
        $room = $this->meet->room($this->meet->create($this->sarah)['token']);
        $s = $this->meet->join($room, $this->sarah, '');
        $this->meet->join($room, $this->kim, '');
        $g = $this->meet->join($room, null, 'Guest');
        $this->fails(fn () => $this->meet->admit($room, $this->peerRow($room, $s), $g['id'], true), 409);
        $this->fails(fn () => $this->meet->join($room, $this->alex, ''), 409);
        $this->assertTrue($this->meet->poll($room, $this->peerRow($room, $g), 0)['full'], 'the guest waiting is told');
        // The guest knocking on a full meeting and Alex refused: two (the refused let-in isn't counted again).
        $this->assertSame('2', (string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'meet_n_full'"));
    }
}
