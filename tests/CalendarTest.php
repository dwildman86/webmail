<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\Calendar;
use Webmail\Due;
use Webmail\HttpError;
use Webmail\Mailstore;

final class CalendarTest extends TestCase
{
    private array $alex;
    private array $sarah;
    private array $kim;
    private array $pushed = [];

    protected function setUp(): void
    {
        parent::setUp();
        $auth = new Auth($this->app);
        $mk = function (string $email, string $name, string $role = 'user') use ($auth) {
            return ['id' => $auth->createUser($email, $name, 'correct horse battery', $role), 'name' => $name, 'email' => $email, 'role' => $role];
        };
        $this->alex = $mk('alex@acme.test', 'Alex Morgan', 'admin');
        $this->sarah = $mk('sarah@acme.test', 'Sarah Jones');
        $this->kim = $mk('kim@acme.test', 'Kim Lee');
    }

    private function cal(): Calendar
    {
        $c = new Calendar($this->app);
        $c->notifyUser = function (int $userId, array $payload) { $this->pushed[] = [$userId, $payload]; };
        return $c;
    }

    private function mine(array $user): int
    {
        foreach ($this->cal()->calendars($user) as $c) {
            if ($c['kind'] === 'personal' && $c['role'] === 'owner') {
                return $c['id'];
            }
        }
        $this->fail('no personal calendar');
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

    private function starts(array $user, string $from, string $to): array
    {
        return array_map(fn ($e) => $e['title'] . ' ' . $e['start'], $this->cal()->eventsFor($user, $from, $to));
    }

    public function testEveryoneGetsTheirOwnCalendarAndEventsAreEncrypted(): void
    {
        $cals = $this->cal()->calendars($this->sarah);
        $this->assertCount(1, $cals);
        $this->assertSame(['personal', 'My calendar', 'owner', true], [$cals[0]['kind'], $cals[0]['name'], $cals[0]['role'], $cals[0]['can_manage']]);

        $e = $this->cal()->saveEvent($this->sarah, ['calendar_id' => $cals[0]['id'], 'title' => 'Dentist with Dr Patel', 'location' => '12 High St', 'notes' => "Bring the form\nand card",
            'start' => '2026-11-20T10:00:00Z', 'end' => '2026-11-20T10:30:00Z', 'tz' => 'Europe/London', 'reminders' => [30, 10, 10]]);
        $this->assertSame(['Dentist with Dr Patel', '12 High St', "Bring the form\nand card", [10, 30], 'Sarah Jones'], [$e['title'], $e['location'], $e['notes'], $e['reminders'], $e['created_by']]);
        $row = $this->app->db->one('SELECT * FROM {cal_events} WHERE id = ?', [$e['id']]);
        $this->assertStringNotContainsString('Patel', json_encode($row));

        // Only Sarah sees it.
        $this->assertSame(['Dentist with Dr Patel 2026-11-20T10:00:00Z'], $this->starts($this->sarah, '2026-11-16T00:00:00Z', '2026-11-23T00:00:00Z'));
        $this->assertSame([], $this->starts($this->kim, '2026-11-16T00:00:00Z', '2026-11-23T00:00:00Z'));
        $this->fails(fn () => $this->cal()->saveEvent($this->kim, ['calendar_id' => $cals[0]['id'], 'title' => 'x', 'start' => '2026-11-20T10:00:00Z', 'end' => '2026-11-20T11:00:00Z']), 404);
        $this->fails(fn () => $this->cal()->deleteEvent($this->kim, $e['id'], 'all', null), 404);
        $this->fails(fn () => $this->cal()->saveEvent($this->sarah, ['calendar_id' => $cals[0]['id'], 'title' => 'x', 'start' => '2026-11-20T10:00:00Z', 'end' => '2026-11-20T09:00:00Z']), 422, '/end after/');
        // The only calendar can't go.
        $this->fails(fn () => $this->cal()->deleteCalendar($this->sarah, $cals[0]['id']), 422, '/only calendar/');
    }

    public function testSharedCalendarsHaveMembersWhoCanSeeOrChangeThem(): void
    {
        $cal = $this->cal()->saveCalendar($this->sarah, ['kind' => 'shared', 'name' => 'Team rota', 'color' => '#16a34a',
            'members' => [['user_id' => $this->kim['id'], 'role' => 'view'], ['user_id' => $this->alex['id'], 'role' => 'edit'], ['user_id' => 9999, 'role' => 'edit']]]);
        $this->assertSame(['shared', 'Team rota', '#16a34a'], [$cal['kind'], $cal['name'], $cal['color']]);
        $this->assertEqualsCanonicalizing([[$this->sarah['id'], 'owner'], [$this->kim['id'], 'view'], [$this->alex['id'], 'edit']], array_map(fn ($m) => [$m['user_id'], $m['role']], $cal['members']));
        $this->assertSame('owner', $cal['members'][0]['role']);
        // The people added were told.
        $this->assertEqualsCanonicalizing([$this->kim['id'], $this->alex['id']], array_column($this->pushed, 0));
        $this->assertStringContainsString('Sarah Jones added you to Team rota', $this->pushed[0][1]['body']);

        $e = $this->cal()->saveEvent($this->alex, ['calendar_id' => $cal['id'], 'title' => 'Kim on holiday', 'all_day' => true, 'start' => '2026-12-21', 'end' => '2026-12-24']);
        $this->assertSame(['2026-12-21', '2026-12-24', 'Alex Morgan'], [$e['start'], $e['end'], $e['created_by']]);
        $seen = $this->cal()->eventsFor($this->kim, '2026-12-20T00:00:00Z', '2026-12-27T00:00:00Z');
        $this->assertSame(['Kim on holiday', false], [$seen[0]['title'], $seen[0]['can_edit']]);
        // Kim can see but not change it, or the calendar.
        $this->fails(fn () => $this->cal()->saveEvent($this->kim, ['id' => $e['id'], 'calendar_id' => $cal['id'], 'title' => 'x', 'all_day' => true, 'start' => '2026-12-21', 'end' => '2026-12-22']), 403);
        $this->fails(fn () => $this->cal()->saveCalendar($this->kim, ['id' => $cal['id'], 'name' => 'Mine now']), 403);
        $this->fails(fn () => $this->cal()->saveCalendar(['role' => 'user'] + $this->alex, ['id' => $cal['id'], 'name' => 'x']), 403);
        // An administrator can manage it; members can hide it or leave; the owner can't leave.
        $this->cal()->saveCalendar($this->alex, ['id' => $cal['id'], 'name' => 'Rota', 'color' => '#dc2626', 'members' => [['user_id' => $this->alex['id'], 'role' => 'edit']]]);
        $this->assertSame([], $this->cal()->eventsFor($this->kim, '2026-12-20T00:00:00Z', '2026-12-27T00:00:00Z'), 'Kim was taken off');
        $this->cal()->leave($this->alex, $cal['id']);
        $this->assertCount(1, $this->cal()->calendars($this->alex));
        $this->fails(fn () => $this->cal()->leave($this->sarah, $cal['id']), 422);
        $this->cal()->deleteCalendar($this->sarah, $cal['id']);
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {cal_events}'));
    }

    public function testRepeatingEventsKeepTheirLocalTimeAndCanChangeOneOrTheRest(): void
    {
        $id = $this->mine($this->sarah);
        // Weekly at 9:00 London, Mondays and Wednesdays, from Monday 19 October 2026: the clocks go back on 25 October.
        $e = $this->cal()->saveEvent($this->sarah, ['calendar_id' => $id, 'title' => 'Stand-up', 'start' => '2026-10-19T08:00:00Z', 'end' => '2026-10-19T08:15:00Z',
            'tz' => 'Europe/London', 'repeat' => ['freq' => 'weekly', 'days' => ['MO', 'WE']]]);
        $this->assertSame(['Stand-up 2026-10-19T08:00:00Z', 'Stand-up 2026-10-21T08:00:00Z', 'Stand-up 2026-10-26T09:00:00Z', 'Stand-up 2026-10-28T09:00:00Z'],
            $this->starts($this->sarah, '2026-10-18T00:00:00Z', '2026-11-01T00:00:00Z'));
        // Far ahead, quickly.
        $this->assertSame(['Stand-up 2031-06-02T08:00:00Z', 'Stand-up 2031-06-04T08:00:00Z'], $this->starts($this->sarah, '2031-06-01T00:00:00Z', '2031-06-07T00:00:00Z'));

        // Move just one (to 10:00 that Wednesday), and delete another.
        $this->cal()->saveEvent($this->sarah, ['id' => $e['id'], 'calendar_id' => $id, 'scope' => 'this', 'occurrence' => '2026-10-21T08:00:00Z', 'title' => 'Stand-up (late)',
            'start' => '2026-10-21T09:00:00Z', 'end' => '2026-10-21T09:15:00Z', 'tz' => 'Europe/London', 'repeat' => ['freq' => 'weekly', 'days' => ['MO', 'WE']]]);
        $this->cal()->deleteEvent($this->sarah, $e['id'], 'this', '2026-10-26T09:00:00Z');
        $this->assertSame(['Stand-up 2026-10-19T08:00:00Z', 'Stand-up (late) 2026-10-21T09:00:00Z', 'Stand-up 2026-10-28T09:00:00Z'],
            $this->starts($this->sarah, '2026-10-18T00:00:00Z', '2026-11-01T00:00:00Z'));

        // From 2 November on: at 9:30 instead. Before it, as it was.
        $this->cal()->saveEvent($this->sarah, ['id' => $e['id'], 'calendar_id' => $id, 'scope' => 'following', 'occurrence' => '2026-11-02T09:00:00Z', 'title' => 'Stand-up',
            'start' => '2026-11-02T09:30:00Z', 'end' => '2026-11-02T09:45:00Z', 'tz' => 'Europe/London', 'repeat' => ['freq' => 'weekly', 'days' => ['MO', 'WE']]]);
        $this->assertSame(['Stand-up 2026-10-28T09:00:00Z', 'Stand-up 2026-11-02T09:30:00Z', 'Stand-up 2026-11-04T09:30:00Z'],
            $this->starts($this->sarah, '2026-10-27T00:00:00Z', '2026-11-05T00:00:00Z'));

        // Deleting from an occurrence on ends the series there.
        $this->cal()->deleteEvent($this->sarah, (int) $this->cal()->eventsFor($this->sarah, '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z')[0]['id'], 'following', '2026-11-04T09:30:00Z');
        $this->assertSame(['Stand-up 2026-11-02T09:30:00Z'], $this->starts($this->sarah, '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'));
    }

    public function testRepeatRules(): void
    {
        $tz = new \DateTimeZone('Europe/London');
        $run = function (string $start, array $rule, string $until = '2028-01-01') use ($tz) {
            $out = [];
            foreach (Calendar::expand(new \DateTimeImmutable($start, $tz), $rule, new \DateTimeImmutable($until, $tz)) as $d) {
                $out[] = $d->format('Y-m-d');
            }
            return $out;
        };
        // Monthly on the 31st skips short months; on the second Tuesday; the last Friday; yearly on 29 February.
        $this->assertSame(['2027-01-31', '2027-03-31', '2027-05-31'], $run('2027-01-31 10:00', ['freq' => 'monthly', 'count' => 3]));
        $this->assertSame(['2027-01-12', '2027-02-09', '2027-03-09'], $run('2027-01-12 10:00', ['freq' => 'monthly', 'by' => 'weekday', 'count' => 3]));
        $this->assertSame(['2027-01-29', '2027-02-26', '2027-03-26', '2027-04-30'], $run('2027-01-29 10:00', ['freq' => 'monthly', 'by' => 'weekday', 'count' => 4]));
        $this->assertSame(['2028-02-29', '2032-02-29'], $run('2028-02-29 10:00', ['freq' => 'yearly'], '2033-01-01'));
        // Every other day, until a date (inclusive); every 2 weeks on Fridays; a count with a skip-ahead start still counts from the first.
        $this->assertSame(['2027-01-01', '2027-01-03', '2027-01-05'], $run('2027-01-01 10:00', ['freq' => 'daily', 'interval' => 2, 'until' => '2027-01-05']));
        $this->assertSame(['2027-01-01', '2027-01-15', '2027-01-29'], $run('2027-01-01 10:00', ['freq' => 'weekly', 'interval' => 2, 'days' => ['FR']], '2027-02-01'));
        $later = [];
        foreach (Calendar::expand(new \DateTimeImmutable('2027-01-04 10:00', $tz), ['freq' => 'weekly', 'days' => ['MO', 'TH'], 'count' => 30], new \DateTimeImmutable('2030-01-01', $tz),
            new \DateTimeImmutable('2027-04-01', $tz)) as $d) {
            $later[] = $d->format('Y-m-d');
        }
        // 30 starts from 4 January (Mondays and Thursdays) end on 15 April: the skip-ahead didn't lose count.
        $this->assertSame(['2027-04-01', '2027-04-05', '2027-04-08', '2027-04-12', '2027-04-15'], $later);
    }

    public function testRemindersComeAsNotificationsOnceEach(): void
    {
        $id = $this->mine($this->sarah);
        $start = gmdate('Y-m-d\TH:i:00\Z', time() + 3600 + 600);
        $e = $this->cal()->saveEvent($this->sarah, ['calendar_id' => $id, 'title' => 'Call with Jo', 'location' => 'Zoom', 'start' => $start,
            'end' => gmdate('Y-m-d\TH:i:00\Z', strtotime($start) + 1800), 'tz' => 'UTC', 'reminders' => [60, 10]]);
        $next = $this->app->db->value('SELECT next_reminder_at FROM {cal_events} WHERE id = ?', [$e['id']]);
        $this->assertSame(gmdate('Y-m-d H:i:00', strtotime($start) - 3600), $next);
        $this->assertSame(0, $this->cal()->sendReminders(), 'not yet');

        $at = new \DateTimeImmutable(gmdate('Y-m-d H:i:s', strtotime($start) - 3590), new \DateTimeZone('UTC'));
        $this->assertSame(1, $this->cal()->sendReminders($at));
        $this->assertSame($this->sarah['id'], $this->pushed[0][0]);
        $this->assertSame('Call with Jo', $this->pushed[0][1]['title']);
        $this->assertMatchesRegularExpression('/^(Today|Tomorrow) \d\d:\d\d–\d\d:\d\d · Zoom$/', $this->pushed[0][1]['body']);
        $this->assertStringStartsWith('./#event=' . $e['id'] . ':', $this->pushed[0][1]['url']);
        $this->assertSame(0, $this->cal()->sendReminders($at), 'never twice');
        // The 10-minute one next, then none.
        $this->assertSame(gmdate('Y-m-d H:i:00', strtotime($start) - 600), $this->app->db->value('SELECT next_reminder_at FROM {cal_events} WHERE id = ?', [$e['id']]));
        $this->assertSame(1, $this->cal()->sendReminders($at->modify('+50 minutes')));
        $this->assertNull($this->app->db->value('SELECT next_reminder_at FROM {cal_events} WHERE id = ?', [$e['id']]));

        // Due runs them with the rest; a hidden calendar's reminders don't come.
        $this->app->db->run('UPDATE {cal_events} SET reminded_to = ?, next_reminder_at = ? WHERE id = ?', [gmdate('Y-m-d H:i:s', time() - 120), gmdate('Y-m-d H:i:s', time() - 60), $e['id']]);
        $this->app->db->run('UPDATE {cal_events} SET start_at = ?, end_at = ?, reminders = ? WHERE id = ?', [gmdate('Y-m-d H:i:s', time() + 540), gmdate('Y-m-d H:i:s', time() + 900), '10', $e['id']]);
        $due = new Due($this->app);
        $due->calendar = $this->cal();
        $this->pushed = [];
        $this->assertSame(1, $due->run()['reminded']);
        $this->app->db->run('UPDATE {cal_members} SET hidden = 1');
        $this->app->db->run('UPDATE {cal_events} SET reminded_to = ?, next_reminder_at = ? WHERE id = ?', [gmdate('Y-m-d H:i:s', time() - 120), gmdate('Y-m-d H:i:s', time() - 60), $e['id']]);
        $this->assertSame(0, $due->run()['reminded']);
    }

    public function testIcsImportExportAndFeedLinks(): void
    {
        $id = $this->mine($this->sarah);
        $ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:GMT Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T020000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n"
            . "BEGIN:VEVENT\r\nUID:abc-123@outlook\r\nSUMMARY:Quarterly review\\, Q4\r\nLOCATION:Room 2\r\nDESCRIPTION:Agenda:\\n1. Numbers\r\n"
            . "DTSTART;TZID=GMT Standard Time:20261210T140000\r\nDTEND;TZID=GMT Standard Time:20261210T153000\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT\r\n"
            . "BEGIN:VEVENT\r\nUID:bank-hol\r\nSUMMARY:Bank holiday\r\nDTSTART;VALUE=DATE:20261225\r\nEND:VEVENT\r\n"
            . "BEGIN:VEVENT\r\nUID:yoga\r\nSUMMARY:Yoga\r\nDTSTART:20261201T180000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3\r\nEND:VEVENT\r\n"
            . "BEGIN:VEVENT\r\nUID:gone\r\nSUMMARY:Cancelled\r\nSTATUS:CANCELLED\r\nDTSTART:20261201T180000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        $r = $this->cal()->import($this->sarah, $id, $ics);
        $this->assertSame([3, 0], [$r['added'], $r['updated']]);
        $this->assertSame(['Yoga 2026-12-01T18:00:00Z', 'Yoga 2026-12-08T18:00:00Z', 'Quarterly review, Q4 2026-12-10T14:00:00Z', 'Yoga 2026-12-15T18:00:00Z', 'Bank holiday 2026-12-25'],
            $this->starts($this->sarah, '2026-11-30T00:00:00Z', '2027-01-01T00:00:00Z'));
        $q = array_values(array_filter($this->cal()->eventsFor($this->sarah, '2026-12-10T00:00:00Z', '2026-12-11T00:00:00Z'), fn ($e) => $e['uid'] === 'abc-123@outlook'))[0];
        $this->assertSame(["Agenda:\n1. Numbers", 'Room 2', '2026-12-10T15:30:00Z', 'Europe/London'], [$q['notes'], $q['location'], $q['end'], $q['tz']]);
        // The same file again updates rather than doubling up.
        $this->assertSame([0, 3], array_values(array_intersect_key($this->cal()->import($this->sarah, $id, $ics), array_flip(['added', 'updated']))));
        $this->fails(fn () => $this->cal()->import($this->sarah, $id, 'not a calendar'), 422);

        // Out again, and back in, the same.
        $out = $this->cal()->ics($id, 'My calendar');
        $this->assertStringContainsString("SUMMARY:Quarterly review\\, Q4\r\n", $out);
        $this->assertStringContainsString("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3\r\n", $out);
        $this->assertStringContainsString("DTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261226\r\n", $out);
        $back = array_column(Calendar::parseIcs($out), null, 'uid');
        $this->assertSame(['Quarterly review, Q4', '2026-12-10T14:00:00Z', "Agenda:\n1. Numbers"], [$back['abc-123@outlook']['title'], $back['abc-123@outlook']['start'], $back['abc-123@outlook']['notes']]);

        // A private feed link: the same, until it's turned off or the person is.
        $url = $this->cal()->feed($this->sarah['id'], $id, 'show')['url'];
        $this->assertSame($url, $this->cal()->feed($this->sarah['id'], $id, 'show')['url'], 'the same link each time');
        $token = substr($url, strpos($url, '=') + 1);
        $this->assertSame($id, $this->cal()->byFeed($token)['id']);
        $this->assertNull($this->cal()->byFeed('x' . substr($token, 1)));
        $new = substr($this->cal()->feed($this->sarah['id'], $id, 'new')['url'], strlen($url) - strlen($token));
        $this->assertNull($this->cal()->byFeed($token), 'the old link stops');
        $this->assertSame($id, $this->cal()->byFeed($new)['id']);
        $this->app->db->run('UPDATE {users} SET disabled = 1 WHERE id = ?', [$this->sarah['id']]);
        $this->assertNull($this->cal()->byFeed($new));
        $this->fails(fn () => $this->cal()->feed($this->kim['id'], $id, 'show'), 404);
    }

    public function testInvitationsInEmailCanBeAdded(): void
    {
        $store = new Mailstore($this->app);
        $box = $store->createMailbox('support@acme.test');
        $store->grant($this->sarah['id'], $box);
        $invite = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:launch@partner\r\nSUMMARY:Launch call\r\nDTSTART:20261203T150000Z\r\nDTEND:20261203T160000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        $stored = $store->storeInbound($this->inbound(['attachments' => [['filename' => 'invite.ics', 'content_type' => 'text/calendar', 'size' => strlen($invite), 'content' => base64_encode($invite)]]]));
        $att = (int) $this->app->db->value('SELECT id FROM {attachments} WHERE message_id = ?', [$stored[0]['id']]);
        $this->assertSame(1, $this->cal()->import($this->sarah, $this->mine($this->sarah), $store->attachment($this->sarah['id'], $att)['content'])['added']);
        $this->assertSame(['Launch call 2026-12-03T15:00:00Z'], $this->starts($this->sarah, '2026-12-01T00:00:00Z', '2026-12-07T00:00:00Z'));
        // Someone without the mailbox can't read it.
        $this->expectException(HttpError::class);
        $store->attachment($this->kim['id'], $att);
    }
}
