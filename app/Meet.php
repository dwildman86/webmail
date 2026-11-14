<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Meet: video meetings in the browser. Sound and video go directly between the people in the meeting (WebRTC, a
 * mesh: everyone connects to everyone, encrypted end to end by DTLS-SRTP), so nothing of the meeting passes through
 * or is kept by this server. What the server does is introduce them: it relays each browser's connection details
 * (offers, answers and network candidates) to the others, polled every second or two, and forgets them as soon as
 * they've been fetched. When two browsers can't reach each other directly (strict office networks), GhostParse's
 * TURN relay carries the encrypted media; its credentials last a few hours.
 *
 * A meeting is a link (meet.php?r=…, a 128-bit random token; only its hash is looked up). People signed in to this
 * webmail join straight away; anyone else with the link (a customer) gives their name and waits in the lobby until
 * someone in the meeting lets them in, unless an administrator turned guests off (Settings → Meetings).
 * Up to MAX_PEOPLE at once: in a mesh each person sends their video to every other, which home connections manage
 * up to about six. Bigger meetings need a media server (an SFU), which a shared host can't run.
 */
final class Meet
{
    public const MAX_PEOPLE = 6;
    /** Not heard from for this long (a closed tab, a lost connection): gone from the meeting. */
    public const GONE_AFTER = 25;
    /** Connection details not fetched within this long are dropped. */
    public const SIGNAL_TTL = 120;
    private const KINDS = ['offer', 'answer', 'ice', 'bye'];
    private const STATE_KEYS = ['a', 'v', 's', 'h', 'r'];
    public const DEFAULTS = ['enabled' => true, 'guests' => true, 'days' => 30];

    public function __construct(private App $app)
    {
    }

    public function settings(): array
    {
        $raw = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'meet'"), true);
        return array_intersect_key((is_array($raw) ? $raw : []) + self::DEFAULTS, self::DEFAULTS);
    }

    public function saveSettings(array $in): array
    {
        $s = $this->settings();
        foreach (['enabled', 'guests'] as $k) {
            if (array_key_exists($k, $in)) {
                $s[$k] = (bool) $in[$k];
            }
        }
        if (array_key_exists('days', $in)) {
            $d = (int) $in['days'];
            if ($d < 1 || $d > 365) {
                throw new HttpError(422, 'Meeting links can last from 1 to 365 days.', 'bad_settings');
            }
            $s['days'] = $d;
        }
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('meet', ?)", [json_encode($s)]);
        return $s;
    }

    /**
     * What GhostParse allows this organisation (GET /v1/me features.meetings, set per account by GhostParse's
     * operators): on or off, people per meeting, guests, recording, and its relay. Asked at most every 10 minutes (each
     * usage report brings it too); the last answer stands while GhostParse can't be reached.
     */
    public function policy(bool $refresh = false): array
    {
        $defaults = ['enabled' => true, 'max_people' => self::MAX_PEOPLE, 'guests' => true, 'recording' => true, 'relay' => true];
        $known = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'meet_policy'"), true);
        if (!$refresh && is_array($known) && ($known['at'] ?? 0) > $this->now() - 600) {
            return $known['policy'] + $defaults;
        }
        try {
            $p = $this->app->gp->me()['features']['meetings'] ?? null;
        } catch (\Throwable) {
            // Unreachable: the last answer stands, asked again in a minute (not on every request meanwhile).
            $last = (is_array($known) ? $known['policy'] : []) + $defaults;
            $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('meet_policy', ?)", [json_encode(['at' => $this->now() - 540, 'policy' => $last])]);
            return $last;
        }
        return $this->rememberPolicy(is_array($p) ? $p : $defaults) + $defaults;
    }

    private function rememberPolicy(array $p): array
    {
        $clean = ['enabled' => (bool) ($p['enabled'] ?? true), 'max_people' => max(2, min(self::MAX_PEOPLE, (int) ($p['max_people'] ?? self::MAX_PEOPLE))),
            'guests' => (bool) ($p['guests'] ?? true), 'recording' => (bool) ($p['recording'] ?? true), 'relay' => (bool) ($p['relay'] ?? true)];
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('meet_policy', ?)", [json_encode(['at' => $this->now(), 'policy' => $clean])]);
        return $clean;
    }

    /** What applies: this webmail's own settings within what GhostParse allows. */
    public function effective(): array
    {
        $s = $this->settings();
        $p = $this->policy();
        return ['enabled' => $s['enabled'] && $p['enabled'], 'guests' => $s['guests'] && $p['guests'], 'recording' => $p['recording'], 'max' => $p['max_people'],
            'days' => $s['days'], 'policy' => $p];
    }

    private function max(): int
    {
        return $this->effective()['max'];
    }

    // ------------------------------------------------------------------------------------------------- usage counts

    /** A count for the next report to GhostParse (numbers only: never who, or which meeting). */
    private function bump(string $what, int $n = 1): void
    {
        $this->app->db->run("INSERT INTO {meta} (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = CAST(v AS SIGNED) + ?", ["meet_n_$what", (string) $n, $n]);
    }

    private function peak(int $people): void
    {
        $this->app->db->run("INSERT INTO {meta} (k, v) VALUES ('meet_n_peak', ?) ON DUPLICATE KEY UPDATE v = GREATEST(CAST(v AS SIGNED), ?)", [(string) $people, $people]);
    }

    /** What's going on now, across every meeting here. */
    private function live(): array
    {
        $row = $this->app->db->one("SELECT COUNT(DISTINCT room_id) AS meetings, COUNT(*) AS people, SUM(user_id IS NULL) AS guests FROM {meet_peers} WHERE status = 'in' AND seen_at > ?",
            [self::at($this->now() - self::GONE_AFTER)]);
        return ['meetings' => (int) ($row['meetings'] ?? 0), 'people' => (int) ($row['people'] ?? 0), 'guests' => (int) ($row['guests'] ?? 0)];
    }

    /**
     * Time to tell GhostParse? Every 5 minutes while there's something to say: meetings going on, counts waiting, or
     * meetings that were going on at the last report and have finished since.
     */
    public function reportDue(): bool
    {
        $last = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'meet_report'"), true) ?: [];
        if (($last['at'] ?? 0) > $this->now() - 300) {
            return false;
        }
        return ($last['active'] ?? 0) > 0 || $this->live()['people'] > 0
            || (bool) $this->app->db->value("SELECT 1 FROM {meta} WHERE k LIKE 'meet\\_n\\_%' AND v <> '0' LIMIT 1");
    }

    /** The counts since the last report, sent to GhostParse; its answer brings this organisation's policy. */
    public function report(): void
    {
        $db = $this->app->db;
        $last = json_decode((string) $db->value("SELECT v FROM {meta} WHERE k = 'meet_report'"), true) ?: [];
        $live = $this->live();
        $minutes = (int) round(min(15, max(0, $this->now() - ($last['at'] ?? $this->now())) / 60) * $live['people']);
        $counts = [];
        foreach (['started', 'joined', 'guests', 'full', 'recordings', 'peak'] as $k) {
            $counts[$k] = (int) $db->value('SELECT v FROM {meta} WHERE k = ?', ["meet_n_$k"]);
        }
        // Marked first: GhostParse unreachable is tried again in five minutes, with these counts still waiting.
        $db->run("REPLACE INTO {meta} (k, v) VALUES ('meet_report', ?)", [json_encode(['at' => $this->now(), 'active' => $live['meetings']])]);
        $r = $this->app->gp->request('POST', '/v1/webmail/meetings', [
            'active_meetings' => $live['meetings'], 'people_now' => $live['people'], 'guests_now' => $live['guests'],
            'meetings_started' => $counts['started'], 'people_joined' => $counts['joined'], 'guests_joined' => $counts['guests'],
            'person_minutes' => $minutes, 'peak_people' => max($counts['peak'], $live['people'] ? $this->largestNow() : 0),
            'full_refusals' => $counts['full'], 'recordings' => $counts['recordings'],
        ]);
        // What was sent is taken off (counts made meanwhile stay for next time).
        foreach (['started', 'joined', 'guests', 'full', 'recordings'] as $k) {
            if ($counts[$k]) {
                $db->run('UPDATE {meta} SET v = CAST(v AS SIGNED) - ? WHERE k = ?', [$counts[$k], "meet_n_$k"]);
            }
        }
        $db->run("UPDATE {meta} SET v = '0' WHERE k = 'meet_n_peak'");
        if (is_array($r['policy'] ?? null)) {
            $this->rememberPolicy($r['policy']);
        }
    }

    private function largestNow(): int
    {
        return (int) $this->app->db->value("SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM {meet_peers} WHERE status = 'in' AND seen_at > ? GROUP BY room_id) x",
            [self::at($this->now() - self::GONE_AFTER)]);
    }

    private function now(): int
    {
        return time();
    }

    private static function at(int $t): string
    {
        return gmdate('Y-m-d H:i:s', $t);
    }

    // ------------------------------------------------------------------------------------------------- meetings

    /** A new meeting, by someone signed in: its link. $messageId: the email it was started from (its subject is the title). */
    public function create(array $user, string $title = '', ?int $messageId = null): array
    {
        $s = $this->effective();
        if (!$s['enabled']) {
            throw new HttpError(403, $s['policy']['enabled'] ? 'Meetings are turned off. An administrator can turn them on in Settings → Meetings.'
                : 'Meetings aren\'t available for this organisation. Ask GhostParse support.', 'meet_off');
        }
        if ($messageId) {
            $m = (new Mailstore($this->app))->get($user['id'], $messageId, false); // throws when it isn't theirs
            if ($title === '') {
                $title = (string) ($m['message']['subject'] ?? '');
            }
        }
        $title = trim(preg_replace('/\s+/u', ' ', $title) ?? '');
        $title = mb_substr($title !== '' ? $title : 'Meeting with ' . ($user['name'] ?: $user['email']), 0, 200);
        $token = sodium_bin2base64(random_bytes(16), SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        $c = $this->app->crypto;
        $now = $this->now();
        $id = $this->app->db->insert('INSERT INTO {meet_rooms} (token_hash, token_enc, title_enc, owner_id, message_id, created_at, used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            hash('sha256', $token), $c->encrypt($token, 'meet.token'), $c->encrypt($title, 'meet.title'), $user['id'], $messageId, self::at($now), self::at($now),
            self::at($now + $s['days'] * 86400)]);
        return ['id' => $id, 'token' => $token, 'title' => $title, 'url' => $this->url($token)];
    }

    public function url(string $token): string
    {
        return rtrim($this->app->baseUrl(), '/') . '/meet.php?r=' . rawurlencode($token);
    }

    /** The meetings someone started lately, to open again or copy the link of. */
    public function mine(array $user): array
    {
        $c = $this->app->crypto;
        $rows = $this->app->db->all('SELECT r.id, r.token_enc, r.title_enc, r.created_at, r.used_at, r.expires_at,
                (SELECT COUNT(*) FROM {meet_peers} p WHERE p.room_id = r.id AND p.status = \'in\' AND p.seen_at > ?) AS here
            FROM {meet_rooms} r WHERE r.owner_id = ? AND r.expires_at > ? ORDER BY r.used_at DESC LIMIT 20',
            [self::at($this->now() - self::GONE_AFTER), $user['id'], self::at($this->now())]);
        return array_map(fn ($r) => ['id' => (int) $r['id'], 'title' => $c->decrypt($r['title_enc'], 'meet.title'),
            'url' => $this->url((string) $c->decrypt($r['token_enc'], 'meet.token')), 'created_at' => $r['created_at'], 'used_at' => $r['used_at'],
            'expires_at' => $r['expires_at'], 'here' => (int) $r['here']], $rows);
    }

    public function end(array $user, int $id): void
    {
        $room = $this->app->db->one('SELECT id, owner_id FROM {meet_rooms} WHERE id = ?', [$id]);
        if (!$room || ((int) $room['owner_id'] !== $user['id'] && $user['role'] !== 'admin')) {
            throw new HttpError(404, 'No such meeting', 'not_found');
        }
        $this->app->db->run('UPDATE {meet_rooms} SET expires_at = ? WHERE id = ?', [self::at($this->now()), $id]);
        $this->app->db->run("UPDATE {meet_peers} SET status = 'ended' WHERE room_id = ? AND status IN ('in','lobby')", [$id]);
    }

    /** The meeting a link is for, while it lasts. */
    public function room(string $token): array
    {
        $room = strlen($token) >= 16 && strlen($token) <= 64
            ? $this->app->db->one('SELECT * FROM {meet_rooms} WHERE token_hash = ?', [hash('sha256', $token)]) : null;
        if (!$room || strtotime($room['expires_at'] . ' UTC') <= $this->now()) {
            throw new HttpError(404, 'This meeting link has expired or doesn\'t exist. Ask whoever sent it for a new one.', 'no_meeting');
        }
        if (!$this->effective()['enabled']) {
            throw new HttpError(403, 'Meetings are turned off here.', 'meet_off');
        }
        $room['title'] = (string) $this->app->crypto->decrypt($room['title_enc'], 'meet.title');
        return $room;
    }

    public function describe(array $room, ?array $user): array
    {
        $e = $this->effective();
        return ['title' => $room['title'], 'guests' => $e['guests'], 'recording' => $e['recording'], 'locked' => (bool) $room['locked'], 'max' => $e['max'],
            'here' => $this->count((int) $room['id']), 'host' => $user !== null && (int) $room['owner_id'] === $user['id']];
    }

    /** How many are in the meeting now. */
    private function count(int $roomId, int $except = 0): int
    {
        return (int) $this->app->db->value("SELECT COUNT(*) FROM {meet_peers} WHERE room_id = ? AND status = 'in' AND seen_at > ? AND id <> ?",
            [$roomId, self::at($this->now() - self::GONE_AFTER), $except]);
    }

    /** Refused when the meeting already has as many as it can; counted (for GhostParse) unless $count is false. */
    private function full(int $roomId, int $except = 0, bool $count = true): void
    {
        $max = $this->max();
        if ($this->count($roomId, $except) >= $max) {
            if ($count) {
                $this->bump('full');
            }
            throw new HttpError(409, "This meeting is full: it already has $max people, the most a meeting can have. You can join when someone leaves.", 'meeting_full');
        }
    }

    // ------------------------------------------------------------------------------------------------- people

    /**
     * Joining: someone signed in here goes straight in; a guest waits in the lobby until let in. The secret returned
     * is that person's key for everything after (X-Meet-Peer); only its hash is kept.
     */
    public function join(array $room, ?array $user, string $name): array
    {
        $roomId = (int) $room['id'];
        $name = trim(preg_replace('/[\p{C}\s]+/u', ' ', $name) ?? '');
        if ($user) {
            $name = $user['name'] !== '' ? $user['name'] : (string) $user['email'];
            $this->full($roomId);
            $status = 'in';
            $before = $this->count($roomId);
        } else {
            if (!$this->effective()['guests']) {
                throw new HttpError(403, 'Only people with an account here can join this meeting.', 'guests_off');
            }
            if ($room['locked']) {
                throw new HttpError(403, 'This meeting is locked: nobody else can join it now.', 'locked');
            }
            if ($name === '' || mb_strlen($name) > 60) {
                throw new HttpError(422, 'Say who you are: a name of up to 60 characters.', 'bad_name');
            }
            // Not too many knocking at once (each would be asked about).
            if ((int) $this->app->db->value("SELECT COUNT(*) FROM {meet_peers} WHERE room_id = ? AND status = 'lobby' AND seen_at > ?", [$roomId, self::at($this->now() - self::GONE_AFTER)]) >= 10) {
                throw new HttpError(429, 'Too many people are waiting to join this meeting. Try again in a minute.', 'lobby_full');
            }
            $status = 'lobby';
            // Knocking on a full meeting: someone turned away for now (counted once, here, not again if let-in is refused).
            if ($this->count($roomId) >= $this->max()) {
                $this->bump('full');
            }
        }
        $secret = sodium_bin2base64(random_bytes(32), SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        $now = self::at($this->now());
        $id = $this->app->db->insert('INSERT INTO {meet_peers} (room_id, secret_hash, user_id, name_enc, status, state, joined_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            $roomId, hash('sha256', $secret), $user['id'] ?? null, $this->app->crypto->encrypt(mb_substr($name, 0, 60), 'meet.name'), $status, '{}', $now, $now]);
        $this->app->db->run('UPDATE {meet_rooms} SET used_at = ? WHERE id = ?', [$now, $roomId]);
        if ($status === 'in') {
            $this->joined($roomId, $before ?? 0, false);
        }
        return ['id' => $id, 'secret' => $secret, 'status' => $status, 'name' => $name, 'member' => $user !== null];
    }

    /** Counted for the report: someone in, the meeting started when they're the first, and its size. */
    private function joined(int $roomId, int $before, bool $guest): void
    {
        if ($before === 0) {
            $this->bump('started');
        }
        $this->bump('joined');
        if ($guest) {
            $this->bump('guests');
        }
        $this->peak($before + 1);
    }

    /** The person a secret belongs to, in this meeting. */
    public function peer(array $room, string $secret): array
    {
        $p = $secret !== '' ? $this->app->db->one('SELECT * FROM {meet_peers} WHERE secret_hash = ? AND room_id = ?', [hash('sha256', $secret), $room['id']]) : null;
        if (!$p) {
            throw new HttpError(401, 'You\'re not in this meeting. Reload to join again.', 'not_joined');
        }
        $p['id'] = (int) $p['id'];
        return $p;
    }

    private function needIn(array $peer): void
    {
        if ($peer['status'] !== 'in') {
            throw new HttpError(403, 'You\'re not in the meeting.', 'not_in');
        }
    }

    /**
     * Asked every second or two by each person: who's in the meeting (and, for those in it, who's waiting in the
     * lobby), and connection details sent to them. Details up to $after were received and are deleted.
     */
    public function poll(array $room, array $peer, int $after): array
    {
        $db = $this->app->db;
        $now = $this->now();
        $roomId = (int) $room['id'];
        // Gone a while (a laptop lid closed) and the meeting filled up meanwhile: back through the door.
        if ($peer['status'] === 'in' && strtotime($peer['seen_at'] . ' UTC') < $now - self::GONE_AFTER && $this->count($roomId, $peer['id']) >= $this->max()) {
            $db->run("UPDATE {meet_peers} SET status = 'left' WHERE id = ?", [$peer['id']]);
            $peer['status'] = 'left';
        }
        $db->run('UPDATE {meet_peers} SET seen_at = ? WHERE id = ?', [self::at($now), $peer['id']]);
        if ($after > 0) {
            $db->run('DELETE FROM {meet_signals} WHERE to_peer = ? AND id <= ?', [$peer['id'], $after]);
        }
        $max = $this->max();
        $out = ['status' => $peer['status'], 'me' => $peer['id'], 'title' => $room['title'], 'locked' => (bool) $room['locked'], 'max' => $max,
            'full' => $this->count($roomId) >= $max, 'people' => [], 'lobby' => [], 'signals' => []];
        if ($peer['status'] !== 'in') {
            return $out;
        }
        $c = $this->app->crypto;
        $since = self::at($now - self::GONE_AFTER);
        foreach ($db->all("SELECT id, user_id, name_enc, status, state, joined_at FROM {meet_peers} WHERE room_id = ? AND status IN ('in','lobby') AND seen_at > ? ORDER BY id", [$roomId, $since]) as $p) {
            $row = ['id' => (int) $p['id'], 'name' => (string) $c->decrypt($p['name_enc'], 'meet.name'), 'member' => $p['user_id'] !== null,
                'host' => $p['user_id'] !== null && (int) $p['user_id'] === (int) $room['owner_id'], 'joined_at' => $p['joined_at']];
            if ($p['status'] === 'in') {
                $out['people'][] = $row + ['state' => json_decode((string) $p['state'], true) ?: (object) []];
            } elseif ($peer['user_id'] !== null) {
                $out['lobby'][] = $row; // only people with an account here let others in
            }
        }
        foreach ($db->all('SELECT id, from_peer, kind, payload_enc FROM {meet_signals} WHERE to_peer = ? AND id > ? ORDER BY id LIMIT 200', [$peer['id'], $after]) as $s) {
            $out['signals'][] = ['id' => (int) $s['id'], 'from' => (int) $s['from_peer'], 'kind' => $s['kind'], 'data' => json_decode((string) $c->decrypt($s['payload_enc'], 'meet.signal'), true)];
        }
        return $out;
    }

    /** Connection details for others in the meeting: [{to, kind, data}], kept encrypted until fetched. */
    public function signal(array $room, array $peer, array $messages): int
    {
        $this->needIn($peer);
        if (count($messages) > 60) {
            throw new HttpError(413, 'Too many at once', 'too_many');
        }
        $db = $this->app->db;
        $in = array_flip(array_map('intval', array_column($db->all("SELECT id FROM {meet_peers} WHERE room_id = ? AND status = 'in'", [$room['id']]), 'id')));
        $sent = 0;
        $now = self::at($this->now());
        foreach ($messages as $m) {
            $to = (int) ($m['to'] ?? 0);
            $kind = (string) ($m['kind'] ?? '');
            if (!isset($in[$to]) || $to === $peer['id'] || !in_array($kind, self::KINDS, true)) {
                continue; // they've left meanwhile: nothing to tell them
            }
            $data = json_encode($m['data'] ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($data === false || strlen($data) > 65536) {
                throw new HttpError(413, 'That connection detail is too big', 'too_big');
            }
            $db->insert('INSERT INTO {meet_signals} (room_id, from_peer, to_peer, kind, payload_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$room['id'], $peer['id'], $to, $kind, $this->app->crypto->encrypt($data, 'meet.signal'), $now]);
            $sent++;
        }
        return $sent;
    }

    /** What others see of you: microphone (a), camera (v), sharing your screen (s), hand up (h), recording (r). */
    public function setState(array $peer, array $state): array
    {
        $this->needIn($peer);
        $clean = [];
        foreach (self::STATE_KEYS as $k) {
            if (array_key_exists($k, $state)) {
                $clean[$k] = (bool) $state[$k];
            }
        }
        if (!empty($clean['r']) && $peer['user_id'] === null) {
            throw new HttpError(403, 'Only people with an account here can record a meeting.', 'record_members');
        }
        if (!empty($clean['r']) && !$this->effective()['recording']) {
            throw new HttpError(403, 'Recording meetings isn\'t available for this organisation.', 'record_off');
        }
        $was = json_decode((string) $peer['state'], true) ?: [];
        if (!empty($clean['r']) && empty($was['r'])) {
            $this->bump('recordings');
        }
        $this->app->db->run('UPDATE {meet_peers} SET state = ? WHERE id = ?', [json_encode($clean), $peer['id']]);
        return $clean;
    }

    /** Someone in the meeting with an account here lets a guest in from the lobby, or doesn't. */
    public function admit(array $room, array $peer, int $guestId, bool $allow): void
    {
        $this->needIn($peer);
        if ($peer['user_id'] === null) {
            throw new HttpError(403, 'Only people with an account here can let others in.', 'members_only');
        }
        $guest = $this->app->db->one("SELECT id FROM {meet_peers} WHERE id = ? AND room_id = ? AND status = 'lobby'", [$guestId, $room['id']]);
        if (!$guest) {
            throw new HttpError(404, 'They\'re not waiting any more.', 'not_waiting');
        }
        if ($allow) {
            $this->full((int) $room['id'], 0, false);
            $before = $this->count((int) $room['id']);
        }
        $this->app->db->run('UPDATE {meet_peers} SET status = ? WHERE id = ?', [$allow ? 'in' : 'denied', $guestId]);
        if ($allow) {
            $this->joined((int) $room['id'], $before, true);
        }
    }

    /** The meeting's host (or an administrator) takes someone out of it. */
    public function remove(array $room, array $peer, ?array $user, int $otherId): void
    {
        $this->needIn($peer);
        if (!$this->hosts($room, $user)) {
            throw new HttpError(403, 'Only whoever started the meeting can do that.', 'host_only');
        }
        $this->app->db->run("UPDATE {meet_peers} SET status = 'removed' WHERE id = ? AND room_id = ? AND id <> ?", [$otherId, $room['id'], $peer['id']]);
        $this->app->db->run('DELETE FROM {meet_signals} WHERE to_peer = ?', [$otherId]);
    }

    /** Locked: nobody new can join (guests can't even knock). */
    public function lock(array $room, array $peer, ?array $user, bool $locked): void
    {
        $this->needIn($peer);
        if (!$this->hosts($room, $user)) {
            throw new HttpError(403, 'Only whoever started the meeting can do that.', 'host_only');
        }
        $this->app->db->run('UPDATE {meet_rooms} SET locked = ? WHERE id = ?', [$locked ? 1 : 0, $room['id']]);
        if ($locked) {
            $this->app->db->run("UPDATE {meet_peers} SET status = 'denied' WHERE room_id = ? AND status = 'lobby'", [$room['id']]);
        }
    }

    private function hosts(array $room, ?array $user): bool
    {
        return $user !== null && ((int) $room['owner_id'] === $user['id'] || $user['role'] === 'admin');
    }

    public function leave(array $peer): void
    {
        $this->app->db->run("UPDATE {meet_peers} SET status = 'left' WHERE id = ? AND status IN ('in','lobby')", [$peer['id']]);
        $this->app->db->run('DELETE FROM {meet_signals} WHERE to_peer = ? OR from_peer = ?', [$peer['id'], $peer['id']]);
    }

    // ------------------------------------------------------------------------------------------------- networks

    /**
     * The STUN and TURN servers browsers use to find a way to each other, from GhostParse (its TURN relay, with
     * credentials good for a few hours). Kept for an hour, so a meeting starting doesn't wait on GhostParse each time.
     * Without GhostParse: a public STUN server, which works for most home and mobile connections.
     */
    public function iceServers(): array
    {
        $db = $this->app->db;
        $cached = json_decode((string) $this->app->crypto->decrypt((string) $db->value("SELECT v FROM {meta} WHERE k = 'meet_ice'") ?: null, 'meet.ice'), true);
        if (is_array($cached) && ($cached['until'] ?? 0) > $this->now()) {
            return $cached['servers'];
        }
        $servers = [['urls' => ['stun:stun.l.google.com:19302']]];
        $until = $this->now() + 600; // GhostParse unreachable: asked again in ten minutes
        try {
            $r = $this->app->gp->request('POST', '/v1/webmail/turn', ['label' => 'meet']);
            if (!empty($r['ice_servers']) && is_array($r['ice_servers'])) {
                $servers = array_values(array_filter(array_map(fn ($s) => is_array($s) && !empty($s['urls'])
                    ? array_filter(['urls' => array_values(array_map('strval', (array) $s['urls'])), 'username' => isset($s['username']) ? (string) $s['username'] : null,
                        'credential' => isset($s['credential']) ? (string) $s['credential'] : null], fn ($v) => $v !== null) : null, $r['ice_servers'])));
                // Credentials last ttl seconds; renewed when half of that is gone, so a meeting started from the cache has hours.
                $until = $this->now() + max(600, min(3600, intdiv((int) ($r['ttl'] ?? 3600), 2)));
            }
        } catch (\Throwable $e) {
            error_log('webmail meet: TURN credentials: ' . $e->getMessage());
        }
        $db->run("REPLACE INTO {meta} (k, v) VALUES ('meet_ice', ?)", [$this->app->crypto->encrypt(json_encode(['until' => $until, 'servers' => $servers]), 'meet.ice')]);
        return $servers;
    }

    // ------------------------------------------------------------------------------------------------- tidying

    public function cleanupDue(): bool
    {
        return (int) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'meet_cleaned'") < $this->now() - 300
            && ((bool) $this->app->db->value('SELECT 1 FROM {meet_signals} WHERE created_at < ? LIMIT 1', [self::at($this->now() - self::SIGNAL_TTL)])
                || (bool) $this->app->db->value('SELECT 1 FROM {meet_peers} WHERE seen_at < ? LIMIT 1', [self::at($this->now() - 86400)])
                || (bool) $this->app->db->value('SELECT 1 FROM {meet_rooms} WHERE expires_at < ? LIMIT 1', [self::at($this->now())]));
    }

    /** Connection details nobody fetched, people long gone and expired meetings: deleted. */
    public function cleanup(): void
    {
        $db = $this->app->db;
        $db->run("REPLACE INTO {meta} (k, v) VALUES ('meet_cleaned', ?)", [(string) $this->now()]);
        $db->run('DELETE FROM {meet_signals} WHERE created_at < ?', [self::at($this->now() - self::SIGNAL_TTL)]);
        $db->run('DELETE FROM {meet_peers} WHERE seen_at < ?', [self::at($this->now() - 86400)]);
        $db->run('DELETE FROM {meet_rooms} WHERE expires_at < ?', [self::at($this->now())]);
    }

    // ------------------------------------------------------------------------------------------------- the API

    /** Signed-in actions (api.php?a=meet/…). */
    public function route(string $action, string $method, array $user): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        switch ("$method $action") {
            case 'POST meet/create':
                Http::json($this->create($user, (string) ($in['title'] ?? ''), isset($in['message_id']) ? (int) $in['message_id'] : null), 201);
            case 'GET meet':
                $e = $this->effective();
                Http::json(['meetings' => $this->mine($user), 'settings' => ['enabled' => $e['enabled'], 'guests' => $e['guests'], 'days' => $e['days']], 'max' => $e['max']]);
            case 'POST meet/end':
                $this->end($user, (int) ($in['id'] ?? 0));
                Http::json(['ok' => true]);
            case 'GET meet/settings':
                (new Auth($this->app))->requireAdmin();
                Http::json($this->settings() + ['policy' => $this->policy(true)]);
            case 'POST meet/settings':
                (new Auth($this->app))->requireAdmin();
                Http::json($this->saveSettings($in));
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }
}
