<?php
declare(strict_types=1);

namespace Webmail;

/**
 * New-mail notifications with standard Web Push: the message is encrypted for the device (RFC 8291, aes128gcm) and
 * signed with this webmail's VAPID key (RFC 8292). Plain PHP and OpenSSL, so it works on shared hosting.
 *
 * The VAPID key is made the first time it's needed and kept encrypted in the database.
 */
final class Notifier
{
    /** How long a notification's buttons (Mark as read, Archive, Reply) keep working. */
    public const ACTION_TTL = 7 * 86400;
    public const ACTIONS = ['read', 'archive', 'reply'];
    public const MAX_REPLY = 10000;

    /** (string $url, array $headers, string $body): int status. Swapped in tests; cURL otherwise. */
    public ?\Closure $transport = null;

    public function __construct(private App $app)
    {
    }

    public static function supported(): bool
    {
        return function_exists('openssl_pkey_derive') && in_array('aes-128-gcm', openssl_get_cipher_methods(), true);
    }

    /** The VAPID key pair: ['public' => base64url of the raw P-256 point, 'pem' => private key]. */
    public function vapid(): array
    {
        $db = $this->app->db;
        $stored = $db->value("SELECT v FROM {meta} WHERE k = 'vapid'");
        if ($stored) {
            return $this->app->crypto->decryptJson($stored, 'meta.vapid');
        }
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        openssl_pkey_export($key, $pem);
        $pair = ['public' => self::b64u(self::rawPublic($key)), 'pem' => $pem];
        $db->run("INSERT IGNORE INTO {meta} (k, v) VALUES ('vapid', ?)", [$this->app->crypto->encryptJson($pair, 'meta.vapid')]);
        // Two requests at once: keep whichever was stored first.
        return $this->app->crypto->decryptJson($db->value("SELECT v FROM {meta} WHERE k = 'vapid'"), 'meta.vapid');
    }

    public function route(string $action, string $method, array $user): never
    {
        $in = $method === 'POST' ? Http::body() : [];
        switch ("$method $action") {
            case 'POST push/subscribe':
                $this->subscribe($user['id'], (array) ($in['subscription'] ?? []));
                Http::json(['ok' => true]);
            case 'POST push/unsubscribe':
                $this->unsubscribe((int) $user['id'], (string) ($in['endpoint'] ?? ''));
                Http::json(['ok' => true]);
            case 'POST push/test':
                $sent = $this->notifyUser($user['id'], ['title' => 'Notifications are on', 'body' => 'You\'ll hear about new email on this device.', 'tag' => 'test', 'url' => './']);
                Http::json(['sent' => $sent]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    /**
     * The browsers' push services (Chrome and Edge's FCM, Firefox's Mozilla push, Edge on Windows' WNS, Safari's Apple
     * push). A subscription is only ever one of these: anything else would have this server send requests wherever a
     * signed-in person asked. Others can be added with 'push_hosts' => ['push.example.com'] in config.php.
     */
    private const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com',
        'notify.windows.com', 'push.apple.com'];

    public function pushHostAllowed(string $endpoint): bool
    {
        $u = parse_url($endpoint);
        if (($u['scheme'] ?? '') !== 'https' || empty($u['host']) || isset($u['user']) || isset($u['pass']) || (isset($u['port']) && (int) $u['port'] !== 443)) {
            return false;
        }
        $host = strtolower($u['host']);
        foreach ([...self::PUSH_HOSTS, ...array_map('strval', (array) $this->app->config->get('push_hosts', []))] as $allowed) {
            $allowed = strtolower(ltrim($allowed, '.'));
            if ($allowed !== '' && ($host === $allowed || str_ends_with($host, '.' . $allowed))) {
                return true;
            }
        }
        return false;
    }

    public function subscribe(int $userId, array $sub): void
    {
        $endpoint = (string) ($sub['endpoint'] ?? '');
        $p256dh = self::unb64u((string) ($sub['keys']['p256dh'] ?? ''));
        $auth = self::unb64u((string) ($sub['keys']['auth'] ?? ''));
        if (!$this->pushHostAllowed($endpoint) || strlen($endpoint) > 1000 || strlen($p256dh) !== 65 || $p256dh[0] !== "\x04" || strlen($auth) !== 16) {
            throw new HttpError(422, 'That isn\'t a valid push subscription', 'invalid_subscription');
        }
        $c = $this->app->crypto;
        $data = $c->encryptJson(['endpoint' => $endpoint, 'p256dh' => $sub['keys']['p256dh'], 'auth' => $sub['keys']['auth']], 'push.subscription');
        $this->app->db->run(
            'INSERT INTO {push_subscriptions} (user_id, endpoint_bidx, subscription_enc, created_at, session_hash) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), subscription_enc = VALUES(subscription_enc), session_hash = VALUES(session_hash)',
            // The session that turned them on: signing that device out (Settings → Sign-in & alerts) stops them.
            [$userId, $c->blindIndex($endpoint, 'push.endpoint'), $data, App::now(), session_status() === PHP_SESSION_ACTIVE ? hash('sha256', session_id()) : null],
        );
    }

    /** One of this person's devices stops: someone else's subscription is left alone. */
    public function unsubscribe(int $userId, string $endpoint): void
    {
        $this->app->db->run('DELETE FROM {push_subscriptions} WHERE endpoint_bidx = ? AND user_id = ?', [$this->app->crypto->blindIndex($endpoint, 'push.endpoint'), $userId]);
    }

    /** Called by Inbound for each new email: tells the people who can read the mailbox, unless it went to Spam. */
    public function newMail(array $stored, array $data): void
    {
        if (!$stored || !self::supported()) {
            return;
        }
        $db = $this->app->db;
        $from = $data['from'] ?? [];
        $sender = is_array($from) ? (($from['name'] ?? '') ?: ($from['address'] ?? 'Someone')) : (string) $from;
        foreach ($stored as $s) {
            // Filed away or marked read by one of the mailbox's rules: nothing to announce.
            $row = $db->one('SELECT folder, is_read FROM {messages} WHERE id = ?', [$s['id']]);
            if (!$row || $row['folder'] !== 'inbox' || $row['is_read']) {
                continue;
            }
            $payload = ['title' => mb_substr($sender, 0, 80), 'body' => mb_substr((string) (($data['subject'] ?? '') ?: '(no subject)'), 0, 140),
                'tag' => 'm' . $s['id'], 'url' => './#m=' . $s['id']];
            foreach ($db->all('SELECT user_id FROM {user_mailboxes} WHERE mailbox_id = ?', [$s['mailbox_id']]) as $row) {
                $this->notifyUser((int) $row['user_id'], $this->mailPayload((int) $row['user_id'], (int) $s['id'], $payload));
            }
        }
    }

    /**
     * A new-mail notification for one person: with their unread count (for the badge on the app's icon), and what its
     * buttons need to work without opening the app (Mark as read, Archive, Reply): the email and a token for it.
     */
    public function mailPayload(int $userId, int $messageId, array $payload): array
    {
        return $payload + ['unread' => $this->unreadFor($userId), 'message_id' => $messageId, 'token' => $this->actionToken($userId, $messageId)];
    }

    // ---------------------------------------------------------------------------------------------- notification buttons

    /**
     * What lets a notification's buttons act on one email for one person, without a signed-in session (the browser
     * may have none: the notification can come long after the webmail was last open). It's only ever inside the
     * encrypted push message. Signed with the webmail's key; it names the person and the email, stops working after
     * ACTION_TTL, and as soon as the person is signed out everywhere (a password change, a two-step reset).
     */
    public function actionToken(int $userId, int $messageId, ?int $now = null): string
    {
        $version = (int) $this->app->db->value('SELECT session_version FROM {users} WHERE id = ?', [$userId]);
        $claims = self::b64u(json_encode(['u' => $userId, 'm' => $messageId, 'v' => $version, 'e' => ($now ?? time()) + self::ACTION_TTL]));
        return $claims . '.' . self::b64u($this->app->crypto->blindIndex($claims, 'push.action'));
    }

    /** The person and email a token is for, if it's genuine and still good. */
    private function checkToken(string $token, ?int $now = null): array
    {
        [$claims, $mac] = explode('.', $token, 2) + ['', ''];
        if ($claims === '' || !hash_equals(self::b64u($this->app->crypto->blindIndex($claims, 'push.action')), $mac)) {
            throw new HttpError(403, 'This notification can\'t do that', 'bad_token');
        }
        $c = json_decode(self::unb64u($claims), true);
        if (!is_array($c) || (int) ($c['e'] ?? 0) < ($now ?? time())) {
            throw new HttpError(403, 'This notification is too old', 'expired');
        }
        $row = $this->app->db->one('SELECT id, email_enc, name_enc, role, disabled, session_version FROM {users} WHERE id = ?', [(int) ($c['u'] ?? 0)]);
        if (!$row || $row['disabled'] || (int) $row['session_version'] !== (int) ($c['v'] ?? -1)) {
            throw new HttpError(403, 'You\'ve been signed out', 'signed_out');
        }
        $crypto = $this->app->crypto;
        return [['id' => (int) $row['id'], 'email' => $crypto->decrypt($row['email_enc'], 'users.email'), 'name' => $crypto->decrypt($row['name_enc'], 'users.name') ?? '',
            'role' => $row['role']], (int) ($c['m'] ?? 0)];
    }

    /**
     * A notification's button: "read" marks the conversation read, "archive" moves it out of the Inbox, "reply" sends
     * $text as a reply (from the mailbox it came to, threaded like any reply). Only email the person can still read.
     * Returns their unread count, for the badge.
     */
    public function act(string $token, string $action, string $text = '', ?int $now = null): array
    {
        if (!in_array($action, self::ACTIONS, true)) {
            throw new HttpError(422, 'Unknown action', 'bad_action');
        }
        [$user, $messageId] = $this->checkToken($token, $now);
        $store = new Mailstore($this->app);
        $out = ['ok' => true];
        if ($action === 'reply') {
            $text = trim(str_replace("\r\n", "\n", $text));
            if ($text === '') {
                throw new HttpError(422, 'Write a reply first', 'empty');
            }
            if (mb_strlen($text) > self::MAX_REPLY) {
                throw new HttpError(422, 'That reply is too long for a notification: open the webmail to send it', 'too_long');
            }
        }
        $orig = $store->get($user['id'], $messageId, true)['message']; // 404 if they can't read it any more; marks it read
        if ($action === 'archive') {
            $ids = array_map('intval', array_column($this->app->db->all('SELECT id FROM {messages} WHERE mailbox_id = ? AND folder = ? AND (id = ? OR (thread_key IS NOT NULL AND thread_key = ?))',
                [$orig['mailbox_id'], $orig['folder'], $messageId, (string) $orig['thread_key']]), 'id'));
            if ($orig['folder'] === 'inbox') {
                $store->update($user['id'], $ids, ['folder' => 'archive']);
            }
        } elseif ($action === 'reply') {
            $to = array_values(array_filter(array_map(fn ($p) => $p['address'] ?? '', $orig['reply_to'] ?: [$orig['from']])));
            if (!$to) {
                throw new HttpError(422, 'There\'s no address to reply to', 'no_recipients');
            }
            $subject = (string) $orig['subject'];
            $sent = $store->send($user, (int) $orig['mailbox_id'], ['to' => $to, 'subject' => preg_match('/^re:/i', $subject) ? $subject : "Re: $subject", 'text' => $text,
                'html' => '<div>' . nl2br(htmlspecialchars($text, ENT_QUOTES | ENT_HTML5, 'UTF-8')) . '</div>', 'reply_to_id' => $messageId]);
            $out['sent'] = $sent['id'];
        }
        return $out + ['unread' => $this->unreadFor($user['id'])];
    }

    /** Unread email in the inbox of every mailbox the user can read. */
    public function unreadFor(int $userId): int
    {
        return (int) $this->app->db->value(
            "SELECT COUNT(*) FROM {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id WHERE um.user_id = ? AND m.folder = 'inbox' AND m.is_read = 0 AND m.snoozed_until IS NULL",
            [$userId],
        );
    }

    /** Push to each of a user's devices; returns how many took it. Devices that have gone away are forgotten. */
    public function notifyUser(int $userId, array $payload): int
    {
        $sent = 0;
        foreach ($this->app->db->all('SELECT id, subscription_enc FROM {push_subscriptions} WHERE user_id = ?', [$userId]) as $row) {
            $sub = $this->app->crypto->decryptJson($row['subscription_enc'], 'push.subscription');
            $status = $this->push($sub, json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            if ($status === 404 || $status === 410) {
                $this->app->db->run('DELETE FROM {push_subscriptions} WHERE id = ?', [$row['id']]);
            } elseif ($status >= 200 && $status < 300) {
                $sent++;
            } else {
                error_log("webmail: push service answered $status");
            }
        }
        return $sent;
    }

    /** Encrypt and send one message to one device. Returns the push service's HTTP status. */
    public function push(array $sub, string $payload): int
    {
        $body = self::encrypt($payload, self::unb64u($sub['p256dh']), self::unb64u($sub['auth']));
        $vapid = $this->vapid();
        // Saved before push services were checked: never sent anywhere else.
        if (!$this->pushHostAllowed((string) $sub['endpoint'])) {
            return 410;
        }
        $url = parse_url($sub['endpoint']);
        $jwt = $this->jwt($url['scheme'] . '://' . $url['host'] . (isset($url['port']) ? ':' . $url['port'] : ''), $vapid);
        $headers = ['Content-Type: application/octet-stream', 'Content-Encoding: aes128gcm', 'TTL: 86400', 'Urgency: high',
            'Authorization: vapid t=' . $jwt . ', k=' . $vapid['public']];
        if ($this->transport) {
            return ($this->transport)($sub['endpoint'], $headers, $body);
        }
        $ch = curl_init($sub['endpoint']);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS]);
        curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return $status;
    }

    /** RFC 8291: one aes128gcm record, encrypted for the device's key and auth secret. */
    public static function encrypt(string $plaintext, string $uaPublic, string $authSecret, ?string $salt = null): string
    {
        $local = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $asPublic = self::rawPublic($local);
        $secret = openssl_pkey_derive(openssl_pkey_get_public(self::pemFromPoint($uaPublic)), $local, 32);
        if ($secret === false) {
            throw new \RuntimeException('Could not agree a key with the device');
        }
        $salt ??= random_bytes(16);
        $ikm = hash_hkdf('sha256', $secret, 32, "WebPush: info\0" . $uaPublic . $asPublic, $authSecret);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
        $cipher = openssl_encrypt($plaintext . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
        return $salt . pack('N', 4096) . chr(65) . $asPublic . $cipher . $tag;
    }

    /** RFC 8292: a short-lived ES256 token naming the push service and this webmail. */
    private function jwt(string $audience, array $vapid): string
    {
        $contact = $this->app->config->get('vapid_subject') ?: ($this->app->baseUrl() ?: 'mailto:admin@localhost');
        $head = self::b64u(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
        $claims = self::b64u(json_encode(['aud' => $audience, 'exp' => time() + 12 * 3600, 'sub' => $contact], JSON_UNESCAPED_SLASHES));
        openssl_sign("$head.$claims", $der, $vapid['pem'], OPENSSL_ALGO_SHA256);
        return "$head.$claims." . self::b64u(self::derToRaw($der));
    }

    /** The uncompressed P-256 point (0x04 || x || y) of a key. */
    private static function rawPublic(\OpenSSLAsymmetricKey $key): string
    {
        $ec = openssl_pkey_get_details($key)['ec'];
        return "\x04" . str_pad($ec['x'], 32, "\0", STR_PAD_LEFT) . str_pad($ec['y'], 32, "\0", STR_PAD_LEFT);
    }

    /** A PEM public key from an uncompressed P-256 point. */
    public static function pemFromPoint(string $point): string
    {
        $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point;
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    /** An ECDSA signature from OpenSSL's DER form to JOSE's r || s. */
    private static function derToRaw(string $der): string
    {
        $pos = 2 + (ord($der[1]) & 0x80 ? ord($der[1]) & 0x7f : 0);
        $out = '';
        for ($i = 0; $i < 2; $i++) {
            $len = ord($der[$pos + 1]);
            $int = ltrim(substr($der, $pos + 2, $len), "\0");
            $out .= str_pad($int, 32, "\0", STR_PAD_LEFT);
            $pos += 2 + $len;
        }
        return $out;
    }

    public static function b64u(string $s): string
    {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }

    public static function unb64u(string $s): string
    {
        return (string) base64_decode(strtr($s, '-_', '+/'), true);
    }
}
