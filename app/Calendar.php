<?php
declare(strict_types=1);

namespace Webmail;

/**
 * The calendar. Everyone has their own calendars (one, "My calendar", is made for them) and can share calendars with
 * the people they work with: a shared calendar has members who can see it, or see and change it, and its owner (and
 * administrators) decide who's on it.
 *
 * Events are timed (stored in UTC, with the time zone they were made in so a weekly 9:00 meeting stays at 9:00 when the
 * clocks change) or all-day (dates, the same everywhere). They can repeat (daily, weekly on chosen days, monthly on a
 * date or on, say, the second Tuesday, yearly), with single occurrences moved or deleted. Reminders come as
 * notifications, sent with the rest of the due work (Due). Titles, places and notes are encrypted like email.
 *
 * Each member can have a private feed link (calendar.php?t=…) to see a calendar in their phone's or computer's
 * calendar app. Events come in from .ics files and invitations in email.
 */
final class Calendar
{
    public const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0891b2', '#64748b'];
    public const MAX_CALENDARS = 50;
    public const MAX_REMINDERS = 5;
    /** No more than this many occurrences of one event in one view (a daily event over years, say). */
    private const MAX_OCCURRENCES = 1500;
    private const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
    private const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

    /** Sends a notification to someone: fn(int $userId, array $payload). Replaced in tests. */
    public ?\Closure $notifyUser = null;

    public function __construct(private App $app)
    {
        if (Notifier::supported()) {
            $this->notifyUser = function (int $userId, array $payload) use ($app) {
                (new Notifier($app))->notifyUser($userId, $payload);
            };
        }
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    // ------------------------------------------------------------------------------------------------ API

    public function route(string $action, string $method, array $user): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        $uid = (int) $user['id'];
        switch ("$method $action") {
            case 'GET calendar':
                Http::json(['calendars' => $this->calendars($user), 'people' => $this->people(), 'colors' => self::COLORS]);
            case 'POST calendar/save':
                Http::json($this->saveCalendar($user, $in), isset($in['id']) ? 200 : 201);
            case 'POST calendar/delete':
                $this->deleteCalendar($user, (int) ($in['id'] ?? 0));
                Http::json(['ok' => true]);
            case 'POST calendar/leave':
                $this->leave($user, (int) ($in['id'] ?? 0));
                Http::json(['ok' => true]);
            case 'POST calendar/show':
                $this->member($uid, (int) ($in['id'] ?? 0));
                $this->app->db->run('UPDATE {cal_members} SET hidden = ? WHERE calendar_id = ? AND user_id = ?', [empty($in['shown']) ? 1 : 0, (int) $in['id'], $uid]);
                Http::json(['ok' => true]);
            case 'POST calendar/feed':
                Http::json($this->feed($uid, (int) ($in['id'] ?? 0), (string) ($in['do'] ?? 'show')));
            case 'GET calendar/events':
                Http::json(['events' => $this->eventsFor($user, (string) ($_GET['from'] ?? ''), (string) ($_GET['to'] ?? ''))]);
            case 'GET calendar/event':
                Http::json($this->eventFor($user, (int) ($_GET['id'] ?? 0)));
            case 'POST calendar/event/save':
                Http::json($this->saveEvent($user, $in), empty($in['id']) ? 201 : 200);
            case 'POST calendar/event/delete':
                $this->deleteEvent($user, (int) ($in['id'] ?? 0), (string) ($in['scope'] ?? 'all'), isset($in['occurrence']) ? (string) $in['occurrence'] : null);
                Http::json(['ok' => true]);
            case 'POST calendar/import':
                $ics = isset($in['attachment']) ? (new Mailstore($this->app))->attachment($uid, (int) $in['attachment'])['content'] : (string) ($in['ics'] ?? '');
                Http::json($this->import($user, (int) ($in['calendar_id'] ?? 0), $ics));
            case 'POST calendar/preview':
                $ics = isset($in['attachment']) ? (new Mailstore($this->app))->attachment($uid, (int) $in['attachment'])['content'] : (string) ($in['ics'] ?? '');
                Http::json(['events' => array_slice(array_map(fn ($e) => array_intersect_key($e, array_flip(['title', 'location', 'start', 'end', 'all_day', 'tz', 'repeat'])),
                    self::parseIcs($ics)), 0, 20)]);
            case 'GET calendar/export':
                $id = (int) ($_GET['id'] ?? 0);
                $cal = $this->member($uid, $id);
                header('Content-Type: text/calendar; charset=utf-8');
                header('Content-Disposition: attachment; filename="' . (preg_replace('/[^\w.\- ]+/u', '_', $cal['name']) ?: 'calendar') . '.ics"');
                header('Cache-Control: no-store');
                echo $this->ics($id, $cal['name']);
                exit;
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    // ------------------------------------------------------------------------------------------------ calendars

    /** Everyone using the webmail (for sharing), by name. */
    public function people(): array
    {
        $c = $this->c();
        $out = [];
        foreach ($this->app->db->all('SELECT id, email_enc, name_enc FROM {users} WHERE disabled = 0') as $r) {
            $out[] = ['id' => (int) $r['id'], 'email' => (string) $c->decrypt($r['email_enc'], 'users.email'), 'name' => (string) ($c->decrypt($r['name_enc'], 'users.name') ?? '')];
        }
        usort($out, fn ($a, $b) => strnatcasecmp($a['name'] ?: $a['email'], $b['name'] ?: $b['email']));
        return $out;
    }

    /** Someone's calendars: their own and those shared with them, with their role on each. Makes "My calendar" if they have none. */
    public function calendars(array $user): array
    {
        $uid = (int) $user['id'];
        $rows = $this->app->db->all('SELECT c.*, m.role, m.hidden, m.feed_enc FROM {cal_members} m JOIN {cal_calendars} c ON c.id = m.calendar_id WHERE m.user_id = ? ORDER BY c.kind, c.id', [$uid]);
        if (!array_filter($rows, fn ($r) => $r['kind'] === 'personal' && $r['role'] === 'owner')) {
            $this->create($uid, 'personal', 'My calendar', self::COLORS[0]);
            return $this->calendars($user);
        }
        $c = $this->c();
        $out = [];
        foreach ($rows as $r) {
            $cal = ['id' => (int) $r['id'], 'kind' => $r['kind'], 'name' => (string) $c->decrypt($r['name_enc'], 'cal.name'), 'color' => $r['color'], 'role' => $r['role'],
                'shown' => !$r['hidden'], 'feed' => $r['feed_enc'] !== null, 'can_edit' => $r['role'] !== 'view', 'can_manage' => $this->canManage($user, $r)];
            if ($r['kind'] === 'shared') {
                $cal['members'] = $this->members((int) $r['id']);
            }
            $out[] = $cal;
        }
        return $out;
    }

    private function canManage(array $user, array $row): bool
    {
        return $row['role'] === 'owner' || ($row['kind'] === 'shared' && $user['role'] === 'admin');
    }

    /** Who's on a shared calendar. */
    public function members(int $calendarId): array
    {
        $c = $this->c();
        $out = [];
        foreach ($this->app->db->all('SELECT m.user_id, m.role, u.email_enc, u.name_enc FROM {cal_members} m JOIN {users} u ON u.id = m.user_id WHERE m.calendar_id = ? ORDER BY m.role = "owner" DESC, m.added_at, m.user_id',
            [$calendarId]) as $r) {
            $out[] = ['user_id' => (int) $r['user_id'], 'role' => $r['role'], 'email' => (string) $c->decrypt($r['email_enc'], 'users.email'),
                'name' => (string) ($c->decrypt($r['name_enc'], 'users.name') ?? '')];
        }
        return $out;
    }

    public function create(int $ownerId, string $kind, string $name, string $color): int
    {
        return $this->app->db->tx(function () use ($ownerId, $kind, $name, $color) {
            $id = $this->app->db->insert('INSERT INTO {cal_calendars} (kind, owner_id, name_enc, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$kind, $ownerId, $this->c()->encrypt($name, 'cal.name'), $color, App::now(), App::now()]);
            $this->app->db->run('INSERT INTO {cal_members} (calendar_id, user_id, role, added_at) VALUES (?, ?, ?, ?)', [$id, $ownerId, 'owner', App::now()]);
            return $id;
        });
    }

    /** The calendar, if this person is on it (with their role), else 404. */
    public function member(int $userId, int $calendarId): array
    {
        $r = $this->app->db->one('SELECT c.*, m.role FROM {cal_members} m JOIN {cal_calendars} c ON c.id = m.calendar_id WHERE m.user_id = ? AND m.calendar_id = ?', [$userId, $calendarId]);
        if (!$r) {
            throw new HttpError(404, 'Calendar not found', 'not_found');
        }
        $r['name'] = (string) $this->c()->decrypt($r['name_enc'], 'cal.name');
        return $r;
    }

    /** A calendar this person can manage (rename, recolour, share, delete): its owner, or an administrator for a shared one. */
    private function managed(array $user, int $calendarId): array
    {
        $r = $this->app->db->one('SELECT c.*, m.role FROM {cal_calendars} c LEFT JOIN {cal_members} m ON m.calendar_id = c.id AND m.user_id = ? WHERE c.id = ?', [$user['id'], $calendarId]);
        if (!$r || ($r['role'] === null && !($r['kind'] === 'shared' && $user['role'] === 'admin'))) {
            throw new HttpError(404, 'Calendar not found', 'not_found');
        }
        if (!$this->canManage($user, $r)) {
            throw new HttpError(403, $r['kind'] === 'shared' ? "Only the calendar's owner or an administrator can change it" : 'Not your calendar', 'forbidden');
        }
        return $r;
    }

    public function saveCalendar(array $user, array $in): array
    {
        $uid = (int) $user['id'];
        $name = mb_substr(trim(preg_replace('/\s+/u', ' ', (string) ($in['name'] ?? '')) ?? ''), 0, 80);
        if ($name === '') {
            throw new HttpError(422, 'Give the calendar a name', 'bad_calendar');
        }
        $color = in_array($in['color'] ?? null, self::COLORS, true) ? $in['color'] : self::COLORS[0];
        $id = isset($in['id']) ? (int) $in['id'] : null;
        if ($id) {
            $cal = $this->managed($user, $id);
            $this->app->db->run('UPDATE {cal_calendars} SET name_enc = ?, color = ?, updated_at = ? WHERE id = ?', [$this->c()->encrypt($name, 'cal.name'), $color, App::now(), $id]);
            $kind = $cal['kind'];
        } else {
            $kind = ($in['kind'] ?? 'personal') === 'shared' ? 'shared' : 'personal';
            if ((int) $this->app->db->value("SELECT COUNT(*) FROM {cal_members} WHERE user_id = ? AND role = 'owner'", [$uid]) >= self::MAX_CALENDARS) {
                throw new HttpError(422, 'At most ' . self::MAX_CALENDARS . ' calendars', 'too_many_calendars');
            }
            $id = $this->create($uid, $kind, $name, $color);
        }
        if ($kind === 'shared' && isset($in['members']) && is_array($in['members'])) {
            $this->setMembers($user, $id, $in['members']);
        }
        foreach ($this->calendars($user) as $c) {
            if ($c['id'] === $id) {
                return $c;
            }
        }
        return ['id' => $id]; // an administrator managing a shared calendar they aren't on
    }

    /** A shared calendar's members: [{user_id, role: edit|view}]. Its owner stays its owner. New members are told. */
    private function setMembers(array $user, int $calendarId, array $list): void
    {
        $owner = (int) $this->app->db->value('SELECT owner_id FROM {cal_calendars} WHERE id = ?', [$calendarId]);
        $active = array_column($this->people(), null, 'id');
        $want = [];
        foreach ($list as $m) {
            $id = (int) ($m['user_id'] ?? 0);
            if ($id && $id !== $owner && isset($active[$id])) {
                $want[$id] = ($m['role'] ?? 'edit') === 'view' ? 'view' : 'edit';
            }
        }
        $now = $this->app->db->all("SELECT user_id, role FROM {cal_members} WHERE calendar_id = ? AND role <> 'owner'", [$calendarId]);
        $had = array_column($now, 'role', 'user_id');
        foreach (array_diff_key($had, $want) as $id => $_) {
            $this->app->db->run('DELETE FROM {cal_members} WHERE calendar_id = ? AND user_id = ?', [$calendarId, $id]);
        }
        $name = (string) $this->c()->decrypt($this->app->db->value('SELECT name_enc FROM {cal_calendars} WHERE id = ?', [$calendarId]), 'cal.name');
        foreach ($want as $id => $role) {
            if (!isset($had[$id])) {
                $this->app->db->run('INSERT INTO {cal_members} (calendar_id, user_id, role, added_at) VALUES (?, ?, ?, ?)', [$calendarId, $id, $role, App::now()]);
                $this->notify($id, ['title' => 'Calendar shared with you', 'body' => ($user['name'] ?: $user['email']) . " added you to $name", 'tag' => "cal$calendarId", 'url' => './#calendar']);
            } elseif ($had[$id] !== $role) {
                $this->app->db->run('UPDATE {cal_members} SET role = ? WHERE calendar_id = ? AND user_id = ?', [$role, $calendarId, $id]);
            }
        }
    }

    public function deleteCalendar(array $user, int $id): void
    {
        $cal = $this->managed($user, $id);
        if ($cal['kind'] === 'personal' && (int) $this->app->db->value("SELECT COUNT(*) FROM {cal_calendars} WHERE owner_id = ? AND kind = 'personal'", [$cal['owner_id']]) <= 1) {
            throw new HttpError(422, 'This is your only calendar: make another before deleting it', 'last_calendar');
        }
        $this->app->db->run('DELETE FROM {cal_calendars} WHERE id = ?', [$id]);
    }

    public function leave(array $user, int $id): void
    {
        $cal = $this->member((int) $user['id'], $id);
        if ($cal['role'] === 'owner') {
            throw new HttpError(422, $cal['kind'] === 'shared' ? "You own this calendar: delete it, or ask an administrator to" : "It's your own calendar", 'owner');
        }
        $this->app->db->run('DELETE FROM {cal_members} WHERE calendar_id = ? AND user_id = ?', [$id, $user['id']]);
    }

    /** A member's private feed link: show it (making one the first time), make a new one, or turn it off. */
    public function feed(int $userId, int $calendarId, string $do): array
    {
        $this->member($userId, $calendarId);
        $c = $this->c();
        $row = $this->app->db->one('SELECT feed_enc FROM {cal_members} WHERE calendar_id = ? AND user_id = ?', [$calendarId, $userId]);
        if ($do === 'off') {
            $this->app->db->run('UPDATE {cal_members} SET feed_bidx = NULL, feed_enc = NULL WHERE calendar_id = ? AND user_id = ?', [$calendarId, $userId]);
            return ['url' => null];
        }
        $token = $row['feed_enc'] !== null && $do !== 'new' ? (string) $c->decrypt($row['feed_enc'], 'cal.feed') : null;
        if ($token === null) {
            $token = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
            $this->app->db->run('UPDATE {cal_members} SET feed_bidx = ?, feed_enc = ? WHERE calendar_id = ? AND user_id = ?',
                [$c->blindIndex($token, 'cal.feed'), $c->encrypt($token, 'cal.feed'), $calendarId, $userId]);
        }
        return ['url' => $this->app->baseUrl() . '/calendar.php?t=' . $token];
    }

    /** The calendar a feed link is for (its id and name), or null. The member must still be on it and active. */
    public function byFeed(string $token): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{32}$/', $token)) {
            return null;
        }
        $r = $this->app->db->one('SELECT c.id, c.name_enc FROM {cal_members} m JOIN {cal_calendars} c ON c.id = m.calendar_id JOIN {users} u ON u.id = m.user_id
            WHERE m.feed_bidx = ? AND u.disabled = 0', [$this->c()->blindIndex($token, 'cal.feed')]);
        return $r ? ['id' => (int) $r['id'], 'name' => (string) $this->c()->decrypt($r['name_enc'], 'cal.name')] : null;
    }

    // ------------------------------------------------------------------------------------------------ events

    /** The occurrences in [from, to) on the calendars someone sees (shown or not: the page filters). */
    public function eventsFor(array $user, string $from, string $to): array
    {
        $f = self::instant($from);
        $t = self::instant($to);
        if (!$f || !$t || $t <= $f || $t->getTimestamp() - $f->getTimestamp() > 400 * 86400) {
            throw new HttpError(422, 'Give a range of up to 400 days: from and to', 'bad_range');
        }
        $roles = array_column($this->app->db->all('SELECT calendar_id, role FROM {cal_members} WHERE user_id = ?', [$user['id']]), 'role', 'calendar_id');
        if (!$roles) {
            return [];
        }
        // All-day events are dates, the same everywhere: a day either side covers every time zone.
        $f2 = $f->modify('-1 day')->format('Y-m-d H:i:s');
        $t2 = $t->modify('+1 day')->format('Y-m-d H:i:s');
        $marks = implode(',', array_fill(0, count($roles), '?'));
        $rows = $this->app->db->all("SELECT * FROM {cal_events} WHERE calendar_id IN ($marks) AND start_at < ? AND (end_at > ? OR (repeat_json IS NOT NULL AND (repeat_until IS NULL OR repeat_until > ?)))",
            array_merge(array_keys($roles), [$t2, $f2, $f2]));
        $names = $this->names(array_merge(array_column($rows, 'created_by'), array_column($rows, 'updated_by')));
        $out = [];
        foreach ($rows as $r) {
            $e = $this->present($r, $names);
            $e['can_edit'] = $roles[$r['calendar_id']] !== 'view';
            foreach ($this->occurrences($r, $f, $t) as [$s, $en, $key]) {
                $out[] = $e + ['occurrence' => $key, 'start' => $s, 'end' => $en];
            }
        }
        usort($out, fn ($a, $b) => [$a['start'], $a['end']] <=> [$b['start'], $b['end']]);
        return $out;
    }

    /** One event (its first occurrence's times), for opening it from a reminder. */
    public function eventFor(array $user, int $id): array
    {
        $r = $this->eventRow($user, $id, false);
        $e = $this->present($r, $this->names([$r['created_by'], $r['updated_by']]));
        [$s, $en] = $this->times($r);
        return $e + ['can_edit' => $r['role'] !== 'view', 'occurrence' => $r['all_day'] ? substr($s, 0, 10) : $s, 'start' => $s, 'end' => $en];
    }

    private function eventRow(array $user, int $id, bool $edit): array
    {
        $r = $this->app->db->one('SELECT e.*, m.role FROM {cal_events} e JOIN {cal_members} m ON m.calendar_id = e.calendar_id AND m.user_id = ? WHERE e.id = ?', [$user['id'], $id]);
        if (!$r) {
            throw new HttpError(404, 'Event not found', 'not_found');
        }
        if ($edit && $r['role'] === 'view') {
            throw new HttpError(403, 'You can see this calendar but not change it', 'forbidden');
        }
        return $r;
    }

    private function names(array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
        if (!$ids) {
            return [];
        }
        $out = [];
        foreach ($this->app->db->all('SELECT id, email_enc, name_enc FROM {users} WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')', $ids) as $u) {
            $out[(int) $u['id']] = (string) ($this->c()->decrypt($u['name_enc'], 'users.name') ?: $this->c()->decrypt($u['email_enc'], 'users.email'));
        }
        return $out;
    }

    private function present(array $r, array $names): array
    {
        $c = $this->c();
        return ['id' => (int) $r['id'], 'calendar_id' => (int) $r['calendar_id'], 'uid' => $r['uid'], 'title' => (string) $c->decrypt($r['title_enc'], 'cal.title'),
            'location' => (string) ($c->decrypt($r['location_enc'], 'cal.location') ?? ''), 'notes' => (string) ($c->decrypt($r['notes_enc'], 'cal.notes') ?? ''),
            'all_day' => (bool) $r['all_day'], 'tz' => $r['tz'], 'repeat' => $r['repeat_json'] ? json_decode($r['repeat_json'], true) : null,
            'reminders' => $r['reminders'] !== null && $r['reminders'] !== '' ? array_map('intval', explode(',', $r['reminders'])) : [],
            'color' => $r['color'], 'created_by' => $names[(int) $r['created_by']] ?? null, 'updated_by' => $names[(int) $r['updated_by']] ?? null,
            'updated_at' => gmdate('c', strtotime($r['updated_at'] . ' UTC'))];
    }

    /** An event's first start and end: ISO instants (timed) or dates (all-day, the end the day after the last). */
    private function times(array $r): array
    {
        if ($r['all_day']) {
            return [substr($r['start_at'], 0, 10), substr($r['end_at'], 0, 10)];
        }
        return [gmdate('Y-m-d\TH:i:s\Z', strtotime($r['start_at'] . ' UTC')), gmdate('Y-m-d\TH:i:s\Z', strtotime($r['end_at'] . ' UTC'))];
    }

    /**
     * The occurrences of an event that overlap [from, to): [start, end, key] each, start and end as in times(). The key
     * names the occurrence (its original start) for moving or deleting just that one.
     */
    public function occurrences(array $r, \DateTimeImmutable $from, \DateTimeImmutable $to, int $max = self::MAX_OCCURRENCES): array
    {
        $allDay = (bool) $r['all_day'];
        $tz = $allDay ? new \DateTimeZone('UTC') : self::zone($r['tz']);
        $start = (new \DateTimeImmutable($r['start_at'], new \DateTimeZone('UTC')))->setTimezone($tz);
        $length = strtotime($r['end_at'] . ' UTC') - strtotime($r['start_at'] . ' UTC');
        $fmt = fn (\DateTimeImmutable $d) => $allDay ? $d->format('Y-m-d') : $d->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
        // All-day events are compared a day wider: the page shows them by the date, wherever it is.
        $lo = $allDay ? $from->modify('-1 day') : $from;
        $hi = $allDay ? $to->modify('+1 day') : $to;
        $out = [];
        $repeat = $r['repeat_json'] ? json_decode($r['repeat_json'], true) : null;
        $ex = $r['exdates'] ? array_flip(json_decode($r['exdates'], true) ?: []) : [];
        foreach ($repeat ? self::expand($start, $repeat, $hi, $lo->modify("-$length seconds")) : [$start] as $s) {
            if ($s >= $hi) {
                break;
            }
            $e = $allDay ? $s->modify("+$length seconds") : (new \DateTimeImmutable('@' . ($s->getTimestamp() + $length)));
            $key = $fmt($s);
            if ($e <= $lo || isset($ex[$key])) {
                continue;
            }
            $out[] = [$key, $fmt($e), $key];
            if (count($out) >= $max) {
                break;
            }
        }
        return $out;
    }

    /**
     * The starts of a repeating event, in its own time zone, from its first, up to (not including) $until. Starts before
     * $after are skipped quickly where the rule allows (daily and weekly), but still counted for "after N times".
     *
     * @return \Generator<\DateTimeImmutable>
     */
    public static function expand(\DateTimeImmutable $start, array $rule, \DateTimeImmutable $until, ?\DateTimeImmutable $after = null): \Generator
    {
        $freq = $rule['freq'] ?? 'weekly';
        $n = max(1, min(999, (int) ($rule['interval'] ?? 1)));
        $count = isset($rule['count']) ? max(1, (int) $rule['count']) : null;
        $tz = $start->getTimezone();
        $last = isset($rule['until']) ? new \DateTimeImmutable($rule['until'] . ' 23:59:59', $tz) : null;
        $time = $start->format('H:i:s');
        $at = fn (string $date) => new \DateTimeImmutable("$date $time", $tz);
        $seen = 0;
        $period = 0;
        $days = [];
        if ($freq === 'weekly') {
            $days = array_values(array_intersect(self::DAYS, $rule['days'] ?? [])) ?: [self::DAYS[(int) $start->format('N') - 1]];
        }
        // Skip whole periods before $after (daily and weekly have a fixed number of starts in each).
        if ($after && in_array($freq, ['daily', 'weekly'], true)) {
            $span = $freq === 'daily' ? $n : 7 * $n;
            $gap = intdiv(max(0, (int) floor(($after->getTimestamp() - $start->getTimestamp()) / 86400)), $span) - 1;
            if ($gap > 0) {
                $period = $gap;
                $seen = $gap * ($freq === 'daily' ? 1 : count($days));
                if ($freq === 'weekly') {
                    // Starts in the first week before the event's own start don't count.
                    $seen -= count(array_filter($days, fn ($d) => array_search($d, self::DAYS, true) < (int) $start->format('N') - 1));
                }
            }
        }
        $monday = $start->modify('-' . ((int) $start->format('N') - 1) . ' days')->format('Y-m-d');
        $utc = new \DateTimeZone('UTC');
        $guard = 0;
        while ($guard++ < 50000) {
            $batch = [];
            switch ($freq) {
                case 'daily':
                    $batch[] = $at($start->modify('+' . ($period * $n) . ' days')->format('Y-m-d'));
                    break;
                case 'weekly':
                    $week = (new \DateTimeImmutable($monday, $utc))->modify('+' . ($period * $n * 7) . ' days');
                    foreach ($days as $d) {
                        $batch[] = $at($week->modify('+' . array_search($d, self::DAYS, true) . ' days')->format('Y-m-d'));
                    }
                    break;
                case 'monthly':
                    $m = (new \DateTimeImmutable($start->format('Y-m-01'), $utc))->modify('+' . ($period * $n) . ' months');
                    if (($rule['by'] ?? 'date') === 'weekday') {
                        $date = self::nthWeekday($m, (int) $start->format('N'), self::weekOfMonth($start));
                        if ($date) {
                            $batch[] = $at($date);
                        }
                    } elseif ((int) $start->format('j') <= (int) $m->format('t')) {
                        $batch[] = $at($m->format('Y-m-') . $start->format('d'));
                    }
                    break;
                case 'yearly':
                    $y = (int) $start->format('Y') + $period * $n;
                    if (checkdate((int) $start->format('n'), (int) $start->format('j'), $y)) {
                        $batch[] = $at($y . $start->format('-m-d'));
                    }
                    break;
                default:
                    return;
            }
            $period++;
            foreach ($batch as $s) {
                if ($s < $start) {
                    continue;
                }
                if (($count !== null && $seen >= $count) || ($last && $s > $last) || $s >= $until) {
                    return;
                }
                $seen++;
                if ($after === null || $s >= $after) {
                    yield $s;
                }
            }
        }
    }

    /** Which week of its month a date is in: 1 to 4, or -1 for the last (the fifth Tuesday, or the last one whatever). */
    private static function weekOfMonth(\DateTimeImmutable $d): int
    {
        $n = intdiv((int) $d->format('j') - 1, 7) + 1;
        return (int) $d->format('j') + 7 > (int) $d->format('t') ? -1 : $n;
    }

    /** The date of the nth (or last, -1) weekday ($dow 1–7, Monday first) of a month, or null when there's no such day. */
    private static function nthWeekday(\DateTimeImmutable $month, int $dow, int $nth): ?string
    {
        if ($nth === -1) {
            $d = new \DateTimeImmutable($month->format('Y-m-t'));
            return $d->modify('-' . (((int) $d->format('N') - $dow + 7) % 7) . ' days')->format('Y-m-d');
        }
        $first = new \DateTimeImmutable($month->format('Y-m-01'));
        $d = $first->modify('+' . (($dow - (int) $first->format('N') + 7) % 7 + ($nth - 1) * 7) . ' days');
        return $d->format('m') === $first->format('m') ? $d->format('Y-m-d') : null;
    }

    public static function zone(?string $tz): \DateTimeZone
    {
        try {
            return new \DateTimeZone($tz ?: 'UTC');
        } catch (\Throwable) {
            return new \DateTimeZone('UTC');
        }
    }

    /** An ISO date or instant as a UTC moment, or null. */
    private static function instant(string $v): ?\DateTimeImmutable
    {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/', $v)) {
            return null;
        }
        try {
            return (new \DateTimeImmutable($v, new \DateTimeZone('UTC')))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Throwable) {
            return null;
        }
    }

    /** A repeat rule from the page, checked; null for none. */
    public static function rule(mixed $r): ?array
    {
        if (!is_array($r) || !in_array($r['freq'] ?? null, self::FREQS, true)) {
            return null;
        }
        $out = ['freq' => $r['freq'], 'interval' => max(1, min(99, (int) ($r['interval'] ?? 1)))];
        if ($r['freq'] === 'weekly' && !empty($r['days']) && is_array($r['days'])) {
            $out['days'] = array_values(array_intersect(self::DAYS, $r['days']));
        }
        if ($r['freq'] === 'monthly' && ($r['by'] ?? '') === 'weekday') {
            $out['by'] = 'weekday';
        }
        if (!empty($r['until']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $r['until'])) {
            $out['until'] = (string) $r['until'];
        } elseif (!empty($r['count'])) {
            $out['count'] = max(1, min(999, (int) $r['count']));
        }
        return $out;
    }

    /**
     * Make or change an event. For one occurrence of a repeating event (scope "this"), that occurrence is taken out of
     * the series and saved as an event of its own; "following" ends the series before it and starts a new one.
     */
    public function saveEvent(array $user, array $in): array
    {
        $uid = (int) $user['id'];
        $calendarId = (int) ($in['calendar_id'] ?? 0);
        $cal = $this->member($uid, $calendarId);
        if ($cal['role'] === 'view') {
            throw new HttpError(403, 'You can see this calendar but not change it', 'forbidden');
        }
        $f = $this->fields($in);
        $id = !empty($in['id']) ? (int) $in['id'] : null;
        $scope = (string) ($in['scope'] ?? 'all');
        if ($id) {
            $old = $this->eventRow($user, $id, true);
            if ($old['repeat_json'] && $scope !== 'all' && isset($in['occurrence'])) {
                $occ = (string) $in['occurrence'];
                $this->cut($old, $occ, $scope);
                if ($scope === 'this') {
                    $f['repeat_json'] = null;
                    $f['repeat_until'] = null;
                }
                $id = null; // a new event from here
                $f['uid'] = $scope === 'this' ? $old['uid'] . '-' . preg_replace('/\W/', '', $occ) : self::newUid();
            } else {
                // Moved to another calendar: the person must be able to change that one too (checked above), and this one.
                $this->app->db->run('UPDATE {cal_events} SET calendar_id = ?, title_enc = ?, location_enc = ?, notes_enc = ?, all_day = ?, start_at = ?, end_at = ?, tz = ?,
                    repeat_json = ?, repeat_until = ?, exdates = ?, reminders = ?, color = ?, updated_by = ?, updated_at = ?, reminded_to = ?, next_reminder_at = NULL WHERE id = ?',
                    [$calendarId, $f['title_enc'], $f['location_enc'], $f['notes_enc'], $f['all_day'], $f['start_at'], $f['end_at'], $f['tz'], $f['repeat_json'], $f['repeat_until'],
                        // A changed rule or start keeps no old exceptions; just a new title etc. keeps them.
                        $old['repeat_json'] === $f['repeat_json'] && $old['start_at'] === $f['start_at'] ? $old['exdates'] : null,
                        $f['reminders'], $f['color'], $uid, App::now(), App::now(), $id]);
            }
        }
        if (!$id) {
            if ((int) $this->app->db->value('SELECT COUNT(*) FROM {cal_events} WHERE calendar_id = ?', [$calendarId]) >= 50000) {
                throw new HttpError(422, 'This calendar is full (50,000 events)', 'too_many_events');
            }
            $id = $this->insert($calendarId, $f + ['uid' => $f['uid'] ?? self::newUid()], $uid);
        }
        $this->scheduleReminder($id);
        return $this->eventFor($user, $id);
    }

    public static function newUid(): string
    {
        return bin2hex(random_bytes(16)) . '@webmail';
    }

    private function insert(int $calendarId, array $f, ?int $uid): int
    {
        return $this->app->db->insert('INSERT INTO {cal_events} (calendar_id, uid, title_enc, location_enc, notes_enc, all_day, start_at, end_at, tz, repeat_json, repeat_until, exdates,
            reminders, color, created_by, updated_by, created_at, updated_at, reminded_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$calendarId, mb_substr($f['uid'], 0, 255), $f['title_enc'], $f['location_enc'], $f['notes_enc'], $f['all_day'], $f['start_at'], $f['end_at'], $f['tz'], $f['repeat_json'],
                $f['repeat_until'], $f['exdates'] ?? null, $f['reminders'], $f['color'], $uid, $uid, App::now(), App::now(), App::now()]);
    }

    /** Take one occurrence out of a series ("this"), or end the series before it ("following"). */
    private function cut(array $old, string $occ, string $scope): void
    {
        if ($scope === 'following') {
            $tz = $old['all_day'] ? new \DateTimeZone('UTC') : self::zone($old['tz']);
            $day = (new \DateTimeImmutable($occ, new \DateTimeZone('UTC')))->setTimezone($tz)->modify('-1 day')->format('Y-m-d');
            $rule = json_decode($old['repeat_json'], true);
            unset($rule['count']);
            $rule['until'] = $day;
            $first = $old['all_day'] ? substr($old['start_at'], 0, 10) : gmdate('Y-m-d\TH:i:s\Z', strtotime($old['start_at'] . ' UTC'));
            if ($occ <= $first) {
                $this->app->db->run('DELETE FROM {cal_events} WHERE id = ?', [$old['id']]); // from the first one: the whole series
                return;
            }
            $this->app->db->run('UPDATE {cal_events} SET repeat_json = ?, repeat_until = ?, updated_at = ? WHERE id = ?',
                [json_encode($rule), $day . ' 23:59:59', App::now(), $old['id']]);
            return;
        }
        $ex = $old['exdates'] ? json_decode($old['exdates'], true) : [];
        $ex[] = $occ;
        $this->app->db->run('UPDATE {cal_events} SET exdates = ?, updated_at = ? WHERE id = ?', [json_encode(array_values(array_unique($ex))), App::now(), $old['id']]);
    }

    /** An event's fields from the page, checked and encrypted, as columns. */
    private function fields(array $in): array
    {
        $c = $this->c();
        $line = fn ($v, $max) => mb_substr(trim(preg_replace('/\s+/u', ' ', preg_replace('/[^\P{C}]/u', '', (string) $v) ?? '') ?? ''), 0, $max);
        $title = $line($in['title'] ?? '', 200);
        if ($title === '') {
            $title = '(no title)';
        }
        $allDay = !empty($in['all_day']);
        $tz = self::zone((string) ($in['tz'] ?? 'UTC'))->getName();
        if ($allDay) {
            $s = (string) ($in['start'] ?? '');
            $e = (string) ($in['end'] ?? '');
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $e) || !strtotime($s) || !strtotime($e)) {
                throw new HttpError(422, 'Choose the dates', 'bad_event');
            }
            if ($e <= $s) {
                $e = (new \DateTimeImmutable($s))->modify('+1 day')->format('Y-m-d'); // the end is the day after the last
            }
            $start = "$s 00:00:00";
            $end = "$e 00:00:00";
        } else {
            $s = self::instant((string) ($in['start'] ?? ''));
            $e = self::instant((string) ($in['end'] ?? ''));
            if (!$s || !$e) {
                throw new HttpError(422, 'Choose when it starts and ends', 'bad_event');
            }
            if ($e <= $s) {
                throw new HttpError(422, 'It has to end after it starts', 'bad_event');
            }
            $start = $s->format('Y-m-d H:i:s');
            $end = $e->format('Y-m-d H:i:s');
        }
        if (strtotime("$end UTC") - strtotime("$start UTC") > 366 * 86400) {
            throw new HttpError(422, 'An event can last at most a year', 'bad_event');
        }
        $rule = self::rule($in['repeat'] ?? null);
        $until = null;
        if ($rule) {
            if (isset($rule['until'])) {
                $until = $rule['until'] . ' 23:59:59';
            } elseif (isset($rule['count'])) {
                // When the last one ends, for finding events by date.
                $tzObj = $allDay ? new \DateTimeZone('UTC') : self::zone($tz);
                $first = (new \DateTimeImmutable($start, new \DateTimeZone('UTC')))->setTimezone($tzObj);
                $lastStart = null;
                foreach (self::expand($first, $rule, new \DateTimeImmutable('+200 years')) as $x) {
                    $lastStart = $x;
                }
                $until = $lastStart ? gmdate('Y-m-d H:i:s', $lastStart->getTimestamp() + strtotime("$end UTC") - strtotime("$start UTC")) : $end;
            }
        }
        $reminders = [];
        foreach ((array) ($in['reminders'] ?? []) as $m) {
            if (is_numeric($m) && (int) $m >= 0 && (int) $m <= 40320) {
                $reminders[] = (int) $m;
            }
        }
        $reminders = array_slice(array_values(array_unique($reminders)), 0, self::MAX_REMINDERS);
        sort($reminders);
        $notes = mb_substr(str_replace("\r\n", "\n", (string) ($in['notes'] ?? '')), 0, 20000);
        $location = $line($in['location'] ?? '', 300);
        return [
            'title_enc' => $c->encrypt($title, 'cal.title'), 'location_enc' => $c->encrypt($location === '' ? null : $location, 'cal.location'),
            'notes_enc' => $c->encrypt(trim($notes) === '' ? null : $notes, 'cal.notes'), 'all_day' => $allDay ? 1 : 0, 'start_at' => $start, 'end_at' => $end,
            'tz' => $tz, 'repeat_json' => $rule ? json_encode($rule) : null, 'repeat_until' => $until,
            'reminders' => $reminders ? implode(',', $reminders) : null, 'color' => in_array($in['color'] ?? null, self::COLORS, true) ? $in['color'] : null,
        ];
    }

    public function deleteEvent(array $user, int $id, string $scope, ?string $occurrence): void
    {
        $old = $this->eventRow($user, $id, true);
        if ($old['repeat_json'] && $occurrence !== null && in_array($scope, ['this', 'following'], true)) {
            $this->cut($old, $occurrence, $scope);
            return;
        }
        $this->app->db->run('DELETE FROM {cal_events} WHERE id = ?', [$id]);
    }

    // ------------------------------------------------------------------------------------------------ reminders

    /** Works out when an event's next reminder is due (after the last one sent), or none. */
    public function scheduleReminder(int $eventId): void
    {
        $r = $this->app->db->one('SELECT * FROM {cal_events} WHERE id = ?', [$eventId]);
        if (!$r) {
            return;
        }
        $next = $this->nextReminder($r, new \DateTimeImmutable(($r['reminded_to'] ?? App::now()) . ' UTC'));
        $this->app->db->run('UPDATE {cal_events} SET next_reminder_at = ? WHERE id = ?', [$next?->format('Y-m-d H:i:s'), $eventId]);
    }

    /** Reminders after $after, soonest first: [when, occurrence key, start]. An all-day event's are counted back from 9:00 on its day. */
    private function reminderTimes(array $r, \DateTimeImmutable $after, int $limit): array
    {
        if ($r['reminders'] === null || $r['reminders'] === '') {
            return [];
        }
        $mins = array_map('intval', explode(',', $r['reminders']));
        $longest = max($mins);
        $out = [];
        $horizon = $after->modify('+' . ($longest + 60 * 24 * 400) . ' minutes');
        foreach ($this->occurrences($r, $after, $horizon, 200) as [$s, , $key]) {
            $start = $r['all_day'] ? new \DateTimeImmutable("$s 09:00:00", self::zone($r['tz'])) : new \DateTimeImmutable($s);
            foreach ($mins as $m) {
                $at = $start->modify("-$m minutes");
                if ($at > $after) {
                    $out[] = [$at, $key, $s];
                }
            }
            if (count($out) >= $limit) {
                break;
            }
        }
        usort($out, fn ($a, $b) => $a[0] <=> $b[0]);
        return $out;
    }

    private function nextReminder(array $r, \DateTimeImmutable $after): ?\DateTimeImmutable
    {
        // Occurrences from a little before $after: a reminder can be due before its event (up to 4 weeks).
        $times = $this->reminderTimes($r, $after, 20);
        return $times[0][0] ?? null;
    }

    public function remindersDue(): bool
    {
        return (bool) $this->app->db->value('SELECT 1 FROM {cal_events} WHERE next_reminder_at IS NOT NULL AND next_reminder_at <= ? LIMIT 1', [App::now()]);
    }

    /** Send the reminders that are due (from Due). Returns how many people were reminded. */
    public function sendReminders(?\DateTimeImmutable $now = null): int
    {
        $now ??= new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $sent = 0;
        foreach ($this->app->db->all('SELECT * FROM {cal_events} WHERE next_reminder_at IS NOT NULL AND next_reminder_at <= ? LIMIT 200', [$now->format('Y-m-d H:i:s')]) as $r) {
            $from = new \DateTimeImmutable(($r['reminded_to'] ?? $r['created_at']) . ' UTC');
            $title = (string) $this->c()->decrypt($r['title_enc'], 'cal.title');
            $location = (string) ($this->c()->decrypt($r['location_enc'], 'cal.location') ?? '');
            $done = [];
            foreach ($this->reminderTimes($r, $from->modify('-1 second'), 50) as [$at, $key, $s]) {
                if ($at > $now) {
                    break;
                }
                // A reminder more than an hour late (the server was off, say) isn't worth sending; one per occurrence.
                if ($now->getTimestamp() - $at->getTimestamp() > 3600 || isset($done[$key])) {
                    continue;
                }
                $done[$key] = true;
                $payload = ['title' => $title, 'body' => $this->when($r, $s) . ($location !== '' ? " · $location" : ''), 'tag' => 'ev' . $r['id'] . '-' . $key,
                    'url' => './#event=' . $r['id'] . ':' . rawurlencode($key)];
                foreach ($this->app->db->all('SELECT user_id FROM {cal_members} WHERE calendar_id = ? AND hidden = 0', [$r['calendar_id']]) as $m) {
                    $this->notify((int) $m['user_id'], $payload);
                    $sent++;
                }
            }
            $this->app->db->run('UPDATE {cal_events} SET reminded_to = ?, next_reminder_at = ? WHERE id = ?', [$now->format('Y-m-d H:i:s'),
                $this->nextReminder($r, $now)?->format('Y-m-d H:i:s'), $r['id']]);
        }
        return $sent;
    }

    /** "Today 14:00–15:00", "Tomorrow, all day" or "Fri 3 Jan 09:30", in the event's own time zone. */
    private function when(array $r, string $start): string
    {
        $tz = self::zone($r['tz']);
        $length = strtotime($r['end_at'] . ' UTC') - strtotime($r['start_at'] . ' UTC');
        $s = $r['all_day'] ? new \DateTimeImmutable($start, $tz) : (new \DateTimeImmutable($start))->setTimezone($tz);
        $today = new \DateTimeImmutable('today', $tz);
        $day = match ($s->format('Y-m-d')) {
            $today->format('Y-m-d') => 'Today',
            $today->modify('+1 day')->format('Y-m-d') => 'Tomorrow',
            default => $s->format('D j M'),
        };
        if ($r['all_day']) {
            return "$day, all day";
        }
        return "$day " . $s->format('H:i') . '–' . $s->modify("+$length seconds")->format('H:i');
    }

    private function notify(int $userId, array $payload): void
    {
        if ($this->notifyUser) {
            try {
                ($this->notifyUser)($userId, $payload);
            } catch (\Throwable $e) {
                error_log('webmail: calendar notification failed: ' . $e->getMessage());
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ iCalendar

    /** Events from an .ics file (or an invitation): [{uid, title, location, notes, all_day, start, end, tz, repeat}]. */
    public static function parseIcs(string $ics): array
    {
        if (strlen($ics) > 10 * 1024 * 1024) {
            throw new HttpError(413, 'That calendar file is too big (10 MB at most)', 'too_big');
        }
        // Unfold continued lines.
        $text = preg_replace("/\r?\n[ \t]/", '', str_replace("\r\n", "\n", $ics)) ?? '';
        $out = [];
        $cur = null;
        $depth = 0;
        foreach (explode("\n", $text) as $line) {
            if ($line === '') {
                continue;
            }
            if (preg_match('/^BEGIN:VEVENT$/i', trim($line))) {
                $cur = [];
                $depth = 0;
                continue;
            }
            if ($cur === null) {
                continue;
            }
            if (preg_match('/^BEGIN:/i', $line)) {
                $depth++; // a VALARM inside the event: not ours to read
                continue;
            }
            if (preg_match('/^END:/i', $line)) {
                if ($depth > 0) {
                    $depth--;
                    continue;
                }
                if (preg_match('/^END:VEVENT$/i', trim($line))) {
                    if ($e = self::icsEvent($cur)) {
                        $out[] = $e;
                    }
                    $cur = null;
                }
                continue;
            }
            if ($depth > 0 || !preg_match('/^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/s', $line, $m)) {
                continue;
            }
            $params = [];
            foreach (array_filter(explode(';', ltrim($m[2], ';'))) as $p) {
                [$k, $v] = array_pad(explode('=', $p, 2), 2, '');
                $params[strtoupper($k)] = trim($v, '"');
            }
            $cur[strtoupper($m[1])] ??= ['value' => $m[3], 'params' => $params];
        }
        return $out;
    }

    private static function icsText(string $v): string
    {
        return strtr($v, ['\\n' => "\n", '\\N' => "\n", '\\,' => ',', '\\;' => ';', '\\\\' => '\\']);
    }

    /** A date or date-time property: [all_day, instant or date, tz]. */
    private static function icsTime(?array $p): ?array
    {
        if (!$p) {
            return null;
        }
        $v = trim($p['value']);
        if (($p['params']['VALUE'] ?? '') === 'DATE' || preg_match('/^\d{8}$/', $v)) {
            return preg_match('/^(\d{4})(\d{2})(\d{2})$/', $v, $m) ? [true, "$m[1]-$m[2]-$m[3]", 'UTC'] : null;
        }
        if (!preg_match('/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/', $v, $m)) {
            return null;
        }
        $tz = $m[7] === 'Z' ? new \DateTimeZone('UTC') : self::windowsZone($p['params']['TZID'] ?? 'UTC');
        $d = new \DateTimeImmutable("$m[1]-$m[2]-$m[3] $m[4]:$m[5]:$m[6]", $tz);
        return [false, $d->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'), $tz->getName()];
    }

    /** A TZID as a time zone: IANA names as they are; Outlook's Windows names for the common ones. */
    private static function windowsZone(string $id): \DateTimeZone
    {
        $map = ['GMT Standard Time' => 'Europe/London', 'W. Europe Standard Time' => 'Europe/Berlin', 'Romance Standard Time' => 'Europe/Paris',
            'Central Europe Standard Time' => 'Europe/Budapest', 'E. Europe Standard Time' => 'Europe/Chisinau', 'FLE Standard Time' => 'Europe/Kiev',
            'Eastern Standard Time' => 'America/New_York', 'Central Standard Time' => 'America/Chicago', 'Mountain Standard Time' => 'America/Denver',
            'Pacific Standard Time' => 'America/Los_Angeles', 'AUS Eastern Standard Time' => 'Australia/Sydney', 'India Standard Time' => 'Asia/Kolkata',
            'China Standard Time' => 'Asia/Shanghai', 'Tokyo Standard Time' => 'Asia/Tokyo', 'Singapore Standard Time' => 'Asia/Singapore',
            'UTC' => 'UTC', 'Greenwich Standard Time' => 'Atlantic/Reykjavik', 'Irish Standard Time' => 'Europe/Dublin'];
        $id = trim($id, '"/');
        return self::zone($map[$id] ?? $id);
    }

    private static function icsEvent(array $p): ?array
    {
        $start = self::icsTime($p['DTSTART'] ?? null);
        if (!$start || strtoupper(trim($p['STATUS']['value'] ?? '')) === 'CANCELLED') {
            return null;
        }
        [$allDay, $s, $tz] = $start;
        $end = self::icsTime($p['DTEND'] ?? null);
        if ($end && $end[0] === $allDay) {
            $e = $end[1];
        } elseif (isset($p['DURATION']) && preg_match('/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/', trim($p['DURATION']['value']), $m)) {
            $secs = ((int) ($m[1] ?? 0)) * 604800 + ((int) ($m[2] ?? 0)) * 86400 + ((int) ($m[3] ?? 0)) * 3600 + ((int) ($m[4] ?? 0)) * 60 + (int) ($m[5] ?? 0);
            $e = $allDay ? (new \DateTimeImmutable($s))->modify('+' . max(1, intdiv($secs, 86400)) . ' days')->format('Y-m-d') : gmdate('Y-m-d\TH:i:s\Z', strtotime($s) + max(60, $secs));
        } else {
            $e = $allDay ? (new \DateTimeImmutable($s))->modify('+1 day')->format('Y-m-d') : gmdate('Y-m-d\TH:i:s\Z', strtotime($s) + 3600);
        }
        $repeat = null;
        if (isset($p['RRULE'])) {
            $r = [];
            foreach (explode(';', strtoupper(trim($p['RRULE']['value']))) as $kv) {
                [$k, $v] = array_pad(explode('=', $kv, 2), 2, '');
                $r[$k] = $v;
            }
            $freq = strtolower($r['FREQ'] ?? '');
            if (in_array($freq, self::FREQS, true)) {
                $repeat = ['freq' => $freq, 'interval' => (int) ($r['INTERVAL'] ?? 1)];
                if (isset($r['BYDAY'])) {
                    if ($freq === 'weekly') {
                        $repeat['days'] = array_values(array_intersect(self::DAYS, explode(',', $r['BYDAY'])));
                    } elseif ($freq === 'monthly' && preg_match('/^-?\d[A-Z]{2}$/', $r['BYDAY'])) {
                        $repeat['by'] = 'weekday';
                    }
                }
                if (isset($r['UNTIL']) && preg_match('/^(\d{4})(\d{2})(\d{2})/', $r['UNTIL'], $m)) {
                    $repeat['until'] = "$m[1]-$m[2]-$m[3]";
                } elseif (isset($r['COUNT'])) {
                    $repeat['count'] = (int) $r['COUNT'];
                }
                $repeat = self::rule($repeat);
            }
        }
        $text = fn (string $k) => isset($p[$k]) ? trim(self::icsText($p[$k]['value'])) : '';
        return ['uid' => mb_substr($text('UID') ?: self::newUid(), 0, 255), 'title' => $text('SUMMARY') ?: '(no title)', 'location' => $text('LOCATION'),
            'notes' => $text('DESCRIPTION'), 'all_day' => $allDay, 'start' => $s, 'end' => $e, 'tz' => $tz, 'repeat' => $repeat];
    }

    /** Add the events from an .ics file to a calendar. An event already there (the same UID) is updated instead. */
    public function import(array $user, int $calendarId, string $ics): array
    {
        $cal = $this->member((int) $user['id'], $calendarId);
        if ($cal['role'] === 'view') {
            throw new HttpError(403, 'You can see this calendar but not change it', 'forbidden');
        }
        $events = self::parseIcs($ics);
        if (!$events) {
            throw new HttpError(422, "There aren't any events in that file", 'no_events');
        }
        $added = $updated = 0;
        foreach (array_slice($events, 0, 5000) as $e) {
            try {
                $f = $this->fields($e);
            } catch (HttpError) {
                continue;
            }
            $f['uid'] = $e['uid'];
            $existing = $this->app->db->value('SELECT id FROM {cal_events} WHERE calendar_id = ? AND uid = ?', [$calendarId, $e['uid']]);
            if ($existing) {
                $this->app->db->run('UPDATE {cal_events} SET title_enc = ?, location_enc = ?, notes_enc = ?, all_day = ?, start_at = ?, end_at = ?, tz = ?, repeat_json = ?, repeat_until = ?,
                    updated_by = ?, updated_at = ? WHERE id = ?', [$f['title_enc'], $f['location_enc'], $f['notes_enc'], $f['all_day'], $f['start_at'], $f['end_at'], $f['tz'],
                    $f['repeat_json'], $f['repeat_until'], $user['id'], App::now(), $existing]);
                $updated++;
            } else {
                $this->insert($calendarId, $f, (int) $user['id']);
                $added++;
            }
        }
        $first = $events[0];
        return ['added' => $added, 'updated' => $updated, 'first' => ['start' => $first['start'], 'all_day' => $first['all_day']]];
    }

    /** A calendar as an .ics file (for downloading, and the private feed link). */
    public function ics(int $calendarId, string $name): string
    {
        $c = $this->c();
        $esc = fn (string $v) => strtr($v, ['\\' => '\\\\', ';' => '\;', ',' => '\,', "\n" => '\n', "\r" => '']);
        $fold = function (string $line): string {
            $out = '';
            while (strlen($line) > 74) {
                $cut = 74;
                while ($cut > 0 && (ord($line[$cut]) & 0xC0) === 0x80) {
                    $cut--; // don't split a UTF-8 character
                }
                $out .= substr($line, 0, $cut) . "\r\n ";
                $line = substr($line, $cut);
            }
            return $out . $line . "\r\n";
        };
        $lines = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//GhostParse//Webmail " . App::VERSION . "//EN\r\nCALSCALE:GREGORIAN\r\n" . $fold('X-WR-CALNAME:' . $esc($name));
        $stamp = gmdate('Ymd\THis\Z');
        foreach ($this->app->db->all('SELECT * FROM {cal_events} WHERE calendar_id = ? ORDER BY start_at', [$calendarId]) as $r) {
            $lines .= "BEGIN:VEVENT\r\n" . $fold('UID:' . $r['uid']) . "DTSTAMP:$stamp\r\n";
            $exFmt = null;
            if ($r['all_day']) {
                $lines .= 'DTSTART;VALUE=DATE:' . str_replace('-', '', substr($r['start_at'], 0, 10)) . "\r\nDTEND;VALUE=DATE:" . str_replace('-', '', substr($r['end_at'], 0, 10)) . "\r\n";
                $exFmt = fn ($k) => 'EXDATE;VALUE=DATE:' . str_replace('-', '', $k);
            } else {
                $lines .= 'DTSTART:' . gmdate('Ymd\THis\Z', strtotime($r['start_at'] . ' UTC')) . "\r\nDTEND:" . gmdate('Ymd\THis\Z', strtotime($r['end_at'] . ' UTC')) . "\r\n";
                $exFmt = fn ($k) => 'EXDATE:' . gmdate('Ymd\THis\Z', strtotime($k));
            }
            if ($r['repeat_json']) {
                // The rule's days and times are the event's own, in UTC here: right unless a repeat crosses a clock change.
                $lines .= $fold('RRULE:' . self::rrule(json_decode($r['repeat_json'], true), $r));
                foreach (json_decode((string) $r['exdates'], true) ?: [] as $k) {
                    $lines .= $exFmt($k) . "\r\n";
                }
            }
            $lines .= $fold('SUMMARY:' . $esc((string) $c->decrypt($r['title_enc'], 'cal.title')));
            if ($l = $c->decrypt($r['location_enc'], 'cal.location')) {
                $lines .= $fold('LOCATION:' . $esc($l));
            }
            if ($n = $c->decrypt($r['notes_enc'], 'cal.notes')) {
                $lines .= $fold('DESCRIPTION:' . $esc($n));
            }
            $lines .= 'LAST-MODIFIED:' . gmdate('Ymd\THis\Z', strtotime($r['updated_at'] . ' UTC')) . "\r\nEND:VEVENT\r\n";
        }
        return $lines . "END:VCALENDAR\r\n";
    }

    private static function rrule(array $rule, array $r): string
    {
        $out = 'FREQ=' . strtoupper($rule['freq']);
        if (($rule['interval'] ?? 1) > 1) {
            $out .= ';INTERVAL=' . $rule['interval'];
        }
        $local = (new \DateTimeImmutable($r['start_at'], new \DateTimeZone('UTC')))->setTimezone($r['all_day'] ? new \DateTimeZone('UTC') : self::zone($r['tz']));
        if ($rule['freq'] === 'weekly' && !empty($rule['days'])) {
            $out .= ';BYDAY=' . implode(',', $rule['days']);
        }
        if ($rule['freq'] === 'monthly' && ($rule['by'] ?? '') === 'weekday') {
            $out .= ';BYDAY=' . self::weekOfMonth($local) . self::DAYS[(int) $local->format('N') - 1];
        }
        if (isset($rule['until'])) {
            $out .= ';UNTIL=' . str_replace('-', '', $rule['until']) . ($r['all_day'] ? '' : 'T235959Z');
        } elseif (isset($rule['count'])) {
            $out .= ';COUNT=' . $rule['count'];
        }
        return $out;
    }
}
