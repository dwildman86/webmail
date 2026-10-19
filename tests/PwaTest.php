<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Inbound;
use Webmail\Mailstore;
use Webmail\Notifier;
use Webmail\Passkeys;

final class PwaTest extends TestCase
{
    // ------------------------------------------------------------------------------------------------ push

    /** A browser's push subscription: its key pair and auth secret. */
    private function device(): array
    {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $ec = openssl_pkey_get_details($key)['ec'];
        $auth = random_bytes(16);
        $point = "\x04" . str_pad($ec['x'], 32, "\0", STR_PAD_LEFT) . str_pad($ec['y'], 32, "\0", STR_PAD_LEFT);
        return ['key' => $key, 'point' => $point, 'auth' => $auth, 'sub' => ['endpoint' => 'https://push.example.net/send/' . bin2hex(random_bytes(6)),
            'keys' => ['p256dh' => Notifier::b64u($point), 'auth' => Notifier::b64u($auth)]]];
    }

    /** What the browser does with a push: RFC 8291 decryption. */
    private function decrypt(string $body, array $device): string
    {
        $salt = substr($body, 0, 16);
        $this->assertSame(4096, unpack('N', substr($body, 16, 4))[1]);
        $this->assertSame(65, ord($body[20]));
        $asPublic = substr($body, 21, 65);
        $cipher = substr($body, 86, -16);
        $secret = openssl_pkey_derive(openssl_pkey_get_public(Notifier::pemFromPoint($asPublic)), $device['key'], 32);
        $ikm = hash_hkdf('sha256', $secret, 32, "WebPush: info\0" . $device['point'] . $asPublic, $device['auth']);
        $plain = openssl_decrypt($cipher, 'aes-128-gcm', hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt), OPENSSL_RAW_DATA,
            hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt), substr($body, -16));
        $this->assertNotFalse($plain, 'the device can decrypt it');
        $this->assertSame("\x02", substr($plain, -1), 'last-record delimiter');
        return substr($plain, 0, -1);
    }

    public function testNewMailIsPushedEncryptedAndSignedToEachDevice(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $other = (new Auth($this->app))->createUser('other@acme.test', 'Kim', 'correct horse battery');
        $store->grant($uid, $mb);
        $n = new Notifier($this->app);
        $phone = $this->device();
        $gone = $this->device();
        $kims = $this->device();
        $n->subscribe($uid, $phone['sub']);
        $n->subscribe($uid, $gone['sub']);
        $n->subscribe($other, $kims['sub']);
        $pushed = [];
        $n->transport = function (string $url, array $headers, string $body) use (&$pushed, $gone) {
            $pushed[] = compact('url', 'headers', 'body');
            return str_starts_with($url, $gone['sub']['endpoint']) ? 410 : 201;
        };

        $inbound = new Inbound($this->app);
        $inbound->onNewMail[] = [$n, 'newMail'];
        $key = base64_decode(substr($this->config['ghostparse']['webhook_secret'], 6));
        $body = json_encode(['id' => 'evt_p', 'type' => 'email.received', 'data' => $this->inbound()]);
        $ts = time();
        $inbound->handle($body, ['webhook-id' => 'evt_p', 'webhook-timestamp' => (string) $ts,
            'webhook-signature' => 'v1,' . base64_encode(hash_hmac('sha256', "evt_p.$ts.$body", $key, true))]);

        $this->assertCount(2, $pushed, 'both of Sam\'s devices, none of Kim\'s (no access to the mailbox)');
        $toPhone = $pushed[0]['url'] === $phone['sub']['endpoint'] ? $pushed[0] : $pushed[1];
        $msg = json_decode($this->decrypt($toPhone['body'], $phone), true);
        $this->assertSame('Where is my order #1042?', $msg['body']);
        $this->assertMatchesRegularExpression('/^\.\/#m=\d+$/', $msg['url']);
        $this->assertStringNotContainsString('1042', $toPhone['body'], 'the push service can\'t read it');

        // The VAPID token: ES256 over the push service's origin, verifiable with the public key we hand browsers.
        $auth = array_values(array_filter($toPhone['headers'], fn ($h) => str_starts_with($h, 'Authorization:')))[0];
        $this->assertSame(1, preg_match('/^Authorization: vapid t=([^,]+), k=(\S+)$/', $auth, $m));
        [$head, $claims, $sig] = explode('.', $m[1]);
        $this->assertSame('https://push.example.net', json_decode(Notifier::unb64u($claims), true)['aud']);
        $this->assertSame($n->vapid()['public'], $m[2]);
        $raw = Notifier::unb64u($sig);
        $der = fn ($i) => "\x02" . chr(strlen($i = (ord($i[0]) & 0x80 ? "\0" : '') . ltrim($i, "\0") ?: "\0")) . $i;
        $seq = $der(substr($raw, 0, 32)) . $der(substr($raw, 32));
        $this->assertSame(1, openssl_verify("$head.$claims", "\x30" . chr(strlen($seq)) . $seq, Notifier::pemFromPoint(Notifier::unb64u($m[2])), OPENSSL_ALGO_SHA256));

        $this->assertSame(1, (int) $this->app->db->value('SELECT COUNT(*) FROM {push_subscriptions} WHERE user_id = ?', [$uid]), 'a device that went away is forgotten');
        $this->assertSame($n->vapid(), (new Notifier($this->app))->vapid(), 'one VAPID key, kept');
        $this->assertStringNotContainsString('push.example.net', (string) $this->app->db->value('SELECT subscription_enc FROM {push_subscriptions} LIMIT 1'));
    }

    public function testSpamIsNotPushedAndBadSubscriptionsAreRefused(): void
    {
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test');
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $store->grant($uid, $mb);
        $n = new Notifier($this->app);
        $n->subscribe($uid, $this->device()['sub']);
        $count = 0;
        $n->transport = function () use (&$count) {
            $count++;
            return 201;
        };
        $stored = $store->storeInbound($this->inbound(['spam' => ['score' => 9, 'action' => 'reject']]));
        $n->newMail($stored, $this->inbound());
        $this->assertSame(0, $count);

        $this->expectException(HttpError::class);
        $n->subscribe($uid, ['endpoint' => 'http://insecure.example', 'keys' => ['p256dh' => 'x', 'auth' => 'y']]);
    }

    // ------------------------------------------------------------------------------------------------ passkeys

    private static function cbor(mixed $v): string
    {
        $head = function (int $major, int $n): string {
            return match (true) {
                $n < 24 => chr($major << 5 | $n),
                $n < 256 => chr($major << 5 | 24) . chr($n),
                $n < 65536 => chr($major << 5 | 25) . pack('n', $n),
                default => chr($major << 5 | 26) . pack('N', $n),
            };
        };
        if (is_int($v)) {
            return $v >= 0 ? $head(0, $v) : $head(1, -1 - $v);
        }
        if (is_string($v)) {
            return str_starts_with($v, 'txt:') ? $head(3, strlen($v) - 4) . substr($v, 4) : $head(2, strlen($v)) . $v;
        }
        $out = $head(5, count($v));
        foreach ($v as $k => $item) {
            $out .= self::cbor(is_int($k) ? $k : "txt:$k") . self::cbor($item);
        }
        return $out;
    }

    /** A software authenticator: what Face ID or a fingerprint reader does, minus the face. */
    private function authenticator(): array
    {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $ec = openssl_pkey_get_details($key)['ec'];
        return ['key' => $key, 'id' => random_bytes(20), 'x' => str_pad($ec['x'], 32, "\0", STR_PAD_LEFT), 'y' => str_pad($ec['y'], 32, "\0", STR_PAD_LEFT), 'count' => 0];
    }

    private function client(string $type, string $challenge, string $origin = 'https://mail.example.com'): string
    {
        return json_encode(['type' => $type, 'challenge' => $challenge, 'origin' => $origin, 'crossOrigin' => false]);
    }

    private function create(array $a, array $options, string $rp = 'mail.example.com', int $flags = 0x45): array
    {
        $cose = self::cbor([1 => 2, 3 => -7, -1 => 1, -2 => $a['x'], -3 => $a['y']]);
        $authData = hash('sha256', $rp, true) . chr($flags) . pack('N', 0) . str_repeat("\0", 16) . pack('n', strlen($a['id'])) . $a['id'] . $cose;
        return ['clientDataJSON' => Notifier::b64u($this->client('webauthn.create', $options['challenge'])),
            'attestationObject' => Notifier::b64u(self::cbor(['fmt' => 'txt:none', 'attStmt' => [], 'authData' => $authData])), 'name' => 'Test phone'];
    }

    private function get(array &$a, array $options, string $origin = 'https://mail.example.com'): array
    {
        $a['count']++;
        $authData = hash('sha256', $options['rpId'], true) . chr(0x05) . pack('N', $a['count']);
        $client = $this->client('webauthn.get', $options['challenge'], $origin);
        openssl_sign($authData . hash('sha256', $client, true), $sig, $a['key'], OPENSSL_ALGO_SHA256);
        return ['id' => Notifier::b64u($a['id']), 'clientDataJSON' => Notifier::b64u($client), 'authenticatorData' => Notifier::b64u($authData), 'signature' => Notifier::b64u($sig)];
    }

    public function testPasskeyRegistersAndSignsIn(): void
    {
        $_SESSION = [];
        $uid = (new Auth($this->app))->createUser('agent@acme.test', 'Sam', 'correct horse battery');
        $user = ['id' => $uid, 'email' => 'agent@acme.test', 'name' => 'Sam'];
        $pk = new Passkeys($this->app);
        $this->assertSame('mail.example.com', $pk->rpId());

        $phone = $this->authenticator();
        $opts = $pk->registerOptions($user);
        $this->assertSame('required', $opts['authenticatorSelection']['userVerification'], 'biometrics or PIN, every time');
        $id = $pk->register($uid, $this->create($phone, $opts));
        $this->assertSame('Test phone', $pk->list($uid)[0]['name']);
        $this->assertSame($id, $pk->list($uid)[0]['id']);
        $this->assertStringNotContainsString('Test phone', (string) $this->app->db->value('SELECT name_enc FROM {passkeys}'));

        $this->assertSame($uid, $pk->login($this->get($phone, $pk->loginOptions())));
        $this->assertSame($uid, $pk->login($this->get($phone, $pk->loginOptions())));
        $this->assertNotNull($pk->list($uid)[0]['last_used_at']);

        $fail = function (callable $fn, string $code) {
            try {
                $fn();
                $this->fail("expected $code");
            } catch (HttpError $e) {
                $this->assertSame($code, $e->errorCode);
            }
        };
        $answer = $this->get($phone, $pk->loginOptions());
        $pk->login($answer);
        $fail(fn () => $pk->login($answer), 'expired_challenge'); // replay: the challenge is used up
        $fail(fn () => $pk->login($this->get($phone, $pk->loginOptions(), 'https://evil.example')), 'wrong_origin');
        $copy = $phone;
        $copy['count'] = 0;
        $fail(fn () => $pk->login($this->get($copy, $pk->loginOptions())), 'cloned_passkey');
        $stranger = $this->authenticator();
        $fail(fn () => $pk->login($this->get($stranger, $pk->loginOptions())), 'unknown_passkey');
        $forged = $this->get($phone, $o = $pk->loginOptions());
        $forged['signature'] = $this->get($stranger, $o)['signature'];
        $fail(fn () => $pk->login($forged), 'invalid_passkey');
        $forged = $this->get($phone, $pk->loginOptions());
        $forged['signature'] = Notifier::b64u(random_bytes(70));
        $fail(fn () => $pk->login($forged), 'invalid_passkey');
        $fail(fn () => $pk->register($uid, $this->create($this->authenticator(), $pk->registerOptions($user), 'evil.example')), 'wrong_rp');
        $fail(fn () => $pk->register($uid, $this->create($this->authenticator(), $pk->registerOptions($user), 'mail.example.com', 0x41)), 'not_verified');
        $fail(fn () => $pk->register($uid, $this->create($phone, $pk->registerOptions($user))), 'passkey_exists');

        $this->app->db->run('UPDATE {users} SET disabled = 1 WHERE id = ?', [$uid]);
        $fail(fn () => $pk->login($this->get($phone, $pk->loginOptions())), 'unknown_passkey');
    }

    public function testRsaPasskeyKeysConvert(): void
    {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048]);
        $d = openssl_pkey_get_details($key)['rsa'];
        $pem = Passkeys::coseToPem([1 => 3, 3 => -257, -1 => $d['n'], -2 => $d['e']]);
        openssl_sign('hello', $sig, $key, OPENSSL_ALGO_SHA256);
        $this->assertSame(1, openssl_verify('hello', $sig, $pem, OPENSSL_ALGO_SHA256));
    }
}
