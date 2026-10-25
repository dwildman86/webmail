<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Mailboxes and messages: storing what GhostParse delivers, listing and searching it, reading conversations, and sending.
 * Everything personal is encrypted before it reaches the database (see Crypto); folders, flags and dates aren't.
 */
final class Mailstore
{
    public const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'];
    private const PAGE = 50;
    /** Inline images up to this size are shown in the message (as data: URLs); bigger ones are attachments. */
    private const INLINE_LIMIT = 2 * 1024 * 1024;

    public function __construct(private App $app)
    {
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    // ------------------------------------------------------------------------------------------------- mailboxes

    public function addressIndex(string $address): string
    {
        return $this->c()->blindIndex(mb_strtolower(trim($address)), 'mailboxes.address');
    }

    public function createMailbox(string $address, string $displayName = '', string $signature = ''): int
    {
        $address = mb_strtolower(trim($address));
        if (!filter_var($address, FILTER_VALIDATE_EMAIL)) {
            throw new HttpError(422, "$address isn't a valid email address", 'invalid_address');
        }
        $existing = $this->app->db->value('SELECT id FROM {mailboxes} WHERE address_bidx = ?', [$this->addressIndex($address)]);
        if ($existing) {
            return (int) $existing;
        }
        $c = $this->c();
        return $this->app->db->insert(
            'INSERT INTO {mailboxes} (address_bidx, address_enc, display_name_enc, signature_enc, created_at) VALUES (?, ?, ?, ?, ?)',
            [$this->addressIndex($address), $c->encrypt($address, 'mailboxes.address'), $c->encrypt($displayName, 'mailboxes.display_name'),
                $c->encrypt($signature, 'mailboxes.signature'), App::now()],
        );
    }

    public function grant(int $userId, int $mailboxId): void
    {
        $this->app->db->run('INSERT IGNORE INTO {user_mailboxes} (user_id, mailbox_id) VALUES (?, ?)', [$userId, $mailboxId]);
    }

    public function revoke(int $userId, int $mailboxId): void
    {
        $this->app->db->run('DELETE FROM {user_mailboxes} WHERE user_id = ? AND mailbox_id = ?', [$userId, $mailboxId]);
    }

    public function updateMailbox(int $mailboxId, array $fields): void
    {
        $c = $this->c();
        if (array_key_exists('display_name', $fields)) {
            $this->app->db->run('UPDATE {mailboxes} SET display_name_enc = ? WHERE id = ?', [$c->encrypt(mb_substr((string) $fields['display_name'], 0, 100), 'mailboxes.display_name'), $mailboxId]);
        }
        if (array_key_exists('signature', $fields)) {
            $this->app->db->run('UPDATE {mailboxes} SET signature_enc = ? WHERE id = ?', [$c->encrypt(mb_substr((string) $fields['signature'], 0, 5000), 'mailboxes.signature'), $mailboxId]);
        }
    }

    private function presentMailbox(array $r): array
    {
        $c = $this->c();
        return ['id' => (int) $r['id'], 'address' => $c->decrypt($r['address_enc'], 'mailboxes.address'),
            'display_name' => $c->decrypt($r['display_name_enc'], 'mailboxes.display_name') ?? '',
            'signature' => $c->decrypt($r['signature_enc'], 'mailboxes.signature') ?? ''];
    }

    /** The mailboxes a user can use, with unread counts per folder. */
    public function mailboxesFor(int $userId): array
    {
        $rows = $this->app->db->all('SELECT m.* FROM {mailboxes} m JOIN {user_mailboxes} um ON um.mailbox_id = m.id WHERE um.user_id = ? ORDER BY m.id', [$userId]);
        $out = array_map(fn ($r) => $this->presentMailbox($r), $rows);
        foreach ($out as &$m) {
            $m['unread'] = array_fill_keys(self::FOLDERS, 0);
            foreach ($this->app->db->all('SELECT folder, COUNT(*) AS n FROM {messages} WHERE mailbox_id = ? AND is_read = 0 GROUP BY folder', [$m['id']]) as $r) {
                $m['unread'][$r['folder']] = (int) $r['n'];
            }
        }
        return $out;
    }

    public function allMailboxes(): array
    {
        $rows = $this->app->db->all('SELECT * FROM {mailboxes} ORDER BY id');
        $out = [];
        foreach ($rows as $r) {
            $m = $this->presentMailbox($r);
            $m['users'] = array_map('intval', array_column($this->app->db->all('SELECT user_id FROM {user_mailboxes} WHERE mailbox_id = ?', [$r['id']]), 'user_id'));
            $out[] = $m;
        }
        return $out;
    }

    /** A mailbox the user can use (404 otherwise). */
    public function mailbox(int $userId, int $mailboxId): array
    {
        return $this->requireMailbox($userId, $mailboxId);
    }

    private function requireMailbox(int $userId, int $mailboxId): array
    {
        $row = $this->app->db->one('SELECT m.* FROM {mailboxes} m JOIN {user_mailboxes} um ON um.mailbox_id = m.id WHERE um.user_id = ? AND m.id = ?', [$userId, $mailboxId]);
        if (!$row) {
            throw new HttpError(404, 'Mailbox not found', 'not_found');
        }
        return $this->presentMailbox($row);
    }

    // ------------------------------------------------------------------------------------------------- receiving

    /**
     * Store an email.received event's data in each of the app's mailboxes it was sent to. Returns the new message ids
     * (none when no mailbox matches, or it's already stored: GhostParse may deliver the same event twice).
     *
     * @return array<int, array{id:int, mailbox_id:int}>
     */
    public function storeInbound(array $data): array
    {
        $addresses = [];
        foreach ($data['recipients'] ?? [] as $r) {
            $addresses[] = $r['base_address'] ?? $r['address'] ?? '';
        }
        foreach ($data['envelope']['rcpt_to'] ?? [] as $a) {
            $addresses[] = preg_replace('/\+[^@]*@/', '@', $a);
        }
        $mailboxIds = [];
        foreach (array_unique(array_filter(array_map('mb_strtolower', $addresses))) as $address) {
            $id = $this->app->db->value('SELECT id FROM {mailboxes} WHERE address_bidx = ?', [$this->addressIndex($address)]);
            if ($id) {
                $mailboxIds[(int) $id] = true;
            }
        }
        $stored = [];
        foreach (array_keys($mailboxIds) as $mailboxId) {
            $id = $this->storeOne($mailboxId, $data, $this->folderFor($data));
            if ($id) {
                $stored[] = ['id' => $id, 'mailbox_id' => $mailboxId];
            }
        }
        return $stored;
    }

    private function folderFor(array $data): string
    {
        $action = $data['spam']['action'] ?? null;
        if ($action !== null && $action !== 'no action' && $action !== 'greylist') {
            return 'spam';
        }
        if (!empty($data['virus']['infected'])) {
            return 'spam';
        }
        return 'inbox';
    }

    /**
     * Store a message imported from an old mailbox (as GhostParse's parse returns it). $key identifies it in this
     * mailbox (from its Message-ID), so importing again, or the same message in two folders, keeps one copy.
     * null when it's there already.
     */
    public function storeImported(int $mailboxId, array $data, string $folder, bool $read, bool $starred, string $key): ?int
    {
        $data['id'] = $key;
        $id = $this->storeOne($mailboxId, $data, $folder, $read);
        if ($id && $starred) {
            $this->app->db->run('UPDATE {messages} SET is_starred = 1 WHERE id = ?', [$id]);
        }
        return $id;
    }

    /** Store one message (received or sent) in a mailbox. null when it's there already. */
    private function storeOne(int $mailboxId, array $data, string $folder, bool $read = false): ?int
    {
        $c = $this->c();
        $db = $this->app->db;
        $gpId = $data['id'] ?? null;
        if ($gpId && $db->value('SELECT id FROM {messages} WHERE mailbox_id = ? AND gp_id = ?', [$mailboxId, $gpId])) {
            return null;
        }
        $text = (string) ($data['text'] ?? '');
        $html = $data['html'] ?? null;
        if ($text === '' && $html) {
            $text = trim(html_entity_decode(strip_tags(preg_replace('/<(br|\/p|\/div|\/li)\b[^>]*>/i', "\n", $html)), ENT_QUOTES | ENT_HTML5));
        }
        $snippetSource = trim((string) ($data['reply_text'] ?? '')) ?: $text;
        $snippet = mb_substr(trim(preg_replace('/\s+/u', ' ', $snippetSource)), 0, 180);
        $attachments = $data['attachments'] ?? [];
        $files = array_filter($attachments, fn ($a) => ($a['disposition'] ?? 'attachment') !== 'inline' || empty($a['content_id']));
        $date = strtotime((string) ($data['date'] ?? $data['received_at'] ?? 'now')) ?: time();
        if ($date > time() + 86400) {
            $date = time(); // a sender's clock in the future would pin it to the top
        }
        $meta = [
            'message_id' => $data['message_id'] ?? null,
            'in_reply_to' => $data['in_reply_to'] ?? null,
            'references' => $data['references'] ?? [],
            'headers' => $data['headers'] ?? (object) [],
            'authentication' => $data['authentication'] ?? null,
            'spam' => isset($data['spam']['score']) ? ['score' => $data['spam']['score'], 'action' => $data['spam']['action'] ?? null] : null,
            'auto_submitted' => $data['auto_submitted'] ?? null,
            'thread_id' => $data['thread_id'] ?? null,
        ];
        $id = $db->tx(function (Db $db) use ($c, $mailboxId, $folder, $gpId, $data, $text, $html, $snippet, $meta, $attachments, $files, $date, $read) {
            $id = $db->insert(
                'INSERT INTO {messages} (mailbox_id, folder, gp_id, thread_key, from_enc, to_enc, subject_enc, snippet_enc, body_enc, meta_enc,
                    sent_at, is_read, has_attachments, size, auth_verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$mailboxId, $folder, $gpId, $data['thread_id'] ?? $data['message_id'] ?? $gpId,
                    $c->encryptJson($data['from'] ?? null, 'messages.from'),
                    $c->encryptJson(['to' => $data['to'] ?? [], 'cc' => $data['cc'] ?? [], 'bcc' => $data['bcc'] ?? [], 'reply_to' => $data['reply_to'] ?? []], 'messages.to'),
                    $c->encrypt((string) ($data['subject'] ?? ''), 'messages.subject'),
                    $c->encrypt($snippet, 'messages.snippet'),
                    $c->encryptJson(['text' => $text, 'html' => $html, 'reply_text' => $data['reply_text'] ?? null], 'messages.body'),
                    $c->encryptJson($meta, 'messages.meta'),
                    gmdate('Y-m-d H:i:s', $date), $read ? 1 : 0, count($files) > 0 ? 1 : 0, (int) ($data['size'] ?? strlen($text . $html)),
                    $data['authentication']['verdict'] ?? null, App::now()],
            );
            foreach ($attachments as $a) {
                $content = isset($a['content']) && is_string($a['content']) ? base64_decode($a['content'], true) : null;
                $db->run(
                    'INSERT INTO {attachments} (message_id, filename_enc, content_type, size, content_id_enc, inline, content_enc, url_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [$id, $c->encrypt((string) ($a['filename'] ?? 'attachment'), 'attachments.filename'), substr((string) ($a['content_type'] ?? 'application/octet-stream'), 0, 255),
                        (int) ($a['size'] ?? strlen((string) $content)), $c->encrypt(isset($a['content_id']) ? trim($a['content_id'], '<>') : null, 'attachments.content_id'),
                        ($a['disposition'] ?? '') === 'inline' && !empty($a['content_id']) ? 1 : 0,
                        $content === null || $content === false ? null : $c->encrypt($content, 'attachments.content'),
                        $c->encrypt($a['storage']['url'] ?? null, 'attachments.url')],
                );
            }
            $this->index($db, $id, $data, $text);
            return $id;
        });
        return $id;
    }

    /** Blind-index the words of the subject, people and text, so search works without decrypting every message. */
    private function index(Db $db, int $messageId, array $data, string $text): void
    {
        $people = [];
        foreach (array_merge([$data['from'] ?? null], $data['to'] ?? [], $data['cc'] ?? []) as $p) {
            if ($p) {
                $people[] = ($p['name'] ?? '') . ' ' . ($p['address'] ?? '');
            }
        }
        $names = array_map(fn ($a) => (string) ($a['filename'] ?? ''), $data['attachments'] ?? []);
        $words = Crypto::words(implode(' ', [(string) ($data['subject'] ?? ''), implode(' ', $people), implode(' ', $names), mb_substr($text, 0, 20000)]));
        foreach (array_chunk($words, 200) as $chunk) {
            $params = [];
            foreach ($chunk as $w) {
                $params[] = $messageId;
                $params[] = $this->c()->blindIndex($w, 'search');
            }
            $db->run('INSERT IGNORE INTO {search} (message_id, token) VALUES ' . implode(', ', array_fill(0, count($chunk), '(?, ?)')), $params);
        }
    }

    // ------------------------------------------------------------------------------------------------- reading

    /** A page of a folder (or search results across a mailbox's folders, or all the user's mailboxes). */
    public function list(int $userId, ?int $mailboxId, string $folder, int $page = 1, string $query = '', bool $starredOnly = false): array
    {
        if (!in_array($folder, self::FOLDERS, true) && $folder !== 'all') {
            throw new HttpError(422, 'Unknown folder', 'bad_folder');
        }
        $where = ['um.user_id = ?'];
        $params = [$userId];
        if ($mailboxId) {
            $this->requireMailbox($userId, $mailboxId);
            $where[] = 'm.mailbox_id = ?';
            $params[] = $mailboxId;
        }
        if ($folder !== 'all') {
            $where[] = 'm.folder = ?';
            $params[] = $folder;
        } elseif ($query === '') {
            $where[] = "m.folder <> 'trash' AND m.folder <> 'spam'";
        }
        if ($starredOnly) {
            $where[] = 'm.is_starred = 1';
        }
        $join = '';
        if (trim($query) !== '') {
            $tokens = array_slice(Crypto::words($query, 10), 0, 10);
            if (!$tokens) {
                return ['messages' => [], 'page' => $page, 'has_more' => false];
            }
            $in = implode(', ', array_fill(0, count($tokens), '?'));
            $join = "JOIN (SELECT message_id FROM {search} WHERE token IN ($in) GROUP BY message_id HAVING COUNT(DISTINCT token) = ?) s ON s.message_id = m.id";
            $params = array_merge(array_map(fn ($t) => $this->c()->blindIndex($t, 'search'), $tokens), [count($tokens)], $params);
        }
        $offset = (max(1, $page) - 1) * self::PAGE;
        $rows = $this->app->db->all(
            "SELECT m.id, m.mailbox_id, m.folder, m.thread_key, m.from_enc, m.to_enc, m.subject_enc, m.snippet_enc, m.sent_at, m.is_read, m.is_starred,
                m.has_attachments, m.auth_verdict
             FROM {messages} m $join JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id
             WHERE " . implode(' AND ', $where) . ' ORDER BY m.sent_at DESC, m.id DESC LIMIT ' . (self::PAGE + 1) . " OFFSET $offset",
            $params,
        );
        $more = count($rows) > self::PAGE;
        return ['messages' => array_map(fn ($r) => $this->summary($r), array_slice($rows, 0, self::PAGE)), 'page' => $page, 'has_more' => $more];
    }

    private function summary(array $r): array
    {
        $c = $this->c();
        $to = $c->decryptJson($r['to_enc'], 'messages.to') ?? [];
        return [
            'id' => (int) $r['id'], 'mailbox_id' => (int) $r['mailbox_id'], 'folder' => $r['folder'], 'thread_key' => $r['thread_key'],
            'from' => $c->decryptJson($r['from_enc'], 'messages.from'), 'to' => $to['to'] ?? [],
            'subject' => $c->decrypt($r['subject_enc'], 'messages.subject'), 'snippet' => $c->decrypt($r['snippet_enc'], 'messages.snippet'),
            'date' => gmdate('c', strtotime($r['sent_at'] . ' UTC')), 'read' => (bool) $r['is_read'], 'starred' => (bool) $r['is_starred'],
            'has_attachments' => (bool) $r['has_attachments'], 'auth' => $r['auth_verdict'],
        ];
    }

    private function row(int $userId, int $messageId): array
    {
        $row = $this->app->db->one('SELECT m.* FROM {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id WHERE um.user_id = ? AND m.id = ?', [$userId, $messageId]);
        if (!$row) {
            throw new HttpError(404, 'Message not found', 'not_found');
        }
        return $row;
    }

    /** A message in full, with the rest of its conversation in the same mailbox. Marks it read. */
    public function get(int $userId, int $messageId, bool $markRead = true): array
    {
        $row = $this->row($userId, $messageId);
        if ($markRead && !$row['is_read']) {
            $this->app->db->run('UPDATE {messages} SET is_read = 1 WHERE id = ?', [$messageId]);
            $row['is_read'] = 1;
        }
        $thread = $row['thread_key']
            ? $this->app->db->all("SELECT * FROM {messages} WHERE mailbox_id = ? AND thread_key = ? AND folder <> 'drafts' ORDER BY sent_at, id", [$row['mailbox_id'], $row['thread_key']])
            : [$row];
        if ($markRead) {
            $this->app->db->run('UPDATE {messages} SET is_read = 1 WHERE mailbox_id = ? AND thread_key = ?', [$row['mailbox_id'], $row['thread_key']]);
        }
        return ['message' => $this->full($row), 'thread' => array_map(fn ($r) => (int) $r['id'] === $messageId ? $this->full($row) : $this->full($r), $thread)];
    }

    private function full(array $r): array
    {
        $c = $this->c();
        $out = $this->summary($r);
        $to = $c->decryptJson($r['to_enc'], 'messages.to') ?? [];
        $body = $c->decryptJson($r['body_enc'], 'messages.body') ?? [];
        $meta = $c->decryptJson($r['meta_enc'], 'messages.meta') ?? [];
        $attachments = [];
        $inline = [];
        foreach ($this->app->db->all('SELECT id, filename_enc, content_type, size, content_id_enc, inline, content_enc IS NOT NULL AS has_content, url_enc FROM {attachments} WHERE message_id = ?', [$r['id']]) as $a) {
            $item = ['id' => (int) $a['id'], 'filename' => $c->decrypt($a['filename_enc'], 'attachments.filename'), 'content_type' => $a['content_type'],
                'size' => (int) $a['size'], 'url' => $c->decrypt($a['url_enc'], 'attachments.url')];
            $cid = $c->decrypt($a['content_id_enc'], 'attachments.content_id');
            if ($a['inline'] && $cid && $a['has_content'] && $a['size'] <= self::INLINE_LIMIT && str_starts_with($a['content_type'], 'image/')) {
                $inline[$cid] = $a['id'];
            } else {
                $attachments[] = $item;
            }
        }
        $html = $body['html'] ?? null;
        if ($html && $inline) {
            // Inline images (cid:) become data: URLs, so the message shows them without loading anything remote.
            $html = preg_replace_callback('/cid:([^"\'\s>)]+)/i', function ($m) use ($inline, $c) {
                $id = $inline[$m[1]] ?? $inline[rawurldecode($m[1])] ?? null;
                if (!$id) {
                    return $m[0];
                }
                $a = $this->app->db->one('SELECT content_type, content_enc FROM {attachments} WHERE id = ?', [$id]);
                return 'data:' . $a['content_type'] . ';base64,' . base64_encode((string) $c->decrypt($a['content_enc'], 'attachments.content'));
            }, $html);
        }
        return $out + [
            'cc' => $to['cc'] ?? [], 'bcc' => $to['bcc'] ?? [], 'reply_to' => $to['reply_to'] ?? [],
            'text' => $body['text'] ?? '', 'html' => $html, 'reply_text' => $body['reply_text'] ?? null,
            'message_id' => $meta['message_id'] ?? null, 'references' => $meta['references'] ?? [], 'in_reply_to' => $meta['in_reply_to'] ?? null,
            'authentication' => $meta['authentication'] ?? null, 'spam' => $meta['spam'] ?? null, 'auto_submitted' => $meta['auto_submitted'] ?? null,
            'attachments' => $attachments,
        ];
    }

    /** An attachment's bytes, for download. */
    public function attachment(int $userId, int $attachmentId): array
    {
        $a = $this->app->db->one(
            'SELECT a.* FROM {attachments} a JOIN {messages} m ON m.id = a.message_id JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id WHERE um.user_id = ? AND a.id = ?',
            [$userId, $attachmentId],
        );
        if (!$a || $a['content_enc'] === null) {
            throw new HttpError(404, 'Attachment not found', 'not_found');
        }
        $c = $this->c();
        return ['filename' => $c->decrypt($a['filename_enc'], 'attachments.filename'), 'content_type' => $a['content_type'],
            'content' => $c->decrypt($a['content_enc'], 'attachments.content')];
    }

    /** Mark read/unread, star, or move to a folder. */
    public function update(int $userId, array $ids, array $changes): int
    {
        $ids = array_values(array_unique(array_map('intval', $ids)));
        if (!$ids || count($ids) > 500) {
            throw new HttpError(422, 'Choose between 1 and 500 messages', 'bad_ids');
        }
        $set = [];
        $params = [];
        if (array_key_exists('read', $changes)) {
            $set[] = 'is_read = ?';
            $params[] = $changes['read'] ? 1 : 0;
        }
        if (array_key_exists('starred', $changes)) {
            $set[] = 'is_starred = ?';
            $params[] = $changes['starred'] ? 1 : 0;
        }
        if (array_key_exists('folder', $changes)) {
            if (!in_array($changes['folder'], self::FOLDERS, true) || in_array($changes['folder'], ['drafts', 'sent'], true)) {
                throw new HttpError(422, "Messages can't be moved there", 'bad_folder');
            }
            $set[] = 'folder = ?';
            $params[] = $changes['folder'];
        }
        if (!$set) {
            return 0;
        }
        $in = implode(', ', array_fill(0, count($ids), '?'));
        return $this->app->db->run(
            'UPDATE {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id SET ' . implode(', ', array_map(fn ($s) => "m.$s", $set))
            . " WHERE um.user_id = ? AND m.id IN ($in)",
            array_merge($params, [$userId], $ids),
        )->rowCount();
    }

    /** Delete for good (messages already in Trash, or drafts). */
    public function delete(int $userId, array $ids): int
    {
        $ids = array_values(array_unique(array_map('intval', $ids)));
        if (!$ids) {
            return 0;
        }
        $in = implode(', ', array_fill(0, count($ids), '?'));
        return $this->app->db->run(
            "DELETE m FROM {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id WHERE um.user_id = ? AND m.id IN ($in) AND m.folder IN ('trash', 'drafts', 'spam')",
            array_merge([$userId], $ids),
        )->rowCount();
    }

    // ------------------------------------------------------------------------------------------------- sending

    /**
     * Send an email from one of the user's mailboxes through GhostParse, then keep a copy in Sent (and delete the
     * draft it came from). $in: to, cc, bcc (arrays of addresses), subject, html, text, reply_to_id (a message
     * being replied to), forward_of (a message whose attachments go too), attachments [{filename, content_type,
     * content (base64)}], draft_id.
     */
    public function send(array $user, int $mailboxId, array $in): array
    {
        $mailbox = $this->requireMailbox($user['id'], $mailboxId);
        $to = self::addresses($in['to'] ?? []);
        $cc = self::addresses($in['cc'] ?? []);
        $bcc = self::addresses($in['bcc'] ?? []);
        if (!$to && !$cc && !$bcc) {
            throw new HttpError(422, 'Add at least one recipient', 'no_recipients');
        }
        $subject = trim((string) ($in['subject'] ?? '')) ?: '(no subject)';
        $html = isset($in['html']) && trim((string) $in['html']) !== '' ? (string) $in['html'] : null;
        $text = (string) ($in['text'] ?? '');
        if ($text === '' && $html) {
            $text = trim(html_entity_decode(strip_tags(preg_replace('/<(br|\/p|\/div|\/li)\b[^>]*>/i', "\n", $html)), ENT_QUOTES | ENT_HTML5));
        }
        // The signature is the GhostParse address's, added by GhostParse (unless this message leaves it out). A signature
        // from before 1.5.0 moves there first; if GhostParse can't take it now, it's added here as it used to be.
        $withSignature = !array_key_exists('signature', $in) || (bool) $in['signature'];
        $legacy = '';
        try {
            if (!(new Signatures($this->app))->migrate($mailbox)) {
                $legacy = $mailbox['signature'];
            }
        } catch (HttpError) {
            $legacy = $mailbox['signature'];
        }
        if ($legacy !== '' && $withSignature) {
            $text = rtrim($text) . "\n\n-- \n" . $legacy;
            if ($html) {
                $html .= '<div class="signature">-- <br>' . nl2br(htmlspecialchars($legacy, ENT_QUOTES | ENT_HTML5, 'UTF-8')) . '</div>';
            }
        }
        $payload = [
            'from' => ['address' => $mailbox['address'], 'name' => $mailbox['display_name'] !== '' ? $mailbox['display_name'] : $user['name']],
            'to' => $to, 'subject' => mb_substr($subject, 0, 998), 'text' => $text === '' ? ' ' : $text,
            'signature' => $withSignature && $legacy === '',
        ];
        if ($cc) {
            $payload['cc'] = $cc;
        }
        if ($bcc) {
            $payload['bcc'] = $bcc;
        }
        if ($html) {
            $payload['html'] = $html;
        }
        $threadKey = null;
        if (!empty($in['reply_to_id'])) {
            $orig = $this->full($this->row($user['id'], (int) $in['reply_to_id']));
            if ($orig['message_id']) {
                $payload['in_reply_to'] = $orig['message_id'];
                $payload['references'] = array_values(array_unique(array_merge($orig['references'] ?? [], [$orig['message_id']])));
            }
            $threadKey = $this->row($user['id'], (int) $in['reply_to_id'])['thread_key'];
        }
        $attachments = [];
        foreach ($in['attachments'] ?? [] as $a) {
            if (!isset($a['filename'], $a['content']) || base64_decode((string) $a['content'], true) === false) {
                throw new HttpError(422, 'An attachment is incomplete', 'bad_attachment');
            }
            $attachments[] = ['filename' => (string) $a['filename'], 'content' => (string) $a['content'], 'content_type' => (string) ($a['content_type'] ?? 'application/octet-stream')];
        }
        if (!empty($in['forward_of'])) {
            $orig = $this->full($this->row($user['id'], (int) $in['forward_of']));
            foreach ($orig['attachments'] as $a) {
                $file = $this->attachment($user['id'], $a['id']);
                $attachments[] = ['filename' => $file['filename'], 'content' => base64_encode($file['content']), 'content_type' => $file['content_type']];
            }
        }
        if ($attachments) {
            $payload['attachments'] = $attachments;
        }
        try {
            $result = $this->app->gp->send($payload);
        } catch (GhostParseError $e) {
            throw new HttpError($e->status >= 400 && $e->status < 500 ? 422 : 502, "Not sent: {$e->getMessage()}", 'send_failed');
        }
        $data = [
            'id' => $result['id'] ?? null, 'message_id' => $result['message_id'] ?? null, 'thread_id' => $threadKey ?? ($result['thread_id'] ?? null),
            'from' => $result['from'] ?? $payload['from'], 'to' => array_map(fn ($a) => ['address' => $a, 'name' => null], $to),
            'cc' => array_map(fn ($a) => ['address' => $a, 'name' => null], $cc), 'bcc' => array_map(fn ($a) => ['address' => $a, 'name' => null], $bcc),
            'subject' => $payload['subject'], 'text' => $text, 'html' => $html, 'date' => gmdate('c'),
            'in_reply_to' => $payload['in_reply_to'] ?? null, 'references' => $payload['references'] ?? [],
            'attachments' => array_map(fn ($a) => ['filename' => $a['filename'], 'content_type' => $a['content_type'], 'size' => strlen(base64_decode($a['content'])), 'content' => $a['content']], $attachments),
        ];
        $id = $this->storeOne($mailboxId, $data, 'sent', true);
        if (!empty($in['draft_id'])) {
            $this->delete($user['id'], [(int) $in['draft_id']]);
        }
        $this->remember($user['id'], array_merge($to, $cc, $bcc));
        return ['id' => $id, 'message_id' => $result['message_id'] ?? null, 'suppressed' => $result['suppressed'] ?? []];
    }

    /** Save (or update) a draft. */
    public function saveDraft(array $user, int $mailboxId, array $in): int
    {
        $mailbox = $this->requireMailbox($user['id'], $mailboxId);
        $data = [
            'from' => ['address' => $mailbox['address'], 'name' => $mailbox['display_name']],
            'to' => array_map(fn ($a) => ['address' => $a, 'name' => null], self::addresses($in['to'] ?? [], false)),
            'cc' => array_map(fn ($a) => ['address' => $a, 'name' => null], self::addresses($in['cc'] ?? [], false)),
            'bcc' => array_map(fn ($a) => ['address' => $a, 'name' => null], self::addresses($in['bcc'] ?? [], false)),
            'subject' => (string) ($in['subject'] ?? ''), 'html' => $in['html'] ?? null, 'text' => (string) ($in['text'] ?? ''), 'date' => gmdate('c'),
        ];
        if (!empty($in['draft_id'])) {
            $this->delete($user['id'], [(int) $in['draft_id']]);
        }
        return (int) $this->storeOne($mailboxId, $data, 'drafts', true);
    }

    /** Recipients you've written to, for suggestions when composing. */
    private function remember(int $userId, array $addresses): void
    {
        foreach ($addresses as $a) {
            $this->app->db->run(
                'INSERT INTO {contacts} (user_id, address_bidx, address_enc, last_used_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE used = used + 1, last_used_at = VALUES(last_used_at)',
                [$userId, $this->c()->blindIndex(mb_strtolower($a), 'contacts.address'), $this->c()->encrypt(mb_strtolower($a), 'contacts.address'), App::now()],
            );
        }
    }

    public function contacts(int $userId): array
    {
        $rows = $this->app->db->all('SELECT address_enc FROM {contacts} WHERE user_id = ? ORDER BY used DESC, last_used_at DESC LIMIT 500', [$userId]);
        return array_map(fn ($r) => $this->c()->decrypt($r['address_enc'], 'contacts.address'), $rows);
    }

    /** Addresses from an array or a comma-separated string, checked. */
    public static function addresses(array|string $list, bool $strict = true): array
    {
        $items = is_array($list) ? $list : preg_split('/[,;]\s*/', $list);
        $out = [];
        foreach ($items as $item) {
            $item = trim((string) (is_array($item) ? ($item['address'] ?? '') : $item));
            if ($item === '') {
                continue;
            }
            if (preg_match('/<([^>]+)>/', $item, $m)) {
                $item = trim($m[1]);
            }
            if (!filter_var($item, FILTER_VALIDATE_EMAIL)) {
                if ($strict) {
                    throw new HttpError(422, "$item isn't a valid email address", 'invalid_address');
                }
                continue;
            }
            $out[] = $item;
        }
        if (count($out) > 100) {
            throw new HttpError(422, 'At most 100 recipients', 'too_many_recipients');
        }
        return array_values(array_unique($out));
    }
}
