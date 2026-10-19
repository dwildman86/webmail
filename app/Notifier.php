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
                $this->unsubscribe((string) ($in['endpoint'] ?? ''));
                Http::json(['ok' => true]);
            case 'POST push/test':
                $sent = $this->notifyUser($user['id'], ['title' => 'Notifications are on', 'body' => 'You\'ll hear about new email on this device.', 'tag' => 'test', 'url' => './']);
                Http::json(['sent' => $sent]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    public function subscribe(int $userId, array $sub): void
    {
        $endpoint = (string) ($sub['endpoint'] ?? '');
        $p256dh = self::unb64u((string) ($sub['keys']['p256dh'] ?? ''));
        $auth = self::unb64u((string) ($sub['keys']['auth'] ?? ''));
        if (!preg_match('#^https://#', $endpoint) || strlen($p256dh) !== 65 || $p256dh[0] !== "\x04" || strlen($auth) !== 16) {
            throw new HttpError(422, 'That isn\'t a valid push subscription', 'invalid_subscription');
        }
        $c = $this->app->crypto;
        $data = $c->encryptJson(['endpoint' => $endpoint, 'p256dh' => $sub['keys']['p256dh'], 'auth' => $sub['keys']['auth']], 'push.subscription');
        $this->app->db->run(
            'INSERT INTO {push_subscriptions} (user_id, endpoint_bidx, subscription_enc, created_at) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), subscription_enc = VALUES(subscription_enc)',
            [$userId, $c->blindIndex($endpoint, 'push.endpoint'), $data, App::now()],
        );
    }

    public function unsubscribe(string $endpoint): void
    {
        $this->app->db->run('DELETE FROM {push_subscriptions} WHERE endpoint_bidx = ?', [$this->app->crypto->blindIndex($endpoint, 'push.endpoint')]);
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
            if ($db->value('SELECT folder FROM {messages} WHERE id = ?', [$s['id']]) !== 'inbox') {
                continue;
            }
            $payload = ['title' => mb_substr($sender, 0, 80), 'body' => mb_substr((string) (($data['subject'] ?? '') ?: '(no subject)'), 0, 140),
                'tag' => 'm' . $s['id'], 'url' => './#m=' . $s['id']];
            foreach ($db->all('SELECT user_id FROM {user_mailboxes} WHERE mailbox_id = ?', [$s['mailbox_id']]) as $row) {
                $this->notifyUser((int) $row['user_id'], $payload);
            }
        }
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
        $url = parse_url($sub['endpoint']);
        $jwt = $this->jwt($url['scheme'] . '://' . $url['host'] . (isset($url['port']) ? ':' . $url['port'] : ''), $vapid);
        $headers = ['Content-Type: application/octet-stream', 'Content-Encoding: aes128gcm', 'TTL: 86400', 'Urgency: high',
            'Authorization: vapid t=' . $jwt . ', k=' . $vapid['public']];
        if ($this->transport) {
            return ($this->transport)($sub['endpoint'], $headers, $body);
        }
        $ch = curl_init($sub['endpoint']);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_CONNECTTIMEOUT => 5]);
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
