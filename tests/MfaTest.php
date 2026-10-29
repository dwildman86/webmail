<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Admin;
use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Mfa;
use Webmail\Qr;

final class MfaTest extends TestCase
{
    private function failsWith(string $code, callable $fn): void
    {
        try {
            $fn();
            $this->fail("expected $code");
        } catch (HttpError $e) {
            $this->assertSame($code, $e->errorCode);
        }
    }

    /** Signs in with the password and sets up an authenticator app; returns [uid, secret, recovery codes, the step set up with]. */
    private function enrolled(): array
    {
        $_SESSION = [];
        $auth = new Auth($this->app);
        $uid = $auth->createUser('sam@acme.test', 'Sam', 'correct horse battery');
        $auth->login('sam@acme.test', 'correct horse battery', '203.0.113.1');
        $mfa = new Mfa($this->app);
        $setup = $mfa->beginSetup('sam@acme.test');
        $step = intdiv(time(), 30);
        $codes = $mfa->confirmSetup($uid, Mfa::code($setup['secret'], $step));
        return [$uid, $setup['secret'], $codes, $step];
    }

    public function testTotpMatchesTheRfcAndAuthenticatorAppsCanScanTheSetup(): void
    {
        // RFC 6238 appendix B, SHA-1, last six digits.
        $secret = Mfa::base32('12345678901234567890');
        foreach ([59 => '287082', 1111111109 => '081804', 1234567890 => '005924', 2000000000 => '279037'] as $t => $code) {
            $this->assertSame($code, Mfa::code($secret, intdiv($t, 30)));
        }
        $this->assertSame('12345678901234567890', Mfa::unbase32($secret));

        $_SESSION = [];
        $setup = (new Mfa($this->app))->beginSetup('sam@acme.test');
        $this->assertMatchesRegularExpression('/^[A-Z2-7]{32}$/', $setup['secret'], '160-bit secret');
        $this->assertStringStartsWith('otpauth://totp/', $setup['otpauth_uri']);
        $this->assertStringContainsString('secret=' . $setup['secret'], $setup['otpauth_uri']);
        $this->assertStringContainsString('issuer=', $setup['otpauth_uri']);
        $this->assertStringStartsWith('data:image/svg+xml;base64,', $setup['qr_code']);
        $this->assertStringContainsString('<path', base64_decode(substr($setup['qr_code'], 26)));
        $this->assertLessThanOrEqual(57, count(Qr::matrix($setup['otpauth_uri'])), 'version 10 or smaller: easy to scan');
    }

    public function testEveryoneNeedsASecondStepAndAPasswordAloneReadsNothing(): void
    {
        $_SESSION = [];
        $auth = new Auth($this->app);
        $uid = $auth->createUser('sam@acme.test', 'Sam', 'correct horse battery');
        $auth->login('sam@acme.test', 'correct horse battery', '203.0.113.1');
        $this->assertNull($auth->user());
        $this->assertSame('enrol', $auth->pending()['stage']);

        // Someone signed in before two-step verification was required is sent to set it up.
        $auth->begin($uid);
        $this->assertNull($auth->user());
        $this->assertSame('enrol', $auth->pending()['stage']);

        $mfa = new Mfa($this->app);
        $setup = $mfa->beginSetup('sam@acme.test');
        $this->failsWith('invalid_code', fn () => $mfa->confirmSetup($uid, '000000'));
        $codes = $mfa->confirmSetup($uid, Mfa::code($setup['secret'], intdiv(time(), 30)));
        $this->assertCount(10, $codes);
        $this->assertMatchesRegularExpression('/^[a-z2-7]{5}-[a-z2-7]{5}$/', $codes[0]);
        $this->assertCount(10, array_unique($codes));
        $auth->begin($uid);
        $this->assertSame($uid, $auth->user()['id']);

        // Stored safely: the secret encrypted, recovery codes only as keyed hashes.
        $row = $this->app->db->one('SELECT totp_secret_enc FROM {users} WHERE id = ?', [$uid]);
        $this->assertStringNotContainsString($setup['secret'], $row['totp_secret_enc']);
        $hashes = implode('', array_column($this->app->db->all('SELECT code_bidx FROM {mfa_recovery_codes}'), 'code_bidx'));
        $this->assertStringNotContainsString(str_replace('-', '', $codes[0]), $hashes);
    }

    public function testCodesWorkOnceAndGuessingIsCutOff(): void
    {
        [$uid, $secret, $codes, $now] = $this->enrolled();
        $mfa = new Mfa($this->app);
        $auth = new Auth($this->app);
        $auth->login('sam@acme.test', 'correct horse battery', '203.0.113.1');
        $this->assertSame('verify', $auth->pending()['stage']);

        // The code used to set up can't be used again; the next one can, once. (The step it was set up with, not the
        // clock now: a 30-second boundary can pass in between.)
        $this->failsWith('invalid_code', fn () => $mfa->verify($uid, Mfa::code($secret, $now)));
        $this->assertSame('totp', $mfa->verify($uid, Mfa::code($secret, $now + 1)));
        $this->failsWith('invalid_code', fn () => $mfa->verify($uid, Mfa::code($secret, $now + 1)));
        $this->failsWith('invalid_code', fn () => $mfa->verify($uid, Mfa::code($secret, $now + 5)));

        // Recovery codes: any spacing or case, each once.
        $this->assertSame('recovery', $mfa->verify($uid, strtoupper(str_replace('-', ' ', $codes[0]))));
        $this->failsWith('invalid_code', fn () => $mfa->verify($uid, $codes[0]));
        $this->assertSame(9, $mfa->status($uid)['recovery_codes_left']);

        for ($i = 0; $i < 10; $i++) {
            try {
                $mfa->verify($uid, '123456');
            } catch (HttpError) {
            }
        }
        $this->failsWith('rate_limited', fn () => $mfa->verify($uid, $codes[1]));
    }

    public function testAResetSignsThePersonOutAndAPasswordChangeSignsOutOtherSessions(): void
    {
        [$uid, $secret] = $this->enrolled();
        $auth = new Auth($this->app);
        $auth->begin($uid);
        $this->assertNotNull($auth->user());
        $session = $_SESSION;

        (new Admin($this->app))->changePassword($uid, 'correct horse battery', 'a brand new password');
        $this->assertNotNull($auth->user(), 'the session that changed it carries on');
        $_SESSION = $session;
        $this->assertNull($auth->user(), 'any other session is signed out');

        $auth->begin($uid);
        (new Mfa($this->app))->reset($uid);
        $this->assertNull($auth->user(), 'a reset signs them out');
        $this->assertSame(['totp' => false, 'totp_since' => null, 'passkeys' => 0, 'recovery_codes_left' => 0], (new Mfa($this->app))->status($uid));
        $auth->login('sam@acme.test', 'a brand new password', '203.0.113.1');
        $this->assertSame('enrol', $auth->pending()['stage'], 'and they set up a new second step at their next sign-in');
    }

    public function testThePendingStepExpiresAndNeedsTheRightCodeWhileSettingUp(): void
    {
        $_SESSION = [];
        $auth = new Auth($this->app);
        $uid = $auth->createUser('sam@acme.test', 'Sam', 'correct horse battery');
        $auth->login('sam@acme.test', 'correct horse battery', '203.0.113.1');
        $_SESSION['pending_at'] = time() - 601;
        $this->assertNull($auth->pending(), 'ten minutes to finish signing in');

        $mfa = new Mfa($this->app);
        $this->failsWith('setup_expired', fn () => $mfa->confirmSetup($uid, '123456'));
        $setup = $mfa->beginSetup('sam@acme.test');
        $_SESSION['totp_setup']['at'] = time() - 901;
        $this->failsWith('setup_expired', fn () => $mfa->confirmSetup($uid, Mfa::code($setup['secret'], intdiv(time(), 30))));
    }
}
