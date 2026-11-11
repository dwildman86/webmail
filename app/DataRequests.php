<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Data requests (GDPR subject access requests): find everything the webmail holds about one person, and export it.
 *
 * Another system (the customer's CRM, help desk or website: a "GDPR request" button) calls the API with a key an
 * administrator made here, or an administrator starts one under Settings → Data requests. A request names the person's
 * email address and, optionally, more terms to look for in the text (their name, a phone number, a customer number).
 *
 * The search covers every mailbox (or the ones named) and every folder, Trash, Spam and Drafts included:
 *   1. The search index finds the likely email at once (it holds each message's people, subject, attachment names and
 *      the start of its text, as blind indexes).
 *   2. Then every message in scope is decrypted and checked, so nothing past the index's reach is missed: the end of a
 *      long email, a quoted reply. On shared hosting that can take a while for a big mailbox, so it's done in
 *      steps: each call to the request's status carries on for up to SCAN_SECONDS and says how far it's got.
 * A message matches when the address is a sender or recipient, or the address or one of the terms is in its subject,
 * text or attachment names. The contents of attachments (PDFs, images) aren't searched; they're exported with the email.
 *
 * The export is a ZIP: a README, request.json, messages.csv (one row per email, with why it matched), each email as
 * text and HTML with its attachments, the person's address book entries, and the team notes on those conversations.
 * Its emails may hold other people's personal data too: it's for review before it's sent (GDPR article 15(4)).
 *
 * The results are kept for RETAIN_DAYS, then removed. The request itself stays, as a record that it was answered:
 * who asked, when, how many emails, when it was downloaded.
 */
final class DataRequests
{
    public const SCAN_SECONDS = 20;
    public const RETAIN_DAYS = 30;
    public const MAX_TERMS = 10;
    public const MAX_SEARCHING = 5;
    private const BATCH = 200;

    /** Seconds each status call may spend scanning (tests set it lower). */
    public float $scanSeconds = self::SCAN_SECONDS;
    /** Messages decrypted per query (tests set it lower). */
    public int $batch = self::BATCH;

    public function __construct(private App $app)
    {
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    // ---------------------------------------------------------------------------------------------- API keys

    /** A new key for another system. The key itself is shown once: only an HMAC of it is kept. */
    public function createKey(int $userId, string $name, array $allowedIps = []): array
    {
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 100) {
            throw new HttpError(422, 'Give the key a name (up to 100 characters), such as the system that will use it', 'invalid_key');
        }
        $ips = [];
        foreach ($allowedIps as $ip) {
            $ip = trim((string) $ip);
            if ($ip === '') {
                continue;
            }
            if (!filter_var($ip, FILTER_VALIDATE_IP)) {
                throw new HttpError(422, "\"$ip\" isn't an IP address", 'invalid_key');
            }
            $ips[] = $ip;
        }
        $token = 'wmk_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $id = $this->app->db->insert(
            'INSERT INTO {api_keys} (name_enc, token_bidx, hint, allowed_ips_enc, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$this->c()->encrypt($name, 'api_keys.name'), $this->tokenIndex($token), substr($token, 0, 8) . '…' . substr($token, -4),
                $ips ? $this->c()->encryptJson($ips, 'api_keys.allowed_ips') : null, 'data_requests', $userId, App::now()],
        );
        return ['id' => $id, 'key' => $token] + $this->presentKey($this->app->db->one('SELECT * FROM {api_keys} WHERE id = ?', [$id]));
    }

    public function keys(): array
    {
        return array_map(fn ($r) => $this->presentKey($r), $this->app->db->all('SELECT * FROM {api_keys} WHERE revoked_at IS NULL ORDER BY id'));
    }

    public function revokeKey(int $id): void
    {
        $this->app->db->run('UPDATE {api_keys} SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [App::now(), $id]);
    }

    private function presentKey(array $r): array
    {
        return ['id' => (int) $r['id'], 'name' => $this->c()->decrypt($r['name_enc'], 'api_keys.name'), 'hint' => $r['hint'],
            'allowed_ips' => $this->c()->decryptJson($r['allowed_ips_enc'], 'api_keys.allowed_ips') ?? [],
            'created_at' => self::iso($r['created_at']), 'last_used_at' => self::iso($r['last_used_at'])];
    }

    private function tokenIndex(string $token): string
    {
        return $this->c()->blindIndex($token, 'api_keys.token');
    }

    /** The key a request came with (Authorization: Bearer, or X-Api-Key where the host drops Authorization). */
    public function authenticate(?string $token, string $ip): array
    {
        $token = trim((string) $token);
        $row = $token !== '' && str_starts_with($token, 'wmk_')
            ? $this->app->db->one('SELECT * FROM {api_keys} WHERE token_bidx = ? AND revoked_at IS NULL', [$this->tokenIndex($token)])
            : null;
        if (!$row) {
            throw new HttpError(401, 'A valid API key is needed (Authorization: Bearer wmk_…). Administrators make one under Settings → Data requests.', 'unauthorized');
        }
        $ips = $this->c()->decryptJson($row['allowed_ips_enc'], 'api_keys.allowed_ips') ?? [];
        if ($ips && !in_array($ip, $ips, true)) {
            throw new HttpError(403, "This key can't be used from $ip", 'ip_not_allowed');
        }
        $this->app->db->run('UPDATE {api_keys} SET last_used_at = ? WHERE id = ?', [App::now(), $row['id']]);
        return ['id' => (int) $row['id'], 'name' => $this->c()->decrypt($row['name_enc'], 'api_keys.name')];
    }

    public static function bearer(): ?string
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (preg_match('/^Bearer\s+(\S+)$/i', (string) $h, $m)) {
            return $m[1];
        }
        return $_SERVER['HTTP_X_API_KEY'] ?? null;
    }

    // ---------------------------------------------------------------------------------------------- requests

    /**
     * Start a request. $in: email (required), terms (more words or phrases to find), mailboxes (addresses; all when
     * none), since / until (dates), reference (yours, e.g. the ticket number), include_attachments (default true).
     * $by: ['key' => id] or ['user' => id].
     */
    public function create(array $in, array $by): array
    {
        $email = mb_strtolower(trim((string) ($in['email'] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new HttpError(422, 'email must be the email address of the person whose data is asked for', 'invalid_request');
        }
        $terms = [];
        foreach ((array) ($in['terms'] ?? []) as $t) {
            $t = trim(preg_replace('/\s+/u', ' ', (string) $t) ?? '');
            if ($t !== '' && !in_array(mb_strtolower($t), array_map('mb_strtolower', $terms), true)) {
                if (mb_strlen($t) < 3 || !Crypto::words($t)) {
                    throw new HttpError(422, "\"$t\" is too short to search for: use at least 3 letters or digits", 'invalid_request');
                }
                $terms[] = mb_substr($t, 0, 200);
            }
        }
        if (count($terms) > self::MAX_TERMS) {
            throw new HttpError(422, 'Up to ' . self::MAX_TERMS . ' terms', 'invalid_request');
        }
        $store = new Mailstore($this->app);
        $mailboxIds = null;
        if (!empty($in['mailboxes'])) {
            $mailboxIds = [];
            foreach ((array) $in['mailboxes'] as $address) {
                $id = $this->app->db->value('SELECT id FROM {mailboxes} WHERE address_bidx = ?', [$store->addressIndex((string) $address)]);
                if (!$id) {
                    throw new HttpError(422, "There's no mailbox $address here", 'invalid_request');
                }
                $mailboxIds[] = (int) $id;
            }
        }
        $since = self::date($in['since'] ?? null, 'since');
        $until = self::date($in['until'] ?? null, 'until');
        $reference = mb_substr(trim((string) ($in['reference'] ?? '')), 0, 200);
        if (isset($by['key']) && (int) $this->app->db->value("SELECT COUNT(*) FROM {data_requests} WHERE key_id = ? AND status = 'searching'", [$by['key']]) >= self::MAX_SEARCHING) {
            throw new HttpError(429, 'This key already has ' . self::MAX_SEARCHING . ' requests searching. Check on those first.', 'too_many');
        }
        $publicId = 'dr_' . bin2hex(random_bytes(10));
        [$where, $params] = $this->scope($mailboxIds, $since, $until);
        $total = (int) $this->app->db->value("SELECT COUNT(*) FROM {messages} m WHERE $where", $params);
        $id = $this->app->db->insert(
            "INSERT INTO {data_requests} (public_id, key_id, user_id, subject_bidx, subject_enc, terms_enc, reference_enc, mailbox_ids, since, until,
                include_attachments, status, cursor_id, scanned, total, matches_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'searching', 0, 0, ?, ?, ?, ?)",
            [$publicId, $by['key'] ?? null, $by['user'] ?? null, $this->c()->blindIndex($email, 'data_requests.subject'), $this->c()->encrypt($email, 'data_requests.subject'),
                $this->c()->encryptJson($terms, 'data_requests.terms'), $reference !== '' ? $this->c()->encrypt($reference, 'data_requests.reference') : null,
                $mailboxIds === null ? null : json_encode($mailboxIds), $since, $until, ($in['include_attachments'] ?? true) === false ? 0 : 1,
                $total, $this->c()->encryptJson($this->indexed($email, $terms, $where, $params), 'data_requests.matches'), App::now(),
                gmdate('Y-m-d H:i:s', time() + self::RETAIN_DAYS * 86400)],
        );
        $this->continue($id);
        return $this->present($this->load($id));
    }

    /** A request by its id (dr_…), carrying on with the search if it isn't finished. */
    public function get(string $publicId, ?int $keyId = null): array
    {
        $r = $this->find($publicId, $keyId);
        if ($r['status'] === 'searching') {
            $this->continue((int) $r['id']);
            $r = $this->load((int) $r['id']);
        }
        return $this->present($r, true);
    }

    /** Recent requests (all of them for an administrator; a key's own for a key). */
    public function list(?int $keyId = null, int $limit = 50): array
    {
        $this->expire();
        $rows = $keyId === null
            ? $this->app->db->all('SELECT * FROM {data_requests} ORDER BY id DESC LIMIT ' . max(1, min(200, $limit)))
            : $this->app->db->all('SELECT * FROM {data_requests} WHERE key_id = ? ORDER BY id DESC LIMIT ' . max(1, min(200, $limit)), [$keyId]);
        return array_map(fn ($r) => $this->present($r), $rows);
    }

    /** Remove a request's results now (it's been answered). The record of it stays. */
    public function discard(string $publicId, ?int $keyId = null): array
    {
        $r = $this->find($publicId, $keyId);
        $this->app->db->run("UPDATE {data_requests} SET status = 'expired', matches_enc = NULL, expires_at = ? WHERE id = ?", [App::now(), $r['id']]);
        return $this->present($this->load((int) $r['id']));
    }

    private function find(string $publicId, ?int $keyId): array
    {
        $this->expire();
        $r = $this->app->db->one('SELECT * FROM {data_requests} WHERE public_id = ?', [$publicId]);
        if (!$r || ($keyId !== null && (int) $r['key_id'] !== $keyId)) {
            throw new HttpError(404, 'No such data request', 'not_found');
        }
        return $r;
    }

    private function load(int $id): array
    {
        return $this->app->db->one('SELECT * FROM {data_requests} WHERE id = ?', [$id]);
    }

    /** Results past their time are removed; the record stays. */
    private function expire(): void
    {
        $this->app->db->run("UPDATE {data_requests} SET status = 'expired', matches_enc = NULL WHERE status <> 'expired' AND expires_at < ?", [App::now()]);
    }

    private function present(array $r, bool $withMessages = false): array
    {
        $c = $this->c();
        $matches = $r['matches_enc'] !== null ? ($c->decryptJson($r['matches_enc'], 'data_requests.matches') ?? []) : [];
        $out = [
            'id' => $r['public_id'],
            'status' => $r['status'],
            'email' => $c->decrypt($r['subject_enc'], 'data_requests.subject'),
            'terms' => $c->decryptJson($r['terms_enc'], 'data_requests.terms') ?? [],
            'reference' => $c->decrypt($r['reference_enc'], 'data_requests.reference'),
            'mailboxes' => $r['mailbox_ids'] === null ? 'all' : $this->addresses(json_decode($r['mailbox_ids'], true) ?: []),
            'since' => self::iso($r['since']), 'until' => self::iso($r['until']),
            'include_attachments' => (bool) $r['include_attachments'],
            'progress' => ['scanned' => (int) $r['scanned'], 'total' => (int) $r['total']],
            'matches' => $r['status'] === 'expired' ? null : count($matches),
            'requested_by' => $r['key_id'] !== null ? ['key' => $this->keyName((int) $r['key_id'])] : ['user' => $this->userEmail((int) $r['user_id'])],
            'created_at' => self::iso($r['created_at']), 'completed_at' => self::iso($r['completed_at']), 'expires_at' => self::iso($r['expires_at']),
            'downloads' => (int) $r['downloads'], 'last_downloaded_at' => self::iso($r['last_download_at']),
        ];
        if ($withMessages && $r['status'] === 'ready') {
            $out['messages'] = $this->summaries($matches);
        }
        return $out;
    }

    // ---------------------------------------------------------------------------------------------- searching

    /** The messages a request covers: SQL for {messages} m. */
    private function scope(?array $mailboxIds, ?string $since, ?string $until): array
    {
        $where = ['1 = 1'];
        $params = [];
        if ($mailboxIds !== null) {
            $where[] = 'm.mailbox_id IN (' . implode(', ', array_fill(0, max(1, count($mailboxIds)), '?')) . ')';
            $params = array_merge($params, $mailboxIds ?: [0]);
        }
        if ($since) {
            $where[] = 'm.sent_at >= ?';
            $params[] = $since;
        }
        if ($until) {
            $where[] = 'm.sent_at <= ?';
            $params[] = $until;
        }
        return [implode(' AND ', $where), $params];
    }

    private function scopeOf(array $r): array
    {
        return $this->scope($r['mailbox_ids'] === null ? null : (json_decode($r['mailbox_ids'], true) ?: []), $r['since'], $r['until']);
    }

    /** Step 1: what the search index finds straight away (checked again by the scan; it's never the final word). */
    private function indexed(string $email, array $terms, string $where, array $params): array
    {
        $found = [];
        foreach (array_merge([$email], $terms) as $phrase) {
            $tokens = array_slice(Crypto::words($phrase, 10), 0, 10);
            if (!$tokens) {
                continue;
            }
            $in = implode(', ', array_fill(0, count($tokens), '?'));
            $ids = $this->app->db->all(
                "SELECT m.id FROM {messages} m JOIN (SELECT message_id FROM {search} WHERE token IN ($in) GROUP BY message_id HAVING COUNT(DISTINCT token) = ?) s ON s.message_id = m.id
                 WHERE $where LIMIT 20000",
                array_merge(array_map(fn ($t) => $this->c()->blindIndex($t, 'search'), $tokens), [count($tokens)], $params),
            );
            foreach ($ids as $row) {
                $found[(int) $row['id']] = true;
            }
        }
        // Candidates only: the scan decides. Kept as "?" until it has.
        return array_map(fn () => ['?'], $found);
    }

    /** Step 2: decrypt and check each message, for up to $scanSeconds. */
    private function continue(int $id): void
    {
        $db = $this->app->db;
        $lock = 'wm_data_request_' . $id;
        if (!(int) $db->value('SELECT GET_LOCK(?, 0)', [$lock])) {
            return; // another call is scanning this one
        }
        try {
            $r = $this->load($id);
            if ($r['status'] !== 'searching') {
                return;
            }
            $c = $this->c();
            $email = (string) $c->decrypt($r['subject_enc'], 'data_requests.subject');
            $terms = $c->decryptJson($r['terms_enc'], 'data_requests.terms') ?? [];
            $matches = $c->decryptJson($r['matches_enc'], 'data_requests.matches') ?? [];
            [$where, $params] = $this->scopeOf($r);
            $cursor = (int) $r['cursor_id'];
            $scanned = (int) $r['scanned'];
            $deadline = microtime(true) + $this->scanSeconds;
            $done = false;
            do {
                $rows = $db->all("SELECT m.id, m.from_enc, m.to_enc, m.subject_enc, m.body_enc FROM {messages} m WHERE $where AND m.id > ? ORDER BY m.id LIMIT " . $this->batch,
                    array_merge($params, [$cursor]));
                if (!$rows) {
                    $done = true;
                    break;
                }
                $names = $this->attachmentNames(array_map(fn ($x) => (int) $x['id'], $rows));
                foreach ($rows as $row) {
                    $mid = (int) $row['id'];
                    $why = $this->matches($row, $names[$mid] ?? [], $email, $terms);
                    if ($why) {
                        $matches[$mid] = $why;
                    } else {
                        unset($matches[$mid]);
                    }
                    $cursor = $mid;
                    $scanned++;
                }
            } while (microtime(true) < $deadline);
            // Index candidates the scan never reached (deleted since, or out of scope) aren't matches.
            if ($done) {
                $matches = array_filter($matches, fn ($why) => $why !== ['?']);
            }
            $db->run('UPDATE {data_requests} SET cursor_id = ?, scanned = ?, total = GREATEST(total, ?), matches_enc = ?, status = ?, completed_at = ? WHERE id = ?', [
                $cursor, $scanned, $scanned, $c->encryptJson($matches, 'data_requests.matches'), $done ? 'ready' : 'searching', $done ? App::now() : null, $id,
            ]);
        } finally {
            $db->value('SELECT RELEASE_LOCK(?)', [$lock]);
        }
    }

    /** @return array<int, string[]> each message's attachment file names */
    private function attachmentNames(array $ids): array
    {
        $out = [];
        if (!$ids) {
            return $out;
        }
        $rows = $this->app->db->all('SELECT message_id, filename_enc FROM {attachments} WHERE message_id IN (' . implode(', ', array_fill(0, count($ids), '?')) . ')', $ids);
        foreach ($rows as $a) {
            $out[(int) $a['message_id']][] = (string) $this->c()->decrypt($a['filename_enc'], 'attachments.filename');
        }
        return $out;
    }

    /**
     * Why one message is about the person: where the address is ("from", "to", "cc", "bcc", "reply_to", "subject",
     * "text", "attachment_name") and which terms are in it ("term:…"). [] when it isn't.
     */
    public function matches(array $row, array $attachmentNames, string $email, array $terms): array
    {
        $c = $this->c();
        $from = $c->decryptJson($row['from_enc'], 'messages.from');
        $to = $c->decryptJson($row['to_enc'], 'messages.to') ?? [];
        $subject = (string) $c->decrypt($row['subject_enc'], 'messages.subject');
        $body = $c->decryptJson($row['body_enc'], 'messages.body') ?? [];
        $why = [];
        $people = ['from' => $from ? [$from] : []] + array_map(fn ($l) => (array) $l, array_intersect_key($to, array_flip(['to', 'cc', 'bcc', 'reply_to'])));
        $names = [];
        foreach ($people as $field => $list) {
            foreach ($list as $p) {
                if (mb_strtolower(trim((string) ($p['address'] ?? ''))) === $email) {
                    $why[$field] = true;
                }
                $names[] = (string) ($p['name'] ?? '');
            }
        }
        $text = (string) ($body['text'] ?? '');
        $html = (string) ($body['html'] ?? '');
        $htmlText = $html !== '' ? html_entity_decode(strip_tags(preg_replace('/<(br|\/p|\/div|\/li|\/td|\/tr)\b[^>]*>/i', "\n", $html) ?? ''), ENT_QUOTES | ENT_HTML5) : '';
        $where = ['subject' => $subject, 'text' => $text . "\n" . $htmlText, 'attachment_name' => implode("\n", $attachmentNames)];
        foreach ($where as $field => $haystack) {
            if ($haystack !== '' && mb_stripos($haystack, $email) !== false) {
                $why[$field] = true;
            }
        }
        $all = self::normal(implode("\n", array_merge($where, $names)));
        foreach ($terms as $t) {
            if (mb_strpos($all, self::normal($t)) !== false) {
                $why['term:' . $t] = true;
            }
        }
        return array_keys($why);
    }

    /** Lower case, one space between words: "Jane  SMITH" finds "jane smith", "07700 900123" finds "07700  900123". */
    private static function normal(string $s): string
    {
        return trim(preg_replace('/\s+/u', ' ', mb_strtolower($s)) ?? '');
    }

    /** One line per matching message, newest first. */
    private function summaries(array $matches): array
    {
        if (!$matches) {
            return [];
        }
        $c = $this->c();
        $out = [];
        foreach (array_chunk(array_keys($matches), 500) as $ids) {
            $rows = $this->app->db->all('SELECT m.id, m.mailbox_id, m.folder, m.from_enc, m.to_enc, m.subject_enc, m.sent_at, m.has_attachments, mb.address_enc
                FROM {messages} m JOIN {mailboxes} mb ON mb.id = m.mailbox_id WHERE m.id IN (' . implode(', ', array_fill(0, count($ids), '?')) . ')', $ids);
            foreach ($rows as $r) {
                $to = $c->decryptJson($r['to_enc'], 'messages.to') ?? [];
                $out[] = ['id' => (int) $r['id'], 'mailbox' => $c->decrypt($r['address_enc'], 'mailboxes.address'), 'folder' => $r['folder'],
                    'date' => self::iso($r['sent_at']), 'from' => $c->decryptJson($r['from_enc'], 'messages.from'), 'to' => $to['to'] ?? [],
                    'subject' => $c->decrypt($r['subject_enc'], 'messages.subject'), 'has_attachments' => (bool) $r['has_attachments'],
                    'matched_on' => $matches[(int) $r['id']]];
            }
        }
        usort($out, fn ($a, $b) => [$b['date'], $b['id']] <=> [$a['date'], $a['id']]);
        return $out;
    }

    // ---------------------------------------------------------------------------------------------- export

    /**
     * The export, as a ZIP written to $out. Only for a finished request whose results are still kept.
     * @param resource $out
     */
    public function export(string $publicId, $out, ?int $keyId = null, string $by = ''): array
    {
        $r = $this->find($publicId, $keyId);
        if ($r['status'] === 'searching') {
            throw new HttpError(409, 'Still searching. Check the request until its status is "ready", then download it.', 'not_ready');
        }
        if ($r['status'] === 'expired') {
            throw new HttpError(410, 'The results of this request have been removed. Start a new request to export again.', 'expired');
        }
        $c = $this->c();
        $request = $this->present($r);
        $matches = $c->decryptJson($r['matches_enc'], 'data_requests.matches') ?? [];
        $zip = new Zip($out);
        $store = new Mailstore($this->app);
        $csv = fopen('php://temp', 'w+');
        fputcsv($csv, ['#', 'date', 'mailbox', 'folder', 'from', 'to', 'cc', 'subject', 'matched_on', 'attachments', 'path'], ',', '"', '');
        $threads = [];
        $n = 0;
        foreach ($this->summaries($matches) as $s) {
            $row = $this->app->db->one('SELECT * FROM {messages} WHERE id = ?', [$s['id']]);
            if (!$row) {
                continue; // deleted since the search
            }
            $n++;
            $m = $store->full($row);
            $dir = sprintf('messages/%04d %s %s', $n, substr((string) $s['date'], 0, 10), mb_substr(preg_replace('/[^\p{L}\p{N} ._-]+/u', '', (string) ($m['subject'] ?? '')) ?: 'no subject', 0, 60));
            $time = strtotime((string) $s['date']) ?: null;
            $zip->add("$dir/message.txt", $this->asText($m, (string) $s['mailbox'], $s['matched_on']), $time);
            if (!empty($m['html'])) {
                $zip->add("$dir/message.html", "<!doctype html><meta charset=\"utf-8\">\n" . $m['html'], $time);
            }
            $files = [];
            foreach ($this->app->db->all('SELECT * FROM {attachments} WHERE message_id = ?', [$s['id']]) as $a) {
                $name = (string) $c->decrypt($a['filename_enc'], 'attachments.filename');
                $url = $c->decrypt($a['url_enc'], 'attachments.url');
                if ($r['include_attachments'] && $a['content_enc'] !== null) {
                    $zip->add("$dir/attachments/$name", (string) $c->decrypt($a['content_enc'], 'attachments.content'), $time);
                    $files[] = $name;
                } elseif ($url) {
                    $files[] = "$name (stored elsewhere: $url)";
                } else {
                    $files[] = "$name (not included)";
                }
            }
            $people = fn (array $list) => implode('; ', array_map(fn ($p) => trim(($p['name'] ?? '') . ' <' . ($p['address'] ?? '') . '>'), $list));
            fputcsv($csv, [$n, $s['date'], $s['mailbox'], $s['folder'], $people($m['from'] ? [$m['from']] : []), $people($m['to'] ?? []), $people($m['cc'] ?? []),
                $m['subject'] ?? '', implode(' ', $s['matched_on']), implode('; ', $files), $dir], ',', '"', '');
            if ($row['thread_key']) {
                $threads[$row['mailbox_id'] . "\0" . $row['thread_key']] = [(int) $row['mailbox_id'], $row['thread_key'], (string) $s['subject'], $dir];
            }
        }
        rewind($csv);
        $zip->add('messages.csv', "\xEF\xBB\xBF" . stream_get_contents($csv));
        fclose($csv);
        $book = $this->addressBook((string) $request['email']);
        $zip->add('contacts.json', json_encode($book, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        $notes = $this->notes(array_values($threads));
        if ($notes) {
            $zip->add('team-notes.json', json_encode($notes, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }
        $events = $this->calendarEvents((string) $request['email'], $request['terms']);
        if ($events) {
            $zip->add('calendar.json', json_encode($events, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }
        $request['matches'] = $n;
        $zip->add('request.json', json_encode($request + ['exported_at' => gmdate('c'), 'exported_by' => $by], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        $zip->add('README.txt', $this->readme($request, $n, count($book['address_book']), count($notes), $by, count($events)));
        $size = $zip->finish();
        $this->app->db->run('UPDATE {data_requests} SET downloads = downloads + 1, last_download_at = ? WHERE id = ?', [App::now(), $r['id']]);
        return ['messages' => $n, 'bytes' => $size, 'filename' => 'data-request-' . $r['public_id'] . '.zip'];
    }

    private function asText(array $m, string $mailbox, array $matchedOn): string
    {
        $p = fn ($x) => trim(($x['name'] ?? '') !== '' ? "{$x['name']} <{$x['address']}>" : (string) ($x['address'] ?? ''));
        $list = fn (array $l) => implode(', ', array_map($p, $l));
        $lines = ['Mailbox:  ' . $mailbox . ' (' . $m['folder'] . ')', 'Date:     ' . $m['date'], 'From:     ' . ($m['from'] ? $p($m['from']) : '')];
        foreach (['To' => 'to', 'Cc' => 'cc', 'Bcc' => 'bcc', 'Reply-To' => 'reply_to'] as $label => $k) {
            if (!empty($m[$k])) {
                $lines[] = str_pad("$label:", 10) . $list($m[$k]);
            }
        }
        $lines[] = 'Subject:  ' . ($m['subject'] ?? '');
        if (!empty($m['message_id'])) {
            $lines[] = 'Message-ID: ' . $m['message_id'];
        }
        $lines[] = 'Matched:  ' . implode(', ', $matchedOn);
        if ($m['attachments']) {
            $lines[] = 'Attachments: ' . implode(', ', array_map(fn ($a) => $a['filename'], $m['attachments']));
        }
        return implode("\n", $lines) . "\n\n" . (string) ($m['text'] ?? '') . "\n";
    }

    /** The person's entries in the address books (everyone's own and the shared one), and who has them as a contact. */
    private function addressBook(string $email): array
    {
        $c = $this->c();
        $entries = [];
        foreach ($this->app->db->all('SELECT b.*, u.email_enc AS owner_email FROM {address_book} b LEFT JOIN {users} u ON u.id = b.owner_id WHERE b.email_bidx = ?',
            [$c->blindIndex($email, 'book.email')]) as $b) {
            $entries[] = ['address_book' => (int) $b['owner_id'] === AddressBook::SHARED ? 'shared' : (string) $c->decrypt($b['owner_email'], 'users.email'),
                'email' => $c->decrypt($b['email_enc'], 'book.email'), 'name' => $c->decrypt($b['name_enc'], 'book.name'), 'phone' => $c->decrypt($b['phone_enc'], 'book.phone'),
                'company' => $c->decrypt($b['company_enc'], 'book.company'), 'notes' => $c->decrypt($b['notes_enc'], 'book.notes'),
                'created_at' => self::iso($b['created_at']), 'updated_at' => self::iso($b['updated_at'])];
        }
        $recent = [];
        foreach ($this->app->db->all('SELECT k.used, k.last_used_at, u.email_enc FROM {contacts} k JOIN {users} u ON u.id = k.user_id WHERE k.address_bidx = ?',
            [$c->blindIndex($email, 'contacts.address')]) as $k) {
            $recent[] = ['user' => $c->decrypt($k['email_enc'], 'users.email'), 'times_emailed' => (int) $k['used'], 'last_emailed_at' => self::iso($k['last_used_at'])];
        }
        return ['address_book' => $entries, 'recently_emailed_by' => $recent];
    }

    /** Calendar events (on anyone's calendar, shared or personal) whose title, place or notes mention the person. */
    private function calendarEvents(string $email, array $terms): array
    {
        $c = $this->c();
        $needles = array_values(array_filter(array_map(fn ($t) => self::normal((string) $t), array_merge([$email], $terms)), fn ($t) => $t !== ''));
        $out = [];
        foreach ($this->app->db->all('SELECT e.*, k.name_enc AS cal_name, k.kind, u.email_enc AS owner_email FROM {cal_events} e JOIN {cal_calendars} k ON k.id = e.calendar_id
            LEFT JOIN {users} u ON u.id = k.owner_id ORDER BY e.start_at LIMIT 100000') as $e) {
            $title = (string) $c->decrypt($e['title_enc'], 'cal.title');
            $location = (string) ($c->decrypt($e['location_enc'], 'cal.location') ?? '');
            $notes = (string) ($c->decrypt($e['notes_enc'], 'cal.notes') ?? '');
            $hay = self::normal("$title\n$location\n$notes");
            $found = array_values(array_filter($needles, fn ($n) => str_contains($hay, $n)));
            if (!$found) {
                continue;
            }
            $out[] = ['calendar' => (string) $c->decrypt($e['cal_name'], 'cal.name'), 'calendar_kind' => $e['kind'],
                'calendar_owner' => $e['kind'] === 'personal' ? $c->decrypt($e['owner_email'], 'users.email') : null,
                'title' => $title, 'location' => $location ?: null, 'notes' => $notes ?: null, 'all_day' => (bool) $e['all_day'],
                'start' => $e['all_day'] ? substr($e['start_at'], 0, 10) : self::iso($e['start_at']), 'end' => $e['all_day'] ? substr($e['end_at'], 0, 10) : self::iso($e['end_at']),
                'repeats' => $e['repeat_json'] ? json_decode($e['repeat_json'], true) : null, 'matched_on' => $found];
        }
        return $out;
    }

    /** The team's notes on the matching conversations (shared mailboxes). */
    private function notes(array $threads): array
    {
        $out = [];
        foreach ($threads as [$mailboxId, $key, $subject, $dir]) {
            foreach ($this->app->db->all("SELECT n.*, u.email_enc FROM {thread_notes} n LEFT JOIN {users} u ON u.id = n.user_id WHERE n.mailbox_id = ? AND n.thread_key = ? AND n.kind = 'note' ORDER BY n.id",
                [$mailboxId, $key]) as $n) {
                $out[] = ['conversation' => $subject, 'folder' => $dir, 'by' => $n['email_enc'] ? $this->c()->decrypt($n['email_enc'], 'users.email') : null,
                    'note' => $this->c()->decrypt($n['body_enc'], 'notes.body'), 'at' => self::iso($n['created_at'])];
            }
        }
        return $out;
    }

    private function readme(array $r, int $messages, int $entries, int $notes, string $by, int $events = 0): string
    {
        $terms = $r['terms'] ? implode(', ', array_map(fn ($t) => "\"$t\"", $r['terms'])) : 'none';
        $boxes = is_array($r['mailboxes']) ? implode(', ', $r['mailboxes']) : 'all mailboxes';
        $range = ($r['since'] || $r['until']) ? ' from ' . ($r['since'] ? substr($r['since'], 0, 10) : 'the start') . ' to ' . ($r['until'] ? substr($r['until'], 0, 10) : 'now') : '';
        return <<<TXT
        Data request {$r['id']}
        ====================================

        Email address searched for: {$r['email']}
        Other terms searched for:   $terms
        Reference:                  {$r['reference']}
        Mailboxes:                  $boxes (every folder, including Drafts, Spam and Trash)$range
        Requested:                  {$r['created_at']}
        Exported:                   {$this->now()}{$this->byLine($by)}

        What's in this file
        -------------------
        messages.csv     One row per email ($messages): date, mailbox, people, subject, where the person was found, and its folder here.
        messages/        Each email as message.txt (headers and text) and message.html (as it was sent), with its attachments.
        contacts.json    The person's address book entries ($entries) and who has emailed them.
        team-notes.json  Notes the team wrote on these conversations ($notes), if there are any.
        calendar.json    Calendar events whose title, place or notes mention the address or a term ($events), if there are any.
        request.json     The request, for your records.

        How the search works
        --------------------
        An email is included when the address is its sender or a recipient (To, Cc, Bcc, Reply-To), or the address or
        one of the terms is in its subject, its text or an attachment's name. "Matched" in each email says which. The
        contents of attachments (PDFs, images) are not searched, but each matching email's attachments are included.

        Before you send it
        ------------------
        These emails may contain other people's personal data (colleagues, other customers). Check them and remove
        or redact what the person isn't entitled to before you send this (UK GDPR / GDPR article 15(4)).
        The results are kept on the webmail for 30 days from the request, then removed. The record that the request was made stays.

        TXT;
    }

    private function now(): string
    {
        return gmdate('c');
    }

    private function byLine(string $by): string
    {
        return $by !== '' ? " by $by" : '';
    }

    // ---------------------------------------------------------------------------------------------- helpers

    private function addresses(array $mailboxIds): array
    {
        if (!$mailboxIds) {
            return [];
        }
        $rows = $this->app->db->all('SELECT address_enc FROM {mailboxes} WHERE id IN (' . implode(', ', array_fill(0, count($mailboxIds), '?')) . ')', $mailboxIds);
        return array_map(fn ($r) => (string) $this->c()->decrypt($r['address_enc'], 'mailboxes.address'), $rows);
    }

    private function keyName(int $id): ?string
    {
        $v = $this->app->db->value('SELECT name_enc FROM {api_keys} WHERE id = ?', [$id]);
        return $v ? $this->c()->decrypt($v, 'api_keys.name') : null;
    }

    private function userEmail(int $id): ?string
    {
        $v = $this->app->db->value('SELECT email_enc FROM {users} WHERE id = ?', [$id]);
        return $v ? $this->c()->decrypt($v, 'users.email') : null;
    }

    private static function date(mixed $v, string $name): ?string
    {
        if ($v === null || $v === '') {
            return null;
        }
        $t = strtotime((string) $v);
        if ($t === false) {
            throw new HttpError(422, "$name must be a date, like 2025-01-31", 'invalid_request');
        }
        return gmdate('Y-m-d H:i:s', $t);
    }

    private static function iso(?string $dt): ?string
    {
        return $dt ? gmdate('c', strtotime($dt . ' UTC')) : null;
    }

    // ---------------------------------------------------------------------------------------------- routes

    /** The API for other systems: api.php?a=data-requests…, with a key. */
    public function routeApi(string $action, string $method): never
    {
        $key = $this->authenticate(self::bearer(), Http::ip());
        $id = (string) ($_GET['id'] ?? '');
        switch ("$method $action") {
            case 'POST data-requests':
                Http::json($this->create(Http::body(), ['key' => $key['id']]), 201);
            case 'GET data-requests':
                if ($id !== '') {
                    Http::json($this->get($id, $key['id']));
                }
                Http::json(['data_requests' => $this->list($key['id'])]);
            case 'GET data-requests/export':
                $this->download($id, $key['id'], 'API key "' . $key['name'] . '"');
            case 'POST data-requests/discard':
                Http::json($this->discard($id, $key['id']));
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    /** Settings → Data requests (administrators). */
    public function routeAdmin(string $action, string $method, array $me): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        $id = (string) ($_GET['id'] ?? $in['id'] ?? '');
        switch ("$method $action") {
            case 'GET admin/data-requests':
                Http::json(['data_requests' => $this->list(), 'keys' => $this->keys()]);
            case 'POST admin/data-requests':
                Http::json($this->create($in, ['user' => $me['id']]), 201);
            case 'GET admin/data-requests/one':
                Http::json($this->get($id));
            case 'GET admin/data-requests/export':
                $this->download($id, null, (string) $me['email']);
            case 'POST admin/data-requests/discard':
                Http::json($this->discard($id));
            case 'POST admin/data-requests/keys':
                (new Auth($this->app))->confirm($me['id'], $in);
                Http::json($this->createKey($me['id'], (string) ($in['name'] ?? ''), (array) ($in['allowed_ips'] ?? [])), 201);
            case 'POST admin/data-requests/keys/revoke':
                $this->revokeKey((int) ($in['id'] ?? 0));
                Http::json(['ok' => true]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    /** Build the ZIP in a temporary file (so an error comes back as JSON, not half a file), then send it. */
    private function download(string $publicId, ?int $keyId, string $by): never
    {
        @set_time_limit(300);
        $tmp = fopen('php://temp/maxmemory:' . (8 * 1024 * 1024), 'w+b');
        $info = $this->export($publicId, $tmp, $keyId, $by);
        rewind($tmp);
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $info['filename'] . '"');
        header('Content-Length: ' . $info['bytes']);
        header('Cache-Control: no-store');
        fpassthru($tmp);
        exit;
    }
}
