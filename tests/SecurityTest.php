<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\App;
use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Mfa;
use Webmail\Security;
use Webmail\Sessions;

final class SecurityTest extends TestCase
{
    private Auth $auth;
    private int $admin;
    private int $sam;

    protected function setUp(): void
    {
        parent::setUp();
        $_SESSION = [];
        $_SERVER['REMOTE_ADDR'] = '203.0.113.10';
        $this->auth = new Auth($this->app);
        $this->admin = $this->auth->createUser('ada@acme.test', 'Ada Admin', 'correct horse battery', 'admin');
        $this->sam = $this->auth->createUser('sam@acme.test', 'Sam', 'correct horse battery');
        // Both have an authenticator app (two-step verification is required).
        $this->app->db->run('UPDATE {users} SET totp_secret_enc = ?, totp_enabled_at = ?', [$this->app->crypto->encrypt('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'users.totp_secret'), App::now()]);
    }

    protected function tearDown(): void
    {
        $_SESSION = [];
        $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
        unset($_SERVER['HTTP_USER_AGENT'], $_SERVER['HTTP_X_WEBMAIL_APP']);
        parent::tearDown();
    }

    private function fails(callable $fn, int $status, string $code): HttpError
    {
        try {
            $fn();
        } catch (HttpError $e) {
            $this->assertSame([$status, $code], [$e->status, $e->errorCode], $e->getMessage());
            return $e;
        }
        $this->fail("no error, expected $status $code");
    }

    private function me(int $id): array
    {
        return ['id' => $id, 'role' => $id === $this->admin ? 'admin' : 'user', 'email' => '', 'name' => ''];
    }

    private function addPasskey(int $userId): void
    {
        $c = $this->app->crypto;
        $raw = random_bytes(16);
        $this->app->db->run('INSERT INTO {passkeys} (user_id, credential_bidx, credential_id_enc, public_key_enc, created_at) VALUES (?, ?, ?, ?, ?)',
            [$userId, $c->blindIndex($raw, 'passkeys.credential'), $c->encrypt(base64_encode($raw), 'passkeys.credential_id'), $c->encrypt('-', 'passkeys.public_key'), App::now()]);
    }

    public function testRanges(): void
    {
        $this->assertSame(['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'], Security::ranges("203.0.113.0/24 # office\n2001:db8::/32, 198.51.100.7\n203.0.113.0/24"));
        foreach (['10.0.0.0/33', 'office', '300.1.1.1', '2001:db8::/129'] as $bad) {
            $this->fails(fn () => Security::ranges($bad), 422, 'bad_range');
        }
        $r = ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7', '10.0.0.0/8'];
        foreach (['203.0.113.200' => true, '203.0.114.1' => false, '198.51.100.7' => true, '198.51.100.8' => false, '10.200.3.4' => true,
            '2001:db8:1::5' => true, '2001:db9::1' => false, '::ffff:203.0.113.9' => true, 'nonsense' => false] as $ip => $in) {
            $this->assertSame($in, Security::inRanges($ip, $r), $ip);
        }
        $this->assertTrue(Security::inRanges('8.8.8.8', ['0.0.0.0/0']));
    }

    public function testTrustedNetworks(): void
    {
        $s = new Security($this->app);
        // Sam may only sign in from the office.
        $s->setUserRanges($this->sam, '198.51.100.0/24');
        $e = $this->fails(fn () => $this->auth->login('sam@acme.test', 'correct horse battery', '203.0.113.10'), 403, 'network_not_allowed');
        $this->assertStringContainsString('203.0.113.10', $e->getMessage());
        $this->assertSame($this->sam, $this->auth->login('sam@acme.test', 'correct horse battery', '198.51.100.20'));

        // Signed in at the office, then off the VPN: signed out at the next request, with the reason.
        $_SERVER['REMOTE_ADDR'] = '198.51.100.20';
        $this->auth->begin($this->sam);
        $this->assertSame($this->sam, $this->auth->user()['id']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.10';
        $this->fails(fn () => $this->auth->user(), 401, 'network_not_allowed');
        $this->assertNull($this->auth->user(), 'the session ended');

        // Administration only from the office: elsewhere, Ada is an ordinary user.
        $_SERVER['REMOTE_ADDR'] = '198.51.100.5';
        $s->save($this->me($this->admin), ['admin_ips' => '198.51.100.0/24'], '198.51.100.5');
        $this->auth->begin($this->admin);
        $this->assertSame('admin', $this->auth->requireAdmin()['role']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.10';
        $u = $this->auth->user();
        $this->assertSame(['user', true], [$u['role'], $u['admin_elsewhere']]);
        $this->fails(fn () => $this->auth->requireAdmin(), 403, 'admin_network');

        // An administrator can't lock themselves out.
        $this->fails(fn () => $s->save($this->me($this->admin), ['admin_ips' => '192.0.2.0/24'], '203.0.113.10'), 422, 'locks_you_out');
        $this->fails(fn () => $s->save($this->me($this->admin), ['user_ips' => '192.0.2.0/24', 'admin_ips' => ''], '203.0.113.10'), 422, 'locks_you_out');
        // Everyone from two networks; a person's own ranges replace those.
        $s->save($this->me($this->admin), ['admin_ips' => '', 'user_ips' => "203.0.113.0/24\n198.51.100.0/24"], '203.0.113.10');
        $this->fails(fn () => $s->checkNetwork($this->admin, '192.0.2.1'), 403, 'network_not_allowed');
        $s->checkNetwork($this->admin, '203.0.113.99');
        $s->setUserRanges($this->sam, '192.0.2.0/24');
        $s->checkNetwork($this->sam, '192.0.2.1');
        $this->fails(fn () => $s->checkNetwork($this->sam, '203.0.113.99'), 403, 'network_not_allowed');
        // The way back in (security-reset.php, on the server) clears the policy.
        $this->app->db->run("DELETE FROM {meta} WHERE k = 'security_policy'");
        $this->assertSame([], $s->policy()['user_ips']);
    }

    public function testPasskeysOnly(): void
    {
        $s = new Security($this->app);
        // Ada needs a passkey herself first.
        $this->fails(fn () => $s->save($this->me($this->admin), ['passkeys_only' => 'everyone'], '203.0.113.10'), 422, 'no_passkey');
        $this->addPasskey($this->admin);
        $summary = $s->save($this->me($this->admin), ['passkeys_only' => 'everyone'], '203.0.113.10');
        $this->assertSame(['everyone', ['sam@acme.test']], [$summary['passkeys_only'], array_column($summary['without_passkey'], 'email')]);

        // Ada has a passkey: her password doesn't sign her in.
        $this->fails(fn () => $this->auth->login('ada@acme.test', 'correct horse battery', '203.0.113.10'), 403, 'passkey_required');
        // Sam has none yet: the password (and his second step) once, then he must add one before anything else.
        $_SESSION = [];
        $this->auth->login('sam@acme.test', 'correct horse battery', '203.0.113.10');
        $this->auth->begin($this->sam);
        $this->assertTrue($this->auth->user()['passkey_setup']);
        $this->addPasskey($this->sam);
        $this->assertArrayNotHasKey('passkey_setup', $this->auth->user());
        $this->fails(fn () => $this->auth->login('sam@acme.test', 'correct horse battery', '203.0.113.10'), 403, 'passkey_required');
        // Sensitive changes are confirmed with the passkey, not the password.
        $this->fails(fn () => $this->auth->confirm($this->sam, ['password' => 'correct horse battery']), 422, 'passkey_required');

        // Administrators only: Sam's password works again; Ada's doesn't.
        $s->save($this->me($this->admin), ['passkeys_only' => 'admins'], '203.0.113.10');
        $this->assertSame($this->sam, $this->auth->login('sam@acme.test', 'correct horse battery', '203.0.113.10'));
        $this->auth->confirm($this->sam, ['password' => 'correct horse battery']);
        $this->fails(fn () => $this->auth->login('ada@acme.test', 'correct horse battery', '203.0.113.10'), 403, 'passkey_required');
        // A lost passkey: an administrator resets Sam's two-step verification, and he can add a new one.
        (new Mfa($this->app))->reset($this->sam);
        $this->assertFalse($s->hasPasskey($this->sam));
    }

    public function testSessionsAndSigningADeviceOut(): void
    {
        $sessions = new Sessions($this->app, 30 * 86400);
        $s = new Security($this->app);
        $make = function (string $id, string $ua, bool $app, string $ip) use ($sessions) {
            $_SESSION = ['uid' => $this->sam, 'sv' => 0];
            $_SERVER['HTTP_USER_AGENT'] = $ua;
            $_SERVER['HTTP_X_WEBMAIL_APP'] = $app ? '1' : '0';
            $_SERVER['REMOTE_ADDR'] = $ip;
            $sessions->write($id, 'x');
        };
        $make('phone-session-id', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', true, '198.51.100.20');
        $make('laptop-session-id', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0', false, '203.0.113.10');
        $sessions->write('laptop-session-id', 'y'); // used again: the same session
        // Not signed in yet (only the password): not listed.
        $_SESSION = ['pending_uid' => $this->sam];
        $sessions->write('pending-session-id', 'z');
        // A push subscription made from the phone.
        $this->app->db->run('INSERT INTO {push_subscriptions} (user_id, endpoint_bidx, subscription_enc, created_at, session_hash) VALUES (?, ?, ?, ?, ?)',
            [$this->sam, random_bytes(16), 'x', App::now(), hash('sha256', 'phone-session-id')]);

        $list = $s->sessions($this->sam, 'laptop-session-id');
        $this->assertSame([['Edge on Windows', '203.0.113.10', true], ['Installed app on iPhone', '198.51.100.20', false]],
            array_map(fn ($x) => [$x['device'], $x['ip'], $x['current']], $list));
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $list[1]['id']);
        $this->assertSame([], $s->sessions($this->admin), "nobody else's");

        // Sign the phone out: its session and its notifications end.
        $this->fails(fn () => $s->revoke($this->admin, $list[1]['id']), 404, 'not_found');
        $this->assertSame(1, $s->revoke($this->sam, $list[1]['id']));
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {push_subscriptions}'));
        $this->assertSame('', $sessions->read('phone-session-id'));
        $this->assertSame(['Edge on Windows'], array_column($s->sessions($this->sam), 'device'));
        // Everywhere else: this one stays.
        $make('tablet-session-id', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Safari/604.1', false, '198.51.100.21');
        $this->assertSame(1, $s->revoke($this->sam, 'others', 'laptop-session-id'));
        $this->assertSame(['Edge on Windows'], array_column($s->sessions($this->sam), 'device'));
        // Everywhere: sessions from before 1.14.0 end too (the user's session version moves on).
        $this->assertSame(1, $s->revoke($this->sam, 'all'));
        $this->assertSame(1, (int) $this->app->db->value('SELECT session_version FROM {users} WHERE id = ?', [$this->sam]));

        $this->assertSame('Firefox on Linux', Security::device('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'));
        $this->assertSame('Safari on Mac', Security::device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'));
        $this->assertSame('Chrome on Android', Security::device('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'));
    }
}
