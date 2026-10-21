<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Two-step verification, which everyone must use: after their password, people confirm a code from an authenticator
 * app (TOTP, RFC 6238) or use a passkey. Ten one-time recovery codes cover a lost phone. Someone without either is
 * asked to set one up before they can see any mail.
 *
 * The authenticator secret is stored encrypted; recovery codes only as keyed hashes. Each code works once: a TOTP code
 * can't be replayed within its window, and a recovery code is deleted when used.
 */
final class Mfa
{
    private const DIGITS = 6;
    private const PERIOD = 30;
    private const RECOVERY_CODES = 10;
    private const MAX_ATTEMPTS = 10;
    private const WINDOW_MINUTES = 15;

    public function __construct(private App $app)
    {
    }

    /** Whether the person has a second step: an authenticator app or a passkey. */
    public function configured(int $userId): bool
    {
        return (bool) $this->app->db->value(
            'SELECT 1 FROM {users} u WHERE u.id = ? AND (u.totp_enabled_at IS NOT NULL OR EXISTS (SELECT 1 FROM {passkeys} p WHERE p.user_id = u.id))',
            [$userId],
        );
    }

    /** What the person can use for their second step, and how many recovery codes are left. */
    public function status(int $userId): array
    {
        $db = $this->app->db;
        $totp = $db->value('SELECT totp_enabled_at FROM {users} WHERE id = ?', [$userId]);
        return [
            'totp' => $totp !== null,
            'totp_since' => $totp ? $totp . 'Z' : null,
            'passkeys' => (int) $db->value('SELECT COUNT(*) FROM {passkeys} WHERE user_id = ?', [$userId]),
            'recovery_codes_left' => (int) $db->value('SELECT COUNT(*) FROM {mfa_recovery_codes} WHERE user_id = ?', [$userId]),
        ];
    }

    // -------------------------------------------------------------------------------------------- authenticator app

    /** A new secret to scan, kept in the session until the person proves their app has it. */
    public function beginSetup(string $email): array
    {
        $secret = self::base32(random_bytes(20));
        $_SESSION['totp_setup'] = ['secret' => $secret, 'at' => time()];
        $issuer = (string) $this->app->config->get('app_name', 'Webmail');
        $uri = 'otpauth://totp/' . rawurlencode($issuer) . ':' . rawurlencode($email) . '?' . http_build_query(
            ['secret' => $secret, 'issuer' => $issuer, 'algorithm' => 'SHA1', 'digits' => self::DIGITS, 'period' => self::PERIOD], '', '&', PHP_QUERY_RFC3986,
        );
        return ['secret' => $secret, 'otpauth_uri' => $uri, 'qr_code' => Qr::svgDataUrl($uri)];
    }

    /**
     * Turn the authenticator app on once a code from it checks out. Returns new recovery codes if the person had none
     * (shown once), else an empty list.
     */
    public function confirmSetup(int $userId, string $code): array
    {
        $setup = $_SESSION['totp_setup'] ?? null;
        if (!$setup || time() - $setup['at'] > 900) {
            throw new HttpError(422, 'The setup expired. Start again.', 'setup_expired');
        }
        $this->limit($userId);
        $step = self::matchStep($setup['secret'], $code, null);
        if ($step === null) {
            $this->failed($userId);
            throw new HttpError(422, "That code didn't match. Check your phone's time is set automatically, then try the newest code.", 'invalid_code');
        }
        unset($_SESSION['totp_setup']);
        $this->app->db->run('UPDATE {users} SET totp_secret_enc = ?, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?',
            [$this->app->crypto->encrypt($setup['secret'], 'users.totp_secret'), App::now(), $step, $userId]);
        return $this->status($userId)['recovery_codes_left'] === 0 ? $this->newRecoveryCodes($userId) : [];
    }

    /** Check a second-step code: from the authenticator app, or a recovery code (used up). Returns which it was. */
    public function verify(int $userId, string $code): string
    {
        $this->limit($userId);
        $code = strtolower(preg_replace('/[\s-]+/', '', $code));
        $db = $this->app->db;
        if (preg_match('/^\d{6}$/', $code)) {
            $row = $db->one('SELECT totp_secret_enc, totp_last_step FROM {users} WHERE id = ? AND totp_enabled_at IS NOT NULL', [$userId]);
            if ($row) {
                $secret = $this->app->crypto->decrypt($row['totp_secret_enc'], 'users.totp_secret');
                $step = self::matchStep((string) $secret, $code, $row['totp_last_step'] === null ? null : (int) $row['totp_last_step']);
                // Only one sign-in per code: the step is recorded, and the update fails if another request got there first.
                if ($step !== null && $db->run('UPDATE {users} SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
                    [$step, $userId, $step])->rowCount() === 1) {
                    return 'totp';
                }
            }
        } elseif (preg_match('/^[a-z2-7]{10}$/', $code)) {
            if ($db->run('DELETE FROM {mfa_recovery_codes} WHERE user_id = ? AND code_bidx = ?', [$userId, $this->recoveryIndex($code)])->rowCount() === 1) {
                return 'recovery';
            }
        }
        $this->failed($userId);
        throw new HttpError(422, "That code didn't work. Use the newest code from your authenticator app, or one of your recovery codes.", 'invalid_code');
    }

    // -------------------------------------------------------------------------------------------- recovery codes

    /** Replace the person's recovery codes with ten new ones, returned once in the form "abcde-fghij". */
    public function newRecoveryCodes(int $userId): array
    {
        $db = $this->app->db;
        $codes = [];
        $db->tx(function (Db $db) use ($userId, &$codes) {
            $db->run('DELETE FROM {mfa_recovery_codes} WHERE user_id = ?', [$userId]);
            for ($i = 0; $i < self::RECOVERY_CODES; $i++) {
                $code = strtolower(substr(self::base32(random_bytes(7)), 0, 10));
                $db->run('INSERT INTO {mfa_recovery_codes} (user_id, code_bidx, created_at) VALUES (?, ?, ?)', [$userId, $this->recoveryIndex($code), App::now()]);
                $codes[] = substr($code, 0, 5) . '-' . substr($code, 5);
            }
        });
        return $codes;
    }

    private function recoveryIndex(string $code): string
    {
        return $this->app->crypto->blindIndex($code, 'mfa.recovery');
    }

    // -------------------------------------------------------------------------------------------- reset

    /**
     * For an administrator when someone loses their phone: turns off the authenticator app, removes their passkeys
     * and recovery codes, and signs them out everywhere. They set up a new second step when they next sign in.
     */
    public function reset(int $userId): void
    {
        $db = $this->app->db;
        $db->tx(function (Db $db) use ($userId) {
            $db->run('UPDATE {users} SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, session_version = session_version + 1 WHERE id = ?', [$userId]);
            $db->run('DELETE FROM {passkeys} WHERE user_id = ?', [$userId]);
            $db->run('DELETE FROM {mfa_recovery_codes} WHERE user_id = ?', [$userId]);
        });
    }

    // -------------------------------------------------------------------------------------------- guessing limits

    private function limitKey(int $userId): string
    {
        return $this->app->crypto->blindIndex('mfa:' . $userId, 'login');
    }

    /** Ten wrong codes in 15 minutes and the account waits: a 6-digit code can't be guessed that slowly. */
    private function limit(int $userId): void
    {
        $since = gmdate('Y-m-d H:i:s', time() - self::WINDOW_MINUTES * 60);
        if ((int) $this->app->db->value('SELECT COUNT(*) FROM {login_attempts} WHERE key_bidx = ? AND at > ?', [$this->limitKey($userId), $since]) >= self::MAX_ATTEMPTS) {
            throw new HttpError(429, 'Too many wrong codes. Wait 15 minutes and try again.', 'rate_limited');
        }
    }

    private function failed(int $userId): void
    {
        $this->app->db->run('INSERT INTO {login_attempts} (key_bidx, at) VALUES (?, ?)', [$this->limitKey($userId), App::now()]);
    }

    // -------------------------------------------------------------------------------------------- TOTP

    /** The 6-digit code for a 30-second step (RFC 6238 with HMAC-SHA-1, what every authenticator app uses). */
    public static function code(string $secretBase32, int $step): string
    {
        $mac = hash_hmac('sha1', pack('J', $step), self::unbase32($secretBase32), true);
        $offset = ord($mac[19]) & 0x0f;
        $n = ((ord($mac[$offset]) & 0x7f) << 24) | (ord($mac[$offset + 1]) << 16) | (ord($mac[$offset + 2]) << 8) | ord($mac[$offset + 3]);
        return str_pad((string) ($n % 10 ** self::DIGITS), self::DIGITS, '0', STR_PAD_LEFT);
    }

    /** The step a code belongs to, allowing one step either side for clock drift, and never one already used. */
    private static function matchStep(string $secret, string $code, ?int $lastUsed, ?int $now = null): ?int
    {
        $code = preg_replace('/\s+/', '', $code);
        if (!preg_match('/^\d{6}$/', $code)) {
            return null;
        }
        $current = intdiv($now ?? time(), self::PERIOD);
        foreach ([$current, $current - 1, $current + 1] as $step) {
            if (($lastUsed === null || $step > $lastUsed) && hash_equals(self::code($secret, $step), $code)) {
                return $step;
            }
        }
        return null;
    }

    public static function base32(string $bytes): string
    {
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        $bits = '';
        foreach (str_split($bytes) as $c) {
            $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= $alphabet[bindec(str_pad($chunk, 5, '0'))];
        }
        return $out;
    }

    public static function unbase32(string $text): string
    {
        $bits = '';
        foreach (str_split(strtoupper(rtrim($text, '='))) as $c) {
            $v = strpos('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', $c);
            if ($v === false) {
                throw new \InvalidArgumentException('Not base32');
            }
            $bits .= str_pad(decbin($v), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr(bindec($byte));
            }
        }
        return $out;
    }
}
