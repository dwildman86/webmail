<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Sign-in security an organisation sets (Settings → Security, administrators):
 *
 * - Trusted networks: administration only from the office or VPN (an administrator elsewhere can read their mail but
 *   not change settings or users); everyone only from some networks; or one person only from theirs.
 * - Passkeys only: no passwords for signing in, for administrators or for everyone. Someone without a passkey yet signs
 *   in with their password once and is asked to add one before anything else; after that, only the passkey works. A
 *   lost passkey: an administrator resets the person's two-step verification and they add a new one the same way.
 *
 * And the sessions: everywhere each person is signed in (browser, installed app), with a way to sign one out.
 *
 * Locked out (the office's address changed, say)? On the server: php security-reset.php turns both off.
 */
final class Security
{
    public const PASSKEYS = ['off', 'admins', 'everyone'];
    private const MAX_RANGES = 50;

    public function __construct(private App $app)
    {
    }

    // ------------------------------------------------------------------------------------------------ the policy

    /** ['admin_ips' => [...], 'user_ips' => [...], 'passkeys_only' => off|admins|everyone] */
    public function policy(): array
    {
        $raw = $this->app->db->value("SELECT v FROM {meta} WHERE k = 'security_policy'");
        $p = $raw ? (json_decode((string) $raw, true) ?: []) : [];
        return ['admin_ips' => array_values((array) ($p['admin_ips'] ?? [])), 'user_ips' => array_values((array) ($p['user_ips'] ?? [])),
            'passkeys_only' => in_array($p['passkeys_only'] ?? null, self::PASSKEYS, true) ? $p['passkeys_only'] : 'off'];
    }

    /**
     * Save the policy (an administrator). Refused if it would lock that administrator out: their own address must be in
     * the ranges they set, and passkeys only needs them to have a passkey (and the webmail on https://).
     */
    public function save(array $me, array $in, string $ip): array
    {
        $p = $this->policy();
        foreach (['admin_ips', 'user_ips'] as $k) {
            if (array_key_exists($k, $in)) {
                $p[$k] = self::ranges($in[$k]);
            }
        }
        if (isset($in['passkeys_only'])) {
            if (!in_array($in['passkeys_only'], self::PASSKEYS, true)) {
                throw new HttpError(422, 'Choose off, administrators or everyone', 'bad_policy');
            }
            $p['passkeys_only'] = $in['passkeys_only'];
        }
        if ($p['admin_ips'] && !self::inRanges($ip, $p['admin_ips'])) {
            throw new HttpError(422, "Your address now ($ip) isn't in the administrators' ranges: you'd lose access to these settings. Add it first.", 'locks_you_out');
        }
        $own = $this->userRanges((int) $me['id']);
        if ($p['user_ips'] && !$own && !self::inRanges($ip, $p['user_ips'])) {
            throw new HttpError(422, "Your address now ($ip) isn't in the ranges for everyone: you'd be signed out. Add it first.", 'locks_you_out');
        }
        if ($p['passkeys_only'] !== 'off') {
            if (!str_starts_with($this->app->baseUrl(), 'https://') && !preg_match('#^http://(localhost|127\.0\.0\.1)(:|/|$)#', $this->app->baseUrl())) {
                throw new HttpError(422, 'Passkeys need the webmail on https://. Set that up first.', 'needs_https');
            }
            if (!(int) $this->app->db->value('SELECT COUNT(*) FROM {passkeys} WHERE user_id = ?', [$me['id']])) {
                throw new HttpError(422, 'Add a passkey for yourself first (Settings → Sign-in & alerts), so you can still sign in.', 'no_passkey');
            }
        }
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('security_policy', ?)", [json_encode($p)]);
        return $this->summary();
    }

    /** The policy, with what administrators need to see beside it. */
    public function summary(): array
    {
        $p = $this->policy();
        $without = [];
        foreach ($this->app->db->all('SELECT u.id, u.email_enc, u.name_enc, u.role FROM {users} u LEFT JOIN {passkeys} p ON p.user_id = u.id
            WHERE u.disabled = 0 GROUP BY u.id HAVING COUNT(p.id) = 0') as $u) {
            $without[] = ['id' => (int) $u['id'], 'email' => (string) $this->app->crypto->decrypt($u['email_enc'], 'users.email'),
                'name' => (string) ($this->app->crypto->decrypt($u['name_enc'], 'users.name') ?? ''), 'role' => $u['role']];
        }
        return $p + ['your_ip' => Http::ip(), 'without_passkey' => $without];
    }

    /** "office", "1.2.3.4", "10.0.0.0/8", "2001:db8::/32", one a line (or a list): checked and tidied; # comments allowed. */
    public static function ranges(mixed $in): array
    {
        $lines = is_array($in) ? $in : preg_split('/[\r\n,]+/', (string) $in);
        $out = [];
        foreach ($lines as $line) {
            // "203.0.113.0/24  # office": the comment goes.
            foreach (preg_split('/\s+/', trim(preg_replace('/#.*$/', '', (string) $line))) as $r) {
                if ($r !== '') {
                    $out[] = $r;
                }
            }
        }
        $checked = [];
        foreach ($out as $r) {
            if (!self::validRange($r)) {
                throw new HttpError(422, "\"$r\" isn't an IP address or range (like 203.0.113.7, 203.0.113.0/24 or 2001:db8::/32)", 'bad_range');
            }
            $checked[] = $r;
        }
        $out = array_values(array_unique($checked));
        if (count($out) > self::MAX_RANGES) {
            throw new HttpError(422, 'At most ' . self::MAX_RANGES . ' addresses or ranges', 'too_many_ranges');
        }
        return $out;
    }

    private static function validRange(string $r): bool
    {
        [$addr, $bits] = array_pad(explode('/', $r, 2), 2, null);
        $bin = @inet_pton($addr);
        if ($bin === false) {
            return false;
        }
        return $bits === null || (ctype_digit($bits) && (int) $bits <= strlen($bin) * 8);
    }

    /** Is an address in one of the ranges? (IPv4 and IPv6; an IPv4 address written as ::ffff:1.2.3.4 counts as IPv4.) */
    public static function inRanges(string $ip, array $ranges): bool
    {
        if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $m)) {
            $ip = $m[1];
        }
        $bin = @inet_pton($ip);
        if ($bin === false) {
            return false;
        }
        foreach ($ranges as $r) {
            [$addr, $bits] = array_pad(explode('/', $r, 2), 2, null);
            $net = @inet_pton($addr);
            if ($net === false || strlen($net) !== strlen($bin)) {
                continue;
            }
            $bits = $bits === null ? strlen($bin) * 8 : (int) $bits;
            $bytes = intdiv($bits, 8);
            if (substr($bin, 0, $bytes) !== substr($net, 0, $bytes)) {
                continue;
            }
            $rest = $bits % 8;
            if ($rest === 0 || (ord($bin[$bytes]) >> (8 - $rest)) === (ord($net[$bytes]) >> (8 - $rest))) {
                return true;
            }
        }
        return false;
    }

    /** One person's own ranges (empty: the policy's ranges for everyone apply). */
    public function userRanges(int $userId): array
    {
        $enc = $this->app->db->value('SELECT allowed_ips_enc FROM {users} WHERE id = ?', [$userId]);
        return $enc ? ($this->app->crypto->decryptJson((string) $enc, 'users.allowed_ips') ?? []) : [];
    }

    public function setUserRanges(int $userId, mixed $in): array
    {
        $ranges = self::ranges($in);
        $this->app->db->run('UPDATE {users} SET allowed_ips_enc = ? WHERE id = ?', [$ranges ? $this->app->crypto->encryptJson($ranges, 'users.allowed_ips') : null, $userId]);
        return $ranges;
    }

    /** Throws when this person can't use the webmail from here: their own ranges, or else the ranges for everyone. */
    public function checkNetwork(int $userId, string $ip): void
    {
        $ranges = $this->userRanges($userId) ?: $this->policy()['user_ips'];
        if ($ranges && !self::inRanges($ip, $ranges)) {
            throw new HttpError(403, "You can't sign in from this network ($ip). Use your office network or VPN, or ask your administrator.", 'network_not_allowed');
        }
    }

    /** May an administrator administer from here? (Elsewhere they're an ordinary user.) */
    public function adminHere(string $ip): bool
    {
        $ranges = $this->policy()['admin_ips'];
        return !$ranges || self::inRanges($ip, $ranges);
    }

    /** Must this person sign in with a passkey (no password)? */
    public function passkeysOnly(string $role): bool
    {
        $p = $this->policy()['passkeys_only'];
        return $p === 'everyone' || ($p === 'admins' && $role === 'admin');
    }

    public function hasPasskey(int $userId): bool
    {
        return (bool) $this->app->db->value('SELECT 1 FROM {passkeys} WHERE user_id = ? LIMIT 1', [$userId]);
    }

    // ------------------------------------------------------------------------------------------------ sessions

    /** Everywhere someone is signed in, newest first; $current is this request's session (marked "this device"). */
    public function sessions(int $userId, ?string $currentId = null): array
    {
        $cutoff = time() - 30 * 86400;
        $current = $currentId ? hash('sha256', $currentId) : null;
        $out = [];
        foreach ($this->app->db->all('SELECT id_hash, handle, ip, agent_enc, app, created_at, updated_at FROM {sessions} WHERE user_id = ? AND updated_at >= ? ORDER BY updated_at DESC',
            [$userId, $cutoff]) as $r) {
            $agent = (string) ($this->app->crypto->decrypt($r['agent_enc'], 'sessions.agent') ?? '');
            $out[] = ['id' => $r['handle'], 'device' => self::device($agent, (bool) $r['app']), 'app' => (bool) $r['app'], 'ip' => $r['ip'],
                'signed_in_at' => $r['created_at'] ? gmdate('c', (int) $r['created_at']) : null, 'last_active_at' => gmdate('c', (int) $r['updated_at']),
                'current' => $current !== null && hash_equals($r['id_hash'], $current)];
        }
        // This device first, then the most recently used.
        usort($out, fn ($a, $b) => [$b['current'], $b['last_active_at']] <=> [$a['current'], $a['last_active_at']]);
        return $out;
    }

    /**
     * Sign out one session (its id from sessions()), or all but this one ($handle 'others'), or all ('all'). Their
     * notifications stop too. Returns how many.
     */
    public function revoke(int $userId, string $handle, ?string $currentId = null): int
    {
        $current = $currentId ? hash('sha256', $currentId) : '';
        $where = match ($handle) {
            'all' => ['user_id = ?', [$userId]],
            'others' => ['user_id = ? AND id_hash <> ?', [$userId, $current]],
            default => ['user_id = ? AND handle = ?', [$userId, $handle]],
        };
        $hashes = array_column($this->app->db->all("SELECT id_hash FROM {sessions} WHERE {$where[0]}", $where[1]), 'id_hash');
        if (!$hashes && !in_array($handle, ['all', 'others'], true)) {
            throw new HttpError(404, 'That session has ended already', 'not_found');
        }
        foreach ($hashes as $h) {
            $this->app->db->run('DELETE FROM {push_subscriptions} WHERE session_hash = ?', [$h]);
            $this->app->db->run('DELETE FROM {sessions} WHERE id_hash = ?', [$h]);
        }
        if ($handle === 'all') {
            // Sessions from before 1.14.0 (not in the list) end too.
            $this->app->db->run('UPDATE {users} SET session_version = session_version + 1 WHERE id = ?', [$userId]);
        }
        return count($hashes);
    }

    /** "Chrome on Windows", "Installed app on iPhone", "Safari on Mac": from the browser's user agent. */
    public static function device(string $ua, bool $app = false): string
    {
        $os = match (true) {
            str_contains($ua, 'iPhone') => 'iPhone',
            str_contains($ua, 'iPad') => 'iPad',
            str_contains($ua, 'Android') => 'Android',
            str_contains($ua, 'CrOS') => 'Chromebook',
            str_contains($ua, 'Macintosh') || str_contains($ua, 'Mac OS X') => 'Mac',
            str_contains($ua, 'Windows') => 'Windows',
            str_contains($ua, 'Linux') => 'Linux',
            default => '',
        };
        if ($app) {
            return 'Installed app' . ($os ? " on $os" : '');
        }
        $browser = match (true) {
            str_contains($ua, 'Edg/') || str_contains($ua, 'EdgiOS') || str_contains($ua, 'EdgA/') => 'Edge',
            str_contains($ua, 'SamsungBrowser') => 'Samsung Internet',
            str_contains($ua, 'OPR/') || str_contains($ua, 'Opera') => 'Opera',
            str_contains($ua, 'Firefox/') || str_contains($ua, 'FxiOS') => 'Firefox',
            str_contains($ua, 'CriOS') || str_contains($ua, 'Chrome/') => 'Chrome',
            str_contains($ua, 'Safari/') => 'Safari',
            default => $ua === '' ? 'Unknown browser' : 'A browser',
        };
        return $browser . ($os ? " on $os" : '');
    }
}
