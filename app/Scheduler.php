<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Send later: an email written now and sent at a time chosen for it. It's kept here (encrypted, attachments and all)
 * until then, and Due sends it when its time comes, through Mailstore::send as if Send had been pressed then.
 *
 * Until it's sent it can be sent now, moved to another time, or taken back to edit. A send that fails for good (a bad
 * address, the mailbox gone) is kept, marked failed, with the reason, and its writer is notified; one that fails
 * because GhostParse couldn't be reached is tried again a few times. One that was being sent when the server stopped is
 * never sent twice: it's marked failed, to check in Sent.
 */
final class Scheduler
{
    public const MAX_WAITING = 200;
    private const RETRIES = 5;
    /** A send still marked "sending" after this long was cut off (the request was stopped). */
    private const STALE_SECONDS = 600;

    /** Sends a notification to one person's devices: fn(int $userId, array $payload). Replaced in tests. */
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
        switch ("$method $action") {
            case 'GET scheduled':
                Http::json(['scheduled' => $this->list($user['id'])]);
            case 'POST scheduled':
                Http::json($this->schedule($user, (int) ($in['mailbox_id'] ?? 0), $in, self::time($in['send_at'] ?? null)), 201);
            case 'POST scheduled/time':
                Http::json($this->reschedule($user, (int) ($in['id'] ?? 0), self::time($in['send_at'] ?? null)));
            case 'POST scheduled/send':
                Http::json($this->sendNow($user, (int) ($in['id'] ?? 0)));
            case 'POST scheduled/cancel':
                // Taken back to edit: the page opens it in a compose window, as it was.
                Http::json(['payload' => $this->cancel($user, (int) ($in['id'] ?? 0))]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    public static function time(mixed $value): \DateTimeImmutable
    {
        try {
            $t = new \DateTimeImmutable(is_string($value) && $value !== '' ? $value : 'invalid');
        } catch (\Exception) {
            throw new HttpError(422, 'Choose a date and time', 'bad_time');
        }
        return $t;
    }

    private static function check(\DateTimeInterface $at): string
    {
        if ($at->getTimestamp() < time() + 60) {
            throw new HttpError(422, 'Choose a time at least a minute from now', 'bad_time');
        }
        if ($at->getTimestamp() > time() + 366 * 86400) {
            throw new HttpError(422, 'Choose a time within a year', 'bad_time');
        }
        return gmdate('Y-m-d H:i:s', $at->getTimestamp());
    }

    /** Keep an email to send at $at. $in is what Send would get. Returns the scheduled email. */
    public function schedule(array $user, int $mailboxId, array $in, \DateTimeInterface $at): array
    {
        $store = new Mailstore($this->app);
        $store->mailbox($user['id'], $mailboxId);
        $sendAt = self::check($at);
        if (!empty($in['shared_draft_id'])) {
            throw new HttpError(422, 'A reply written together is sent straight away: send it, or write it on your own to send it later', 'shared');
        }
        // Checked now, so a mistake shows while it's being written, not when it's due.
        $to = Mailstore::addresses($in['to'] ?? []);
        $cc = Mailstore::addresses($in['cc'] ?? []);
        $bcc = Mailstore::addresses($in['bcc'] ?? []);
        if (!$to && !$cc && !$bcc) {
            throw new HttpError(422, 'Add at least one recipient', 'no_recipients');
        }
        foreach ($in['attachments'] ?? [] as $a) {
            if (!isset($a['filename'], $a['content']) || base64_decode((string) $a['content'], true) === false) {
                throw new HttpError(422, 'An attachment is incomplete', 'bad_attachment');
            }
        }
        if ((int) $this->app->db->value("SELECT COUNT(*) FROM {scheduled} WHERE user_id = ? AND status = 'waiting'", [$user['id']]) >= self::MAX_WAITING) {
            throw new HttpError(422, 'You have ' . self::MAX_WAITING . ' emails waiting to be sent already', 'too_many');
        }
        $draftId = (int) ($in['draft_id'] ?? 0);
        $payload = array_intersect_key($in, array_flip(['to', 'cc', 'bcc', 'subject', 'html', 'text', 'reply_to_id', 'forward_of', 'attachments', 'signature']));
        $payload['mailbox_id'] = $mailboxId;
        $summary = ['to' => array_merge($to, $cc, $bcc), 'subject' => trim((string) ($in['subject'] ?? '')),
            'snippet' => mb_substr(trim(preg_replace('/\s+/u', ' ', (string) ($in['text'] ?? '')) ?? ''), 0, 180),
            'attachments' => count($in['attachments'] ?? [])];
        $id = $this->app->db->insert('INSERT INTO {scheduled} (user_id, mailbox_id, send_at, payload_enc, summary_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [$user['id'], $mailboxId, $sendAt, $this->c()->encryptJson($payload, 'scheduled.payload'), $this->c()->encryptJson($summary, 'scheduled.summary'), App::now()]);
        // It's not a draft any more: it's waiting to go.
        if ($draftId) {
            $store->delete($user['id'], [$draftId]);
        }
        return $this->one($user['id'], $id);
    }

    /** The user's emails waiting to be sent (and ones that failed), soonest first. */
    public function list(int $userId): array
    {
        return array_map(fn ($r) => $this->present($r), $this->app->db->all('SELECT * FROM {scheduled} WHERE user_id = ? ORDER BY send_at, id', [$userId]));
    }

    private function present(array $r): array
    {
        $s = $this->c()->decryptJson($r['summary_enc'], 'scheduled.summary') ?? [];
        return ['id' => (int) $r['id'], 'mailbox_id' => (int) $r['mailbox_id'], 'send_at' => gmdate('c', strtotime($r['send_at'] . ' UTC')),
            'status' => $r['status'], 'error' => $this->c()->decrypt($r['error_enc'], 'scheduled.error'),
            'to' => $s['to'] ?? [], 'subject' => (string) ($s['subject'] ?? ''), 'snippet' => (string) ($s['snippet'] ?? ''), 'attachments' => (int) ($s['attachments'] ?? 0)];
    }

    private function row(int $userId, int $id): array
    {
        $r = $this->app->db->one('SELECT * FROM {scheduled} WHERE id = ? AND user_id = ?', [$id, $userId]);
        return $r ?? throw new HttpError(404, "That email isn't waiting to be sent any more", 'not_found');
    }

    private function one(int $userId, int $id): array
    {
        return $this->present($this->row($userId, $id));
    }

    /** Take it out of the queue before it starts sending; null when it already has. */
    private function claim(int $id, array $statuses): bool
    {
        $in = implode(', ', array_fill(0, count($statuses), '?'));
        return $this->app->db->run("UPDATE {scheduled} SET status = 'sending', claimed_at = ? WHERE id = ? AND status IN ($in)", array_merge([App::now(), $id], $statuses))->rowCount() === 1;
    }

    public function reschedule(array $user, int $id, \DateTimeInterface $at): array
    {
        $this->row($user['id'], $id);
        $n = $this->app->db->run("UPDATE {scheduled} SET send_at = ?, status = 'waiting', attempts = 0, error_enc = NULL WHERE id = ? AND user_id = ? AND status <> 'sending'",
            [self::check($at), $id, $user['id']])->rowCount();
        if (!$n && $this->row($user['id'], $id)['status'] === 'sending') {
            throw new HttpError(409, "It's being sent now", 'sending');
        }
        return $this->one($user['id'], $id);
    }

    /** Take it back (to edit it, or not send it). Returns what was written, for a compose window. */
    public function cancel(array $user, int $id): array
    {
        $row = $this->row($user['id'], $id);
        if (!$this->app->db->run("DELETE FROM {scheduled} WHERE id = ? AND user_id = ? AND status <> 'sending'", [$id, $user['id']])->rowCount()) {
            throw new HttpError(409, "It's being sent now", 'sending');
        }
        return $this->c()->decryptJson($row['payload_enc'], 'scheduled.payload') ?? [];
    }

    public function sendNow(array $user, int $id): array
    {
        $this->row($user['id'], $id);
        if (!$this->claim($id, ['waiting', 'failed'])) {
            throw new HttpError(409, "It's being sent now", 'sending');
        }
        $result = $this->deliver($this->app->db->one('SELECT * FROM {scheduled} WHERE id = ?', [$id]), false);
        if (isset($result['error'])) {
            throw new HttpError(422, $result['error'], 'send_failed');
        }
        return $result;
    }

    /**
     * Send what's due (oldest first), within $seconds. Returns how many were sent. Each is claimed first, so two
     * requests running this at once never send the same email.
     */
    public function runDue(int $seconds = 20, int $limit = 20): int
    {
        $db = $this->app->db;
        $start = microtime(true);
        // Cut off mid-send: it may have gone. Never sent again on its own.
        foreach ($db->all("SELECT * FROM {scheduled} WHERE status = 'sending' AND claimed_at < ?", [gmdate('Y-m-d H:i:s', time() - self::STALE_SECONDS)]) as $r) {
            $this->failed($r, "Sending it was cut off, so it may or may not have gone: check Sent, then send it again if it isn't there.");
        }
        $sent = 0;
        foreach ($db->all("SELECT id FROM {scheduled} WHERE status = 'waiting' AND send_at <= ? ORDER BY send_at, id LIMIT " . max(1, $limit), [App::now()]) as $r) {
            if (microtime(true) - $start > $seconds) {
                break;
            }
            if (!$this->claim((int) $r['id'], ['waiting'])) {
                continue;
            }
            $result = $this->deliver($db->one('SELECT * FROM {scheduled} WHERE id = ?', [$r['id']]), true);
            $sent += isset($result['error']) ? 0 : 1;
        }
        return $sent;
    }

    /** Send one claimed email. On success it leaves the queue (it's in Sent now). */
    private function deliver(array $row, bool $retry): array
    {
        $db = $this->app->db;
        $u = $db->one('SELECT id, email_enc, name_enc, role, disabled FROM {users} WHERE id = ?', [$row['user_id']]);
        if (!$u || $u['disabled']) {
            $this->failed($row, "Not sent: the account that wrote it can't sign in any more.");
            return ['error' => 'Not sent'];
        }
        $user = ['id' => (int) $u['id'], 'email' => $this->c()->decrypt($u['email_enc'], 'users.email'), 'name' => $this->c()->decrypt($u['name_enc'], 'users.name') ?? '', 'role' => $u['role']];
        $payload = $this->c()->decryptJson($row['payload_enc'], 'scheduled.payload') ?? [];
        try {
            $result = (new Mailstore($this->app))->send($user, (int) $row['mailbox_id'], $payload);
        } catch (HttpError $e) {
            $attempts = (int) $row['attempts'] + 1;
            if ($retry && $e->status >= 500 && $attempts < self::RETRIES) {
                // GhostParse couldn't be reached: again in 2, 4, 8, 16 minutes.
                $db->run("UPDATE {scheduled} SET status = 'waiting', attempts = ?, send_at = ?, claimed_at = NULL, error_enc = ? WHERE id = ?",
                    [$attempts, gmdate('Y-m-d H:i:s', time() + 60 * (2 ** $attempts)), $this->c()->encrypt($e->getMessage(), 'scheduled.error'), $row['id']]);
                return ['error' => $e->getMessage()];
            }
            $this->failed($row, $e->getMessage());
            return ['error' => $e->getMessage()];
        }
        $db->run('DELETE FROM {scheduled} WHERE id = ?', [$row['id']]);
        return $result;
    }

    private function failed(array $row, string $reason): void
    {
        $this->app->db->run("UPDATE {scheduled} SET status = 'failed', claimed_at = NULL, error_enc = ? WHERE id = ?", [$this->c()->encrypt($reason, 'scheduled.error'), $row['id']]);
        $s = $this->c()->decryptJson($row['summary_enc'], 'scheduled.summary') ?? [];
        if ($this->notifyUser) {
            try {
                ($this->notifyUser)((int) $row['user_id'], ['title' => 'A scheduled email wasn\'t sent', 'body' => mb_substr((($s['subject'] ?? '') ?: '(no subject)') . ': ' . $reason, 0, 200),
                    'tag' => 'scheduled' . $row['id'], 'url' => './#scheduled']);
            } catch (\Throwable $e) {
                error_log('webmail: notification failed: ' . $e->getMessage());
            }
        }
    }
}
