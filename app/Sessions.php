<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Sign-in sessions, kept in the webmail's own database instead of PHP's session files. Many hosts clean their shared
 * session folder on their own schedule (often after 24 minutes, whatever the webmail asks for), which signed people
 * out of the installed app. Here a session lasts as long as the webmail says.
 *
 * The database holds a hash of each session's id (a copy of the database can't be used to sign in) and the session's
 * contents encrypted.
 */
final class Sessions implements \SessionHandlerInterface, \SessionUpdateTimestampHandlerInterface
{
    public function __construct(private App $app, private int $lifetime)
    {
    }

    private static function key(string $id): string
    {
        return hash('sha256', $id);
    }

    public function open(string $path, string $name): bool
    {
        return true;
    }

    public function close(): bool
    {
        return true;
    }

    public function read(string $id): string|false
    {
        $row = $this->app->db->one('SELECT data_enc, updated_at FROM {sessions} WHERE id_hash = ?', [self::key($id)]);
        if (!$row || (int) $row['updated_at'] < time() - $this->lifetime) {
            return '';
        }
        return $this->app->crypto->decrypt($row['data_enc'], 'sessions.data') ?? '';
    }

    public function write(string $id, string $data): bool
    {
        // Whose it is, and the device and address it was last used from: for the list of where someone is signed in.
        $uid = isset($_SESSION['uid']) ? (int) $_SESSION['uid'] : null;
        $agent = $uid ? mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 400) : null;
        $app = $uid && ($_SERVER['HTTP_X_WEBMAIL_APP'] ?? '') === '1' ? 1 : 0;
        $this->app->db->run(
            'INSERT INTO {sessions} (id_hash, data_enc, updated_at, user_id, handle, ip, agent_enc, app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE data_enc = VALUES(data_enc), updated_at = VALUES(updated_at), user_id = VALUES(user_id), ip = VALUES(ip), handle = COALESCE(handle, VALUES(handle)),
               agent_enc = COALESCE(VALUES(agent_enc), agent_enc), app = GREATEST(app, VALUES(app)), created_at = COALESCE(created_at, VALUES(created_at))',
            [self::key($id), $this->app->crypto->encrypt($data, 'sessions.data'), time(), $uid, bin2hex(random_bytes(16)), $uid ? Http::ip() : null,
                $agent !== null ? $this->app->crypto->encrypt($agent, 'sessions.agent') : null, $app, $uid ? time() : null],
        );
        return true;
    }

    public function destroy(string $id): bool
    {
        $this->app->db->run('DELETE FROM {sessions} WHERE id_hash = ?', [self::key($id)]);
        return true;
    }

    public function gc(int $max_lifetime): int|false
    {
        return $this->app->db->run('DELETE FROM {sessions} WHERE updated_at < ?', [time() - $this->lifetime])->rowCount();
    }

    /** Strict mode: only ids this webmail issued (and that haven't expired) are accepted. */
    public function validateId(string $id): bool
    {
        return (bool) $this->app->db->value('SELECT 1 FROM {sessions} WHERE id_hash = ? AND updated_at >= ?', [self::key($id), time() - $this->lifetime]);
    }

    public function updateTimestamp(string $id, string $data): bool
    {
        $this->app->db->run('UPDATE {sessions} SET updated_at = ? WHERE id_hash = ?', [time(), self::key($id)]);
        return true;
    }
}
