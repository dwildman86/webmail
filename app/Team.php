<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Working together in a shared mailbox (one that more than one person can read):
 *
 * - Notes: private comments on a conversation, seen only by the people who share its mailbox and never sent to the
 *   customer. "@Sarah" mentions someone, and they're notified.
 * - Assignment: who a conversation is with, and where it's up to (Open, In progress, Resolved). New email from the
 *   customer reopens a resolved conversation.
 * - Shared replies: one reply per conversation that several people write together. Each change is saved with the
 *   version it was based on; a change based on an older version is refused with the newer one, which the page merges
 *   with what's being typed and saves again. Who else has it open (and is typing) comes back with each read.
 *
 * A conversation is a mailbox and its thread_key, or "m<id>" for a message that has none. Notes and replies are
 * encrypted like the mail.
 */
final class Team
{
    public const STATUSES = ['open' => 'Open', 'in_progress' => 'In progress', 'resolved' => 'Resolved'];
    /** Someone with a shared reply open has read it this recently (the page asks every couple of seconds). */
    private const PRESENT_SECONDS = 12;
    private const TYPING_SECONDS = 4;

    /** Sends a notification to one person's devices (mentions, assignments): fn(int $userId, array $payload). Replaced in tests. */
    public ?\Closure $notifyUser = null;

    public function __construct(private App $app)
    {
        if (Notifier::supported()) {
            $this->notifyUser = fn (int $userId, array $payload) => (new Notifier($app))->notifyUser($userId, $payload);
        }
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    public function route(string $action, string $method, array $user): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        $id = fn (string $k) => (int) ($method === 'GET' ? ($_GET[$k] ?? 0) : ($in[$k] ?? 0));
        switch ("$method $action") {
            case 'GET team/thread':
                Http::json($this->thread($user, $id('id')));
            case 'POST team/note':
                Http::json($this->addNote($user, $id('message_id'), (string) ($in['body'] ?? '')), 201);
            case 'POST team/note/delete':
                $this->deleteNote($user, $id('id'));
                Http::json(['ok' => true]);
            case 'POST team/assign':
                Http::json($this->assign($user, $id('message_id'), $in));
            case 'POST team/draft/start':
                Http::json($this->startDraft($user, $id('message_id'), (array) ($in['fields'] ?? [])));
            case 'GET team/draft':
                Http::json($this->draft($user, $id('id'), true));
            case 'POST team/draft/save':
                Http::json($this->saveDraft($user, $id('id'), (int) ($in['version'] ?? 0), (array) ($in['fields'] ?? [])));
            case 'POST team/draft/leave':
                $this->app->db->run('DELETE FROM {draft_presence} WHERE draft_id = ? AND user_id = ?', [$id('id'), $user['id']]);
                Http::json(['ok' => true]);
            case 'POST team/draft/delete':
                $this->deleteDraft($user, $id('id'));
                Http::json(['ok' => true]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    // ---------------------------------------------------------------------------------------------- conversations

    /** The conversation a message is in, if the user can read its mailbox: [mailbox_id, thread key]. */
    public function conversation(int $userId, int $messageId): array
    {
        $row = $this->app->db->one('SELECT m.id, m.mailbox_id, m.thread_key FROM {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id
            WHERE um.user_id = ? AND m.id = ?', [$userId, $messageId]);
        if (!$row) {
            throw new HttpError(404, 'Message not found', 'not_found');
        }
        return [(int) $row['mailbox_id'], self::key($row)];
    }

    public static function key(array $messageRow): string
    {
        return ($messageRow['thread_key'] ?? '') !== '' && $messageRow['thread_key'] !== null ? (string) $messageRow['thread_key'] : 'm' . $messageRow['id'];
    }

    /** The people who can read a mailbox (and so see its notes), by id. */
    public function members(int $mailboxId): array
    {
        $out = [];
        foreach ($this->app->db->all('SELECT u.id, u.name_enc, u.email_enc FROM {users} u JOIN {user_mailboxes} um ON um.user_id = u.id
            WHERE um.mailbox_id = ? AND u.disabled = 0 ORDER BY u.id', [$mailboxId]) as $r) {
            $email = (string) $this->c()->decrypt($r['email_enc'], 'users.email');
            $out[(int) $r['id']] = ['id' => (int) $r['id'], 'name' => (string) ($this->c()->decrypt($r['name_enc'], 'users.name') ?: $email), 'email' => $email];
        }
        return $out;
    }

    private function nameOf(?int $userId, array $members): string
    {
        if ($userId === null) {
            return 'Someone who has left';
        }
        if (isset($members[$userId])) {
            return $members[$userId]['name'];
        }
        $r = $this->app->db->one('SELECT name_enc, email_enc FROM {users} WHERE id = ?', [$userId]);
        return $r ? (string) ($this->c()->decrypt($r['name_enc'], 'users.name') ?: $this->c()->decrypt($r['email_enc'], 'users.email')) : 'Someone who has left';
    }

    /** Everything the team has on a conversation: who's on the mailbox, its assignment, notes and shared reply. */
    public function thread(array $user, int $messageId): array
    {
        [$mailboxId, $key] = $this->conversation($user['id'], $messageId);
        $members = $this->members($mailboxId);
        $state = $this->app->db->one('SELECT assignee_id, status, updated_at FROM {thread_state} WHERE mailbox_id = ? AND thread_key = ?', [$mailboxId, $key]);
        $notes = [];
        foreach ($this->app->db->all('SELECT * FROM {thread_notes} WHERE mailbox_id = ? AND thread_key = ? ORDER BY id', [$mailboxId, $key]) as $n) {
            $notes[] = $this->presentNote($n, $members, $user);
        }
        $draft = $this->app->db->one('SELECT id FROM {shared_drafts} WHERE mailbox_id = ? AND thread_key = ?', [$mailboxId, $key]);
        return [
            'shared' => count($members) > 1,
            'members' => array_values($members),
            'assignee_id' => $state && $state['assignee_id'] !== null ? (int) $state['assignee_id'] : null,
            'status' => $state['status'] ?? 'open',
            'statuses' => self::STATUSES,
            'notes' => $notes,
            'draft' => $draft ? $this->draftSummary((int) $draft['id'], $members, $user['id']) : null,
        ];
    }

    private function presentNote(array $n, array $members, array $me): array
    {
        $author = $n['user_id'] !== null ? (int) $n['user_id'] : null;
        return [
            'id' => (int) $n['id'], 'kind' => $n['kind'], 'body' => (string) $this->c()->decrypt($n['body_enc'], 'notes.body'),
            // An event without anyone is the webmail's own (a conversation reopened by new email).
            'user_id' => $author, 'name' => $author === null && $n['kind'] === 'event' ? null : $this->nameOf($author, $members), 'mine' => $author === $me['id'],
            'mentions' => array_map('intval', array_filter(explode(',', (string) $n['mentions']))),
            'date' => gmdate('c', strtotime($n['created_at'] . ' UTC')),
        ];
    }

    // ---------------------------------------------------------------------------------------------- notes

    /** People mentioned in a note: "@sarah", "@SarahJones" or "@sarah.jones" (the part of their email before the @). */
    public static function mentioned(string $body, array $members): array
    {
        if (!preg_match_all('/(?<![\w@])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/u', $body, $m)) {
            return [];
        }
        $found = [];
        foreach ($m[1] as $token) {
            $token = mb_strtolower(rtrim($token, '._-'));
            foreach ($members as $p) {
                $first = mb_strtolower(preg_split('/\s+/', trim($p['name']))[0] ?? '');
                $handles = array_filter([$first, mb_strtolower(preg_replace('/\s+/', '', $p['name'])), mb_strtolower(explode('@', $p['email'])[0])]);
                if (in_array($token, $handles, true)) {
                    $found[$p['id']] = true;
                }
            }
        }
        return array_keys($found);
    }

    public function addNote(array $user, int $messageId, string $body): array
    {
        [$mailboxId, $key] = $this->conversation($user['id'], $messageId);
        $body = trim(str_replace("\r\n", "\n", $body));
        if ($body === '') {
            throw new HttpError(422, 'Write a note first.', 'empty');
        }
        if (mb_strlen($body) > 5000) {
            throw new HttpError(422, 'Notes can be up to 5,000 characters.', 'too_long');
        }
        $members = $this->members($mailboxId);
        $mentions = array_values(array_filter(self::mentioned($body, $members), fn ($id) => $id !== $user['id']));
        $id = $this->insertNote($mailboxId, $key, $user['id'], 'note', $body, $mentions);
        $this->notify($mentions, ['title' => mb_substr("{$user['name']} mentioned you", 0, 80), 'body' => mb_substr($body, 0, 140),
            'tag' => "note$id", 'url' => './#m=' . $messageId]);
        return $this->presentNote($this->app->db->one('SELECT * FROM {thread_notes} WHERE id = ?', [$id]), $members, $user);
    }

    private function insertNote(int $mailboxId, string $key, ?int $userId, string $kind, string $body, array $mentions = []): int
    {
        return $this->app->db->insert('INSERT INTO {thread_notes} (mailbox_id, thread_key, user_id, kind, body_enc, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$mailboxId, $key, $userId, $kind, $this->c()->encrypt($body, 'notes.body'), $mentions ? implode(',', array_slice($mentions, 0, 30)) : null, App::now()]);
    }

    /** Your own notes can be deleted; an administrator can delete anyone's. What happened (events) stays. */
    public function deleteNote(array $user, int $noteId): void
    {
        $n = $this->app->db->one('SELECT n.* FROM {thread_notes} n JOIN {user_mailboxes} um ON um.mailbox_id = n.mailbox_id WHERE um.user_id = ? AND n.id = ?', [$user['id'], $noteId]);
        if (!$n || $n['kind'] !== 'note') {
            throw new HttpError(404, 'Note not found', 'not_found');
        }
        if ((int) $n['user_id'] !== $user['id'] && $user['role'] !== 'admin') {
            throw new HttpError(403, 'You can only delete your own notes.', 'forbidden');
        }
        $this->app->db->run('DELETE FROM {thread_notes} WHERE id = ?', [$noteId]);
    }

    private function notify(array $userIds, array $payload): void
    {
        if (!$this->notifyUser) {
            return;
        }
        foreach ($userIds as $id) {
            try {
                ($this->notifyUser)((int) $id, $payload);
            } catch (\Throwable $e) {
                error_log('webmail: notification failed: ' . $e->getMessage());
            }
        }
    }

    // ---------------------------------------------------------------------------------------------- assignment

    /** Assign (assignee_id: a member's id, or null for nobody) and/or set the status. Each change is noted on the conversation. */
    public function assign(array $user, int $messageId, array $in): array
    {
        [$mailboxId, $key] = $this->conversation($user['id'], $messageId);
        $members = $this->members($mailboxId);
        $current = $this->app->db->one('SELECT assignee_id, status FROM {thread_state} WHERE mailbox_id = ? AND thread_key = ?', [$mailboxId, $key])
            ?? ['assignee_id' => null, 'status' => 'open'];
        $assignee = $current['assignee_id'] !== null ? (int) $current['assignee_id'] : null;
        $status = $current['status'];
        $events = [];
        if (array_key_exists('assignee_id', $in)) {
            $new = $in['assignee_id'] === null || $in['assignee_id'] === '' || (int) $in['assignee_id'] === 0 ? null : (int) $in['assignee_id'];
            if ($new !== null && !isset($members[$new])) {
                throw new HttpError(422, 'They can\'t read this mailbox, so it can\'t be assigned to them.', 'not_member');
            }
            if ($new !== $assignee) {
                $events[] = $new === null ? 'unassigned this' : ($new === $user['id'] ? 'took this' : 'assigned this to ' . $members[$new]['name']);
                $assignee = $new;
                if ($new !== null && $new !== $user['id']) {
                    $this->notify([$new], ['title' => mb_substr("{$user['name']} assigned you a conversation", 0, 80),
                        'body' => mb_substr($this->subjectOf($messageId), 0, 140), 'tag' => "assign$messageId", 'url' => './#m=' . $messageId]);
                }
            }
        }
        if (array_key_exists('status', $in)) {
            $new = (string) $in['status'];
            if (!isset(self::STATUSES[$new])) {
                throw new HttpError(422, 'Unknown status', 'bad_status');
            }
            if ($new !== $status) {
                $events[] = 'marked this ' . self::STATUSES[$new];
                $status = $new;
            }
        }
        if ($events) {
            $this->app->db->run('INSERT INTO {thread_state} (mailbox_id, thread_key, assignee_id, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE assignee_id = VALUES(assignee_id), status = VALUES(status), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)',
                [$mailboxId, $key, $assignee, $status, $user['id'], App::now()]);
            $this->insertNote($mailboxId, $key, $user['id'], 'event', implode(' and ', $events));
        }
        return $this->thread($user, $messageId);
    }

    private function subjectOf(int $messageId): string
    {
        $enc = $this->app->db->value('SELECT subject_enc FROM {messages} WHERE id = ?', [$messageId]);
        return (string) ($this->c()->decrypt($enc, 'messages.subject') ?: '(no subject)');
    }

    /** New email from the customer: a resolved conversation is open again. */
    public function newMail(array $stored): void
    {
        foreach ($stored as $s) {
            $row = $this->app->db->one('SELECT id, mailbox_id, thread_key, folder FROM {messages} WHERE id = ?', [$s['id']]);
            if (!$row || $row['folder'] === 'spam') {
                continue;
            }
            $key = self::key($row);
            $n = $this->app->db->run("UPDATE {thread_state} SET status = 'open', updated_by = NULL, updated_at = ? WHERE mailbox_id = ? AND thread_key = ? AND status = 'resolved'",
                [App::now(), $row['mailbox_id'], $key])->rowCount();
            if ($n) {
                $this->insertNote((int) $row['mailbox_id'], $key, null, 'event', 'reopened: a new email arrived');
            }
        }
    }

    /**
     * Each listed message's assignment, for the list (shared mailboxes only): id => {assignee_id, assignee, status}.
     * @param array<int, array{id:int, mailbox_id:int, thread_key:?string}> $messages
     */
    public function forList(array $messages): array
    {
        $byMailbox = [];
        foreach ($messages as $m) {
            $byMailbox[$m['mailbox_id']][$m['id']] = self::key($m);
        }
        $out = [];
        foreach ($byMailbox as $mailboxId => $keys) {
            $members = $this->members((int) $mailboxId);
            if (count($members) < 2) {
                continue;
            }
            $in = implode(', ', array_fill(0, count($keys), '?'));
            $states = [];
            foreach ($this->app->db->all("SELECT thread_key, assignee_id, status FROM {thread_state} WHERE mailbox_id = ? AND thread_key IN ($in)", array_merge([(int) $mailboxId], array_values(array_unique($keys)))) as $r) {
                $states[$r['thread_key']] = $r;
            }
            foreach ($keys as $id => $key) {
                $st = $states[$key] ?? null;
                $assignee = $st && $st['assignee_id'] !== null ? (int) $st['assignee_id'] : null;
                $out[$id] = ['assignee_id' => $assignee, 'assignee' => $assignee !== null ? $this->nameOf($assignee, $members) : null, 'status' => $st['status'] ?? 'open'];
            }
        }
        return $out;
    }

    /**
     * SQL to narrow a message list: "mine", "unassigned" or a status. Joins the conversation's state as ts.
     * @return array{0: string, 1: string[], 2: array} join, conditions, parameters
     */
    public static function listFilter(int $userId, string $filter): array
    {
        $join = "LEFT JOIN {thread_state} ts ON ts.mailbox_id = m.mailbox_id AND ts.thread_key = COALESCE(m.thread_key, CONCAT('m', m.id))";
        return match ($filter) {
            'mine' => [$join, ['ts.assignee_id = ?'], [$userId]],
            'unassigned' => [$join, ['ts.assignee_id IS NULL'], []],
            'open', 'in_progress' => [$join, ["COALESCE(ts.status, 'open') = ?"], [$filter]],
            'resolved' => [$join, ["ts.status = 'resolved'"], []],
            default => ['', [], []],
        };
    }

    // ---------------------------------------------------------------------------------------------- shared replies

    private static function fields(array $f): array
    {
        $str = fn (string $k, int $max) => mb_substr((string) ($f[$k] ?? ''), 0, $max);
        $html = (string) ($f['html'] ?? '');
        if (strlen($html) > 500000) {
            throw new HttpError(422, 'The reply is too long.', 'too_long');
        }
        return ['to' => $str('to', 2000), 'cc' => $str('cc', 2000), 'bcc' => $str('bcc', 2000), 'subject' => $str('subject', 998),
            'html' => $html, 'text' => $str('text', 200000), 'signature' => !array_key_exists('signature', $f) || (bool) $f['signature']];
    }

    private function draftRow(int $userId, int $draftId): array
    {
        $row = $this->app->db->one('SELECT d.* FROM {shared_drafts} d JOIN {user_mailboxes} um ON um.mailbox_id = d.mailbox_id WHERE um.user_id = ? AND d.id = ?', [$userId, $draftId]);
        if (!$row) {
            throw new HttpError(404, 'This shared reply has been sent or deleted.', 'draft_gone');
        }
        return $row;
    }

    /** Start the conversation's shared reply, or join it if someone already has. */
    public function startDraft(array $user, int $messageId, array $fields): array
    {
        [$mailboxId, $key] = $this->conversation($user['id'], $messageId);
        if (count($this->members($mailboxId)) < 2) {
            throw new HttpError(422, 'Only you can read this mailbox, so there\'s no one to write with.', 'not_shared');
        }
        $now = App::now();
        $made = $this->app->db->run('INSERT IGNORE INTO {shared_drafts} (mailbox_id, thread_key, reply_to_id, fields_enc, version, created_by, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)', [$mailboxId, $key, $messageId, $this->c()->encryptJson(self::fields($fields), 'drafts.fields'), $user['id'], $user['id'], $now, $now])->rowCount();
        $id = (int) $this->app->db->value('SELECT id FROM {shared_drafts} WHERE mailbox_id = ? AND thread_key = ?', [$mailboxId, $key]);
        if ($made) {
            $this->insertNote($mailboxId, $key, $user['id'], 'event', 'started a shared reply');
        }
        return $this->draft($user, $id, true);
    }

    /** The shared reply, with who has it open. Reading it counts as having it open. */
    public function draft(array $user, int $draftId, bool $present): array
    {
        $row = $this->draftRow($user['id'], $draftId);
        if ($present) {
            $this->app->db->run('INSERT INTO {draft_presence} (draft_id, user_id, seen_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE seen_at = VALUES(seen_at)', [$draftId, $user['id'], time()]);
        }
        $members = $this->members((int) $row['mailbox_id']);
        return ['id' => (int) $row['id'], 'version' => (int) $row['version'], 'mailbox_id' => (int) $row['mailbox_id'], 'reply_to_id' => $row['reply_to_id'] !== null ? (int) $row['reply_to_id'] : null,
            'fields' => $this->c()->decryptJson($row['fields_enc'], 'drafts.fields'), 'updated_by' => $this->nameOf($row['updated_by'] !== null ? (int) $row['updated_by'] : null, $members),
            'updated_by_id' => $row['updated_by'] !== null ? (int) $row['updated_by'] : null, 'updated_at' => gmdate('c', strtotime($row['updated_at'] . ' UTC'))]
            + $this->draftSummary((int) $row['id'], $members, $user['id']);
    }

    /** Who else has the shared reply open right now, and who's typing. */
    private function draftSummary(int $draftId, array $members, int $me): array
    {
        $editors = [];
        foreach ($this->app->db->all('SELECT user_id, seen_at, typing_at FROM {draft_presence} WHERE draft_id = ? AND seen_at >= ?', [$draftId, time() - self::PRESENT_SECONDS]) as $p) {
            if ((int) $p['user_id'] !== $me) {
                $editors[] = ['id' => (int) $p['user_id'], 'name' => $this->nameOf((int) $p['user_id'], $members), 'typing' => (int) $p['typing_at'] >= time() - self::TYPING_SECONDS];
            }
        }
        $by = $this->app->db->value('SELECT created_by FROM {shared_drafts} WHERE id = ?', [$draftId]);
        return ['id' => $draftId, 'editors' => $editors, 'started_by' => $this->nameOf($by !== null ? (int) $by : null, $members)];
    }

    /**
     * Save a change made to version $base. If someone saved since, nothing is changed and the newer version comes back
     * (status 409) for the page to merge with and try again.
     */
    public function saveDraft(array $user, int $draftId, int $base, array $fields): array
    {
        $this->draftRow($user['id'], $draftId);
        $fields = self::fields($fields);
        $saved = $this->app->db->tx(function (Db $db) use ($user, $draftId, $base, $fields) {
            $version = (int) $db->value('SELECT version FROM {shared_drafts} WHERE id = ? FOR UPDATE', [$draftId]);
            if ($version !== $base) {
                return false;
            }
            $db->run('UPDATE {shared_drafts} SET fields_enc = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?',
                [$this->c()->encryptJson($fields, 'drafts.fields'), $user['id'], App::now(), $draftId]);
            return true;
        });
        $this->app->db->run('INSERT INTO {draft_presence} (draft_id, user_id, seen_at, typing_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE seen_at = VALUES(seen_at), typing_at = VALUES(typing_at)',
            [$draftId, $user['id'], time(), $saved ? time() : 0]);
        $draft = $this->draft($user, $draftId, false);
        if (!$saved) {
            throw new HttpError(409, 'Someone else changed it first.', 'conflict', ['draft' => $draft]);
        }
        return $draft;
    }

    public function deleteDraft(array $user, int $draftId): void
    {
        $row = $this->draftRow($user['id'], $draftId);
        $this->app->db->run('DELETE FROM {shared_drafts} WHERE id = ?', [$draftId]);
        $this->insertNote((int) $row['mailbox_id'], $row['thread_key'], $user['id'], 'event', 'deleted the shared reply');
    }

    /** Sent: the shared reply is done (whoever sent it). Called by Mailstore::send. */
    public function sent(array $user, int $draftId, int $mailboxId): void
    {
        $row = $this->app->db->one('SELECT * FROM {shared_drafts} WHERE id = ? AND mailbox_id = ?', [$draftId, $mailboxId]);
        if (!$row) {
            return;
        }
        $this->app->db->run('DELETE FROM {shared_drafts} WHERE id = ?', [$draftId]);
        $this->insertNote($mailboxId, $row['thread_key'], $user['id'], 'event', 'sent the shared reply');
    }
}
