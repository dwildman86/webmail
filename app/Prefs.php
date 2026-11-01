<?php
declare(strict_types=1);

namespace Webmail;

/** A person's own settings, wherever they sign in: for now, how long Undo send has. */
final class Prefs
{
    /** Seconds an email waits after Send, so it can be taken back. 0 sends straight away. */
    public const UNDO_SEND = [0, 5, 10, 20, 30];
    private const DEFAULTS = ['undo_send' => 10];

    public function __construct(private App $app)
    {
    }

    public function get(int $userId): array
    {
        $saved = json_decode((string) $this->app->db->value('SELECT prefs FROM {users} WHERE id = ?', [$userId]), true);
        return array_intersect_key((is_array($saved) ? $saved : []) + self::DEFAULTS, self::DEFAULTS);
    }

    public function save(int $userId, array $in): array
    {
        $prefs = $this->get($userId);
        if (array_key_exists('undo_send', $in)) {
            if (!in_array((int) $in['undo_send'], self::UNDO_SEND, true)) {
                throw new HttpError(422, 'Choose 0, 5, 10, 20 or 30 seconds', 'bad_prefs');
            }
            $prefs['undo_send'] = (int) $in['undo_send'];
        }
        $this->app->db->run('UPDATE {users} SET prefs = ? WHERE id = ?', [json_encode($prefs), $userId]);
        return $prefs;
    }
}
