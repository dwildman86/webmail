<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello, a fingerprint or a security key instead of a
 * password. The device keeps the private key; we keep the public key (encrypted) and check a signature over a fresh
 * challenge at each sign-in. No attestation is asked for, so any authenticator works.
 */
final class Passkeys
{
    private const ES256 = -7;
    private const RS256 = -257;
    private const CHALLENGE_SECONDS = 300;

    public function __construct(private App $app, private ?string $origin = null)
    {
    }

    /** https://mail.example.com: what the browser reports as the origin. */
    public function origin(): string
    {
        if ($this->origin !== null) {
            return $this->origin;
        }
        $u = parse_url($this->app->baseUrl());
        return ($u['scheme'] ?? 'https') . '://' . ($u['host'] ?? '') . (isset($u['port']) ? ':' . $u['port'] : '');
    }

    /** The relying party id: the webmail's host name. */
    public function rpId(): string
    {
        return (string) parse_url($this->origin(), PHP_URL_HOST);
    }

    public function route(string $action, string $method, ?array $user): never
    {
        $in = $method === 'POST' ? Http::body() : [];
        if ($action === 'passkey/login/options' && $method === 'GET') {
            Http::json($this->loginOptions());
        }
        if ($action === 'passkey/login' && $method === 'POST') {
            $uid = $this->login($in);
            (new Auth($this->app))->begin($uid);
            Http::json(['ok' => true, 'csrf' => Auth::csrfToken()]);
        }
        if (!$user) {
            throw new HttpError(401, 'Sign in first', 'unauthenticated');
        }
        switch ("$method $action") {
            case 'GET passkey/list':
                Http::json(['passkeys' => $this->list($user['id'])]);
            case 'GET passkey/register/options':
                Http::json($this->registerOptions($user));
            case 'POST passkey/register':
                Http::json(['id' => $this->register($user['id'], $in)]);
            case 'POST passkey/delete':
                $this->app->db->run('DELETE FROM {passkeys} WHERE id = ? AND user_id = ?', [(int) ($in['id'] ?? 0), $user['id']]);
                Http::json(['ok' => true]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    public function list(int $userId): array
    {
        $c = $this->app->crypto;
        return array_map(fn ($r) => ['id' => (int) $r['id'], 'name' => $c->decrypt($r['name_enc'], 'passkeys.name') ?? 'Passkey',
            'created_at' => $r['created_at'] . 'Z', 'last_used_at' => $r['last_used_at'] ? $r['last_used_at'] . 'Z' : null],
            $this->app->db->all('SELECT id, name_enc, created_at, last_used_at FROM {passkeys} WHERE user_id = ? ORDER BY id', [$userId]));
    }

    public function registerOptions(array $user): array
    {
        $c = $this->app->crypto;
        $exclude = array_map(fn ($r) => ['type' => 'public-key', 'id' => $c->decrypt($r['credential_id_enc'], 'passkeys.credential_id')],
            $this->app->db->all('SELECT credential_id_enc FROM {passkeys} WHERE user_id = ?', [$user['id']]));
        return [
            'challenge' => $this->challenge('register'),
            'rp' => ['id' => $this->rpId(), 'name' => (string) $this->app->config->get('app_name', 'Webmail')],
            'user' => ['id' => Notifier::b64u($c->blindIndex((string) $user['id'], 'passkeys.user')), 'name' => $user['email'], 'displayName' => $user['name'] ?: $user['email']],
            'pubKeyCredParams' => [['type' => 'public-key', 'alg' => self::ES256], ['type' => 'public-key', 'alg' => self::RS256]],
            'authenticatorSelection' => ['residentKey' => 'required', 'requireResidentKey' => true, 'userVerification' => 'required'],
            'attestation' => 'none',
            'timeout' => self::CHALLENGE_SECONDS * 1000,
            'excludeCredentials' => $exclude,
        ];
    }

    /** Store a new passkey from navigator.credentials.create(). Returns its id. */
    public function register(int $userId, array $in): int
    {
        $this->clientData((string) ($in['clientDataJSON'] ?? ''), 'webauthn.create', 'register');
        $att = Cbor::decode(Notifier::unb64u((string) ($in['attestationObject'] ?? '')));
        $auth = is_array($att) ? (string) ($att['authData'] ?? '') : '';
        $parsed = $this->authData($auth);
        if (!($parsed['flags'] & 0x40)) {
            throw new HttpError(422, 'The passkey didn\'t include a key', 'invalid_passkey');
        }
        $p = 37 + 16;
        $len = unpack('n', substr($auth, $p, 2))[1];
        $credId = substr($auth, $p + 2, $len);
        $offset = 0;
        $cose = Cbor::decode(substr($auth, $p + 2 + $len), $offset, true);
        $pem = self::coseToPem($cose);
        if ($credId === '' || strlen($credId) !== $len) {
            throw new HttpError(422, 'The passkey wasn\'t understood', 'invalid_passkey');
        }
        $c = $this->app->crypto;
        $name = trim((string) ($in['name'] ?? '')) ?: 'Passkey';
        try {
            return $this->app->db->insert(
                'INSERT INTO {passkeys} (user_id, credential_bidx, credential_id_enc, public_key_enc, sign_count, name_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$userId, $c->blindIndex($credId, 'passkeys.credential'), $c->encrypt(Notifier::b64u($credId), 'passkeys.credential_id'),
                    $c->encrypt($pem, 'passkeys.public_key'), $parsed['count'], $c->encrypt(mb_substr($name, 0, 60), 'passkeys.name'), App::now()],
            );
        } catch (\PDOException $e) {
            if (($e->errorInfo[1] ?? 0) !== 1062) {
                throw $e;
            }
            throw new HttpError(409, 'That passkey is already registered', 'passkey_exists');
        }
    }

    public function loginOptions(): array
    {
        // No list of keys: the device offers the passkeys it holds for this site, so nobody's email is needed.
        return ['challenge' => $this->challenge('login'), 'rpId' => $this->rpId(), 'userVerification' => 'required', 'timeout' => self::CHALLENGE_SECONDS * 1000];
    }

    /** Check a navigator.credentials.get() answer. Returns the user id it signs in. */
    public function login(array $in): int
    {
        $rawId = Notifier::unb64u((string) ($in['id'] ?? ''));
        $clientJson = Notifier::unb64u((string) ($in['clientDataJSON'] ?? ''));
        $this->clientData((string) ($in['clientDataJSON'] ?? ''), 'webauthn.get', 'login');
        $authData = Notifier::unb64u((string) ($in['authenticatorData'] ?? ''));
        $parsed = $this->authData($authData);
        $c = $this->app->crypto;
        $row = $rawId === '' ? null : $this->app->db->one(
            'SELECT p.id, p.user_id, p.public_key_enc, p.sign_count, u.disabled FROM {passkeys} p JOIN {users} u ON u.id = p.user_id WHERE p.credential_bidx = ?',
            [$c->blindIndex($rawId, 'passkeys.credential')],
        );
        if (!$row || $row['disabled']) {
            throw new HttpError(401, 'That passkey isn\'t registered here. Sign in with your password and add it under Settings.', 'unknown_passkey');
        }
        $signature = Notifier::unb64u((string) ($in['signature'] ?? ''));
        $ok = openssl_verify($authData . hash('sha256', $clientJson, true), $signature, $c->decrypt($row['public_key_enc'], 'passkeys.public_key'), OPENSSL_ALGO_SHA256);
        if ($ok !== 1) {
            throw new HttpError(401, 'The passkey\'s signature didn\'t check out', 'invalid_passkey');
        }
        // A counter that goes backwards means the key was copied.
        if ($parsed['count'] !== 0 && $parsed['count'] <= (int) $row['sign_count']) {
            throw new HttpError(401, 'This passkey looks like a copy, so it was refused', 'cloned_passkey');
        }
        $this->app->db->run('UPDATE {passkeys} SET sign_count = ?, last_used_at = ? WHERE id = ?', [$parsed['count'], App::now(), $row['id']]);
        return (int) $row['user_id'];
    }

    private function challenge(string $purpose): string
    {
        $challenge = Notifier::b64u(random_bytes(32));
        $_SESSION['webauthn'] = ['purpose' => $purpose, 'challenge' => $challenge, 'at' => time()];
        return $challenge;
    }

    /** Checks the browser's clientDataJSON: the kind of request, our challenge (used once) and our origin. */
    private function clientData(string $b64, string $type, string $purpose): array
    {
        $data = json_decode(Notifier::unb64u($b64), true);
        $expected = $_SESSION['webauthn'] ?? null;
        unset($_SESSION['webauthn']);
        if (!is_array($data) || ($data['type'] ?? '') !== $type) {
            throw new HttpError(422, 'The passkey answer wasn\'t understood', 'invalid_passkey');
        }
        if (!$expected || $expected['purpose'] !== $purpose || time() - $expected['at'] > self::CHALLENGE_SECONDS
            || !hash_equals($expected['challenge'], (string) ($data['challenge'] ?? ''))) {
            throw new HttpError(422, 'The passkey request expired. Try again.', 'expired_challenge');
        }
        if (($data['origin'] ?? '') !== $this->origin()) {
            throw new HttpError(422, 'The passkey was made for a different site', 'wrong_origin');
        }
        return $data;
    }

    /** rpIdHash (32) | flags (1) | signCount (4) | …: checks the site and that the person was there and verified. */
    private function authData(string $auth): array
    {
        if (strlen($auth) < 37 || !hash_equals(hash('sha256', $this->rpId(), true), substr($auth, 0, 32))) {
            throw new HttpError(422, 'The passkey is for a different site', 'wrong_rp');
        }
        $flags = ord($auth[32]);
        if (!($flags & 0x01) || !($flags & 0x04)) {
            throw new HttpError(422, 'Your device didn\'t confirm it was you (Face ID, fingerprint or PIN)', 'not_verified');
        }
        return ['flags' => $flags, 'count' => unpack('N', substr($auth, 33, 4))[1]];
    }

    /** A COSE public key (EC2 P-256 or RSA) as PEM. */
    public static function coseToPem(mixed $cose): string
    {
        if (!is_array($cose)) {
            throw new HttpError(422, 'The passkey\'s key wasn\'t understood', 'invalid_passkey');
        }
        if (($cose[1] ?? null) === 2 && ($cose[3] ?? null) === self::ES256 && ($cose[-1] ?? null) === 1 && strlen((string) ($cose[-2] ?? '')) === 32 && strlen((string) ($cose[-3] ?? '')) === 32) {
            return Notifier::pemFromPoint("\x04" . $cose[-2] . $cose[-3]);
        }
        if (($cose[1] ?? null) === 3 && ($cose[3] ?? null) === self::RS256 && is_string($cose[-1] ?? null) && is_string($cose[-2] ?? null)) {
            $int = fn (string $b) => "\x02" . self::derLen(strlen($b = (ord($b[0]) & 0x80 ? "\0" . $b : $b))) . $b;
            $rsaKey = $int($cose[-1]) . $int($cose[-2]);
            $rsaKey = "\x30" . self::derLen(strlen($rsaKey)) . $rsaKey;
            $bits = "\x03" . self::derLen(strlen($rsaKey) + 1) . "\0" . $rsaKey;
            $spki = hex2bin('300d06092a864886f70d0101010500') . $bits;
            $der = "\x30" . self::derLen(strlen($spki)) . $spki;
            return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
        }
        throw new HttpError(422, 'This kind of passkey isn\'t supported', 'unsupported_passkey');
    }

    private static function derLen(int $n): string
    {
        if ($n < 128) {
            return chr($n);
        }
        $b = ltrim(pack('N', $n), "\0");
        return chr(0x80 | strlen($b)) . $b;
    }
}
