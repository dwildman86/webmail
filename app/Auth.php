<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Users, passwords (Argon2id where PHP has it), sessions and CSRF. Sign-in attempts are limited per IP address and per
 * account, so passwords can't be guessed quickly.
 */
final class Auth
{
    private const MAX_ATTEMPTS = 10;
    private const WINDOW_MINUTES = 15;
    private const IDLE_DAYS = 30;
    private const PENDING_SECONDS = 600;

    public function __construct(private App $app)
    {
    }

    public static function startSession(string $basePath): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.gc_maxlifetime', (string) (self::IDLE_DAYS * 86400));
        session_name('wmsid');
        session_set_cookie_params([
            'lifetime' => self::IDLE_DAYS * 86400,
            'path' => $basePath === '' ? '/' : $basePath . '/',
            'secure' => Http::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    public static function hash(string $password): string
    {
        return password_hash($password, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
    }

    public static function checkPassword(string $password): void
    {
        if (mb_strlen($password) < 10) {
            throw new HttpError(422, 'Use a password of at least 10 characters', 'weak_password');
        }
    }

    public function emailIndex(string $email): string
    {
        return $this->app->crypto->blindIndex(mb_strtolower(trim($email)), 'users.email');
    }

    public function createUser(string $email, string $name, string $password, string $role = 'user'): int
    {
        $email = trim($email);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new HttpError(422, 'Enter a valid email address', 'invalid_email');
        }
        self::checkPassword($password);
        if ($this->app->db->value('SELECT id FROM {users} WHERE email_bidx = ?', [$this->emailIndex($email)])) {
            throw new HttpError(409, 'There is already a user with that email address', 'user_exists');
        }
        $c = $this->app->crypto;
        return $this->app->db->insert(
            'INSERT INTO {users} (email_bidx, email_enc, name_enc, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [$this->emailIndex($email), $c->encrypt($email, 'users.email'), $c->encrypt($name, 'users.name'), self::hash($password), $role, App::now()],
        );
    }

    /** Sign in with email and password; throws HttpError on failure. Returns the user id. */
    public function login(string $email, string $password, string $ip): int
    {
        $db = $this->app->db;
        $keys = [$this->app->crypto->blindIndex('ip:' . $ip, 'login'), $this->app->crypto->blindIndex('email:' . mb_strtolower(trim($email)), 'login')];
        $since = gmdate('Y-m-d H:i:s', time() - self::WINDOW_MINUTES * 60);
        foreach ($keys as $k) {
            if ((int) $db->value('SELECT COUNT(*) FROM {login_attempts} WHERE key_bidx = ? AND at > ?', [$k, $since]) >= self::MAX_ATTEMPTS) {
                throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.', 'rate_limited');
            }
        }
        $user = $db->one('SELECT id, password_hash, disabled FROM {users} WHERE email_bidx = ?', [$this->emailIndex($email)]);
        // Check a hash even when there's no such user, so the timing doesn't reveal which emails exist.
        $ok = password_verify($password, $user['password_hash'] ?? '$argon2id$v=19$m=65536,t=4,p=1$V3dKc2NqcDlXU0tlaHlueA$+xkyEjLd8O6MTWnwZFhYOBYcsmMN6O2RxfWhD6Twhng');
        if (!$user || !$ok || $user['disabled']) {
            foreach ($keys as $k) {
                $db->run('INSERT INTO {login_attempts} (key_bidx, at) VALUES (?, ?)', [$k, App::now()]);
            }
            throw new HttpError(401, 'Wrong email or password', 'invalid_login');
        }
        if (password_needs_rehash($user['password_hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
            $db->run('UPDATE {users} SET password_hash = ? WHERE id = ?', [self::hash($password), $user['id']]);
        }
        // The password is only the first step: the session can't read mail until the second step is done.
        $this->beginPending((int) $user['id']);
        return (int) $user['id'];
    }

    /** After the password: the session may only do the second step (or set one up). */
    public function beginPending(int $userId): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }
        $_SESSION = ['pending_uid' => $userId, 'pending_at' => time(), 'csrf' => bin2hex(random_bytes(32))];
    }

    /**
     * A sign-in waiting for its second step: ['uid' => …, 'stage' => 'verify'] when the person has a second step to
     * use, 'enrol' when they must set one up first. Null when there's none (or it took longer than 10 minutes).
     */
    public function pending(): ?array
    {
        $uid = (int) ($_SESSION['pending_uid'] ?? 0);
        if (!$uid || time() - (int) ($_SESSION['pending_at'] ?? 0) > self::PENDING_SECONDS) {
            return null;
        }
        $row = $this->app->db->one('SELECT id, email_enc, name_enc, disabled FROM {users} WHERE id = ?', [$uid]);
        if (!$row || $row['disabled']) {
            return null;
        }
        $c = $this->app->crypto;
        return ['uid' => $uid, 'stage' => (new Mfa($this->app))->configured($uid) ? 'verify' : 'enrol',
            'email' => $c->decrypt($row['email_enc'], 'users.email'), 'name' => $c->decrypt($row['name_enc'], 'users.name') ?? ''];
    }

    /** Start a signed-in session: after the second step, or a passkey (which is both steps in one). */
    public function begin(int $userId): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true); // a new session id at sign-in: an id planted before it is useless
        }
        $version = (int) $this->app->db->value('SELECT session_version FROM {users} WHERE id = ?', [$userId]);
        $_SESSION = ['uid' => $userId, 'sv' => $version, 'csrf' => bin2hex(random_bytes(32)), 'seen' => time()];
        $this->app->db->run('UPDATE {users} SET last_login_at = ? WHERE id = ?', [App::now(), $userId]);
    }

    /** For sensitive changes: the person's password again. */
    public function confirmPassword(int $userId, string $password): void
    {
        $db = $this->app->db;
        $key = $this->app->crypto->blindIndex('confirm:' . $userId, 'login');
        if ((int) $db->value('SELECT COUNT(*) FROM {login_attempts} WHERE key_bidx = ? AND at > ?', [$key, gmdate('Y-m-d H:i:s', time() - self::WINDOW_MINUTES * 60)]) >= self::MAX_ATTEMPTS) {
            throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again.', 'rate_limited');
        }
        $hash = (string) $db->value('SELECT password_hash FROM {users} WHERE id = ?', [$userId]);
        if (!password_verify($password, $hash)) {
            $db->run('INSERT INTO {login_attempts} (key_bidx, at) VALUES (?, ?)', [$key, App::now()]);
            throw new HttpError(422, 'Your password is wrong', 'wrong_password');
        }
    }

    public function logout(): void
    {
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_destroy();
        }
    }

    /** The signed-in user, or null. */
    public function user(): ?array
    {
        $uid = $_SESSION['uid'] ?? null;
        if (!$uid || (time() - (int) ($_SESSION['seen'] ?? 0)) > self::IDLE_DAYS * 86400) {
            return null;
        }
        $row = $this->app->db->one('SELECT id, email_enc, name_enc, role, disabled, session_version FROM {users} WHERE id = ?', [$uid]);
        // Signed out everywhere (a password change or a reset of their second step) since this session began.
        if (!$row || $row['disabled'] || (int) $row['session_version'] !== (int) ($_SESSION['sv'] ?? -1)) {
            return null;
        }
        // Two-step verification is required: someone without it (signed in before it was, or reset by an
        // administrator) has to set it up before going any further.
        if (!(new Mfa($this->app))->configured((int) $uid)) {
            $this->beginPending((int) $uid);
            return null;
        }
        $_SESSION['seen'] = time();
        $c = $this->app->crypto;
        return ['id' => (int) $row['id'], 'email' => $c->decrypt($row['email_enc'], 'users.email'), 'name' => $c->decrypt($row['name_enc'], 'users.name') ?? '', 'role' => $row['role']];
    }

    public function requireUser(): array
    {
        return $this->user() ?? throw new HttpError(401, 'Sign in first', 'unauthenticated');
    }

    public function requireAdmin(): array
    {
        $u = $this->requireUser();
        if ($u['role'] !== 'admin') {
            throw new HttpError(403, 'Only an administrator can do that', 'forbidden');
        }
        return $u;
    }

    public static function csrfToken(): string
    {
        return $_SESSION['csrf'] ?? '';
    }

    /** Changes must carry the session's CSRF token in X-CSRF-Token. */
    public static function checkCsrf(): void
    {
        $given = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        if (($_SESSION['csrf'] ?? '') === '' || !hash_equals($_SESSION['csrf'], $given)) {
            throw new HttpError(403, 'Your session expired. Reload the page.', 'csrf');
        }
    }
}
