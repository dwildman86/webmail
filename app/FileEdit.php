<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Editing documents and spreadsheets in Files, together, live (assets/office/*.js does the editing).
 *
 * Every change anyone makes is sent here and given a number: that order is the truth, and every browser applies the
 * changes in it, so everyone ends up with the same document. The file as last saved (a real .docx, .xlsx, .csv or
 * text file, in Files) plus the changes after it is always the whole document: nothing is lost if nobody saves.
 * One editor's browser is asked to save it every so often (the "saver"); a save says which change it goes up to,
 * and changes it covers are tidied away after a day. Changes and presence are stored encrypted.
 *
 * Someone uploading a new version by hand starts a new "generation": open editors are told to load it again.
 * Browsers ask for changes about once a second (shared hosting has no WebSockets).
 */
final class FileEdit
{
    /** File types the editors open. */
    public const TYPES = ['docx' => 'document', 'xlsx' => 'spreadsheet', 'csv' => 'spreadsheet', 'txt' => 'text', 'md' => 'text'];
    /** Gone from the list of who's here after this long without asking for changes. */
    private const AWAY_SECONDS = 25;
    private const MAX_OP_BYTES = 6 * 1024 * 1024;
    private const MAX_OPS = 500;
    /** Autosaves within this long by the same person replace each other, so versions are worth looking back at. */
    private const AUTOSAVE_MERGE_SECONDS = 600;
    public const COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];

    public function __construct(private App $app)
    {
    }

    private function files(): Files
    {
        return new Files($this->app);
    }

    public static function kind(string $name): ?string
    {
        $dot = strrpos($name, '.');
        return $dot === false ? null : (self::TYPES[strtolower(substr($name, $dot + 1))] ?? null);
    }

    private static function client(string $c): string
    {
        if (!preg_match('/^[a-zA-Z0-9]{16}$/', $c)) {
            throw new HttpError(422, 'Bad editor session', 'bad_client');
        }
        return $c;
    }

    private function state(int $nodeId, ?int $versionId = null): array
    {
        $s = $this->app->db->one('SELECT * FROM {file_edit_state} WHERE node_id = ?', [$nodeId]);
        if (!$s) {
            $this->app->db->run('INSERT IGNORE INTO {file_edit_state} (node_id, generation, version_id, seq, updated_at) VALUES (?, 1, ?, 0, ?)', [$nodeId, $versionId, App::now()]);
            $s = $this->app->db->one('SELECT * FROM {file_edit_state} WHERE node_id = ?', [$nodeId]);
        }
        return $s;
    }

    /** The file, ready to edit or view: what's stored, and the changes after it. */
    public function open(array $user, int $nodeId, string $client): array
    {
        $client = self::client($client);
        $files = $this->files();
        $node = $files->need($user, $nodeId);
        $name = $files->name($node);
        if ($node['kind'] !== 'file' || !self::kind($name)) {
            throw new HttpError(422, "This kind of file can't be edited here. Download it to open it.", 'not_editable');
        }
        if ($node['vault']) {
            throw new HttpError(422, "Vault files can't be edited here yet. Download it to change it.", 'vault');
        }
        $canEdit = in_array($node['role'], ['owner', 'editor'], true) && $files->allowed();
        $s = $this->state($nodeId, $node['version_id'] ? (int) $node['version_id'] : null);
        $this->touch($nodeId, $client, $user, $canEdit, null, true);
        return [
            'file' => ['id' => $nodeId, 'name' => $name, 'kind' => self::kind($name), 'size' => (int) $node['size'], 'role' => $node['role']],
            'can_edit' => $canEdit, 'generation' => (int) $s['generation'], 'version_id' => $s['version_id'] ? (int) $s['version_id'] : null,
            'base_seq' => (int) $s['seq'], 'ops' => $this->opsAfter($nodeId, (int) $s['generation'], (int) $s['seq']),
            'me' => ['client' => $client, 'user_id' => (int) $user['id'], 'name' => $user['name'] ?: $user['email'], 'color' => self::color((int) $user['id'])],
        ] + $this->room($nodeId, $client);
    }

    public static function color(int $userId): string
    {
        return self::COLORS[$userId % count(self::COLORS)];
    }

    /**
     * Send changes (when allowed to edit) and where this person's cursor is; get everyone else's changes since $since,
     * who's here, and whether to save. $ops: [['seen' => the last change this one was made on top of, 'op' => …], …].
     */
    public function sync(array $user, int $nodeId, string $client, int $generation, int $since, array $ops, mixed $presence): array
    {
        $client = self::client($client);
        $files = $this->files();
        $node = $files->need($user, $nodeId);
        $canEdit = in_array($node['role'], ['owner', 'editor'], true) && $files->allowed();
        $s = $this->state($nodeId, $node['version_id'] ? (int) $node['version_id'] : null);
        if ((int) $s['generation'] !== $generation) {
            return ['reload' => true, 'reason' => 'A new version of this file was uploaded. It opens again with it.'];
        }
        if ($ops) {
            if (!$canEdit) {
                throw new HttpError(403, "It's shared with you to view, not to change.", 'forbidden');
            }
            if (count($ops) > self::MAX_OPS) {
                throw new HttpError(413, 'Too many changes at once.', 'too_many');
            }
            $total = 0;
            $now = App::now();
            foreach ($ops as $o) {
                $json = json_encode($o['op'] ?? null);
                $total += strlen((string) $json);
                if (!is_array($o) || !isset($o['op']) || $total > self::MAX_OP_BYTES) {
                    throw new HttpError(413, 'That change is too big (an image over a few megabytes?).', 'too_big');
                }
                $this->app->db->insert('INSERT INTO {file_edit_ops} (node_id, generation, client, user_id, seen, op_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [$nodeId, $generation, $client, $user['id'], max(0, (int) ($o['seen'] ?? 0)), $this->app->crypto->encryptJson($o['op'], 'files.edit'), $now]);
            }
            $this->app->db->run('UPDATE {file_nodes} SET updated_at = ? WHERE id = ?', [$now, $nodeId]);
        }
        $this->touch($nodeId, $client, $user, $canEdit, $presence);
        return ['generation' => $generation, 'ops' => $this->opsAfter($nodeId, $generation, $since), 'can_edit' => $canEdit,
            'base_seq' => (int) $s['seq'], 'version_id' => $s['version_id'] ? (int) $s['version_id'] : null] + $this->room($nodeId, $client);
    }

    private function opsAfter(int $nodeId, int $generation, int $since): array
    {
        $rows = $this->app->db->all('SELECT id, client, user_id, seen, op_enc FROM {file_edit_ops} WHERE node_id = ? AND generation = ? AND id > ? ORDER BY id LIMIT 2000',
            [$nodeId, $generation, $since]);
        return array_map(fn ($r) => ['seq' => (int) $r['id'], 'client' => $r['client'], 'user_id' => $r['user_id'] ? (int) $r['user_id'] : null,
            'seen' => (int) $r['seen'], 'op' => $this->app->crypto->decryptJson($r['op_enc'], 'files.edit')], $rows);
    }

    private function touch(int $nodeId, string $client, array $user, bool $canEdit, mixed $presence, bool $joining = false): void
    {
        $now = App::now();
        $state = $presence !== null ? $this->app->crypto->encryptJson($presence, 'files.presence') : null;
        $this->app->db->run('INSERT INTO {file_edit_presence} (node_id, client, user_id, can_edit, state_enc, joined_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE can_edit = VALUES(can_edit), seen_at = VALUES(seen_at), state_enc = COALESCE(VALUES(state_enc), state_enc)',
            [$nodeId, $client, $user['id'], (int) $canEdit, $state, $now, $now]);
    }

    /** Who's here (not this browser), and which editor's browser should save. */
    private function room(int $nodeId, string $client): array
    {
        $cut = gmdate('Y-m-d H:i:s', time() - self::AWAY_SECONDS);
        $rows = $this->app->db->all('SELECT * FROM {file_edit_presence} WHERE node_id = ? AND seen_at >= ? ORDER BY joined_at, client', [$nodeId, $cut]);
        $people = $this->files()->people();
        $saver = null;
        $others = [];
        foreach ($rows as $r) {
            if (!$saver && $r['can_edit']) {
                $saver = $r['client'];
            }
            if ($r['client'] !== $client) {
                $others[] = ['client' => $r['client'], 'user_id' => (int) $r['user_id'], 'name' => $people[(int) $r['user_id']]['name'] ?? 'Someone',
                    'color' => self::color((int) $r['user_id']), 'can_edit' => (bool) $r['can_edit'],
                    'state' => $r['state_enc'] ? $this->app->crypto->decryptJson($r['state_enc'], 'files.presence') : null];
            }
        }
        return ['others' => $others, 'saver' => $saver === $client];
    }

    public function leave(array $user, int $nodeId, string $client): void
    {
        $this->app->db->run('DELETE FROM {file_edit_presence} WHERE node_id = ? AND client = ? AND user_id = ?', [$nodeId, self::client($client), $user['id']]);
    }

    /**
     * Files: the editor saved a version including changes up to $edit['seq']. Back-to-back autosaves by the same
     * person replace each other. Returns whether the previous autosave was replaced (so it isn't logged again).
     */
    public function saved(int $nodeId, int $versionId, array $edit, ?array $user): bool
    {
        $s = $this->state($nodeId);
        if ((int) $edit['generation'] !== (int) $s['generation'] || (int) $edit['seq'] < (int) $s['seq']) {
            // An old save arriving late: keep it as a version, but it doesn't move the document on.
            $this->app->db->run('UPDATE {file_nodes} SET version_id = ? WHERE id = ?', [$s['version_id'] ?? $versionId, $nodeId]);
            return false;
        }
        $replaced = false;
        if ($s['autosave_version_id'] && $user) {
            $prev = $this->app->db->one('SELECT * FROM {file_versions} WHERE id = ? AND node_id = ?', [$s['autosave_version_id'], $nodeId]);
            if ($prev && (int) $prev['created_by'] === (int) $user['id'] && strtotime($prev['created_at'] . ' UTC') > time() - self::AUTOSAVE_MERGE_SECONDS) {
                $this->files()->deleteObject($prev['store'], $prev['object_key']);
                $this->app->db->run('DELETE FROM {file_versions} WHERE id = ?', [$prev['id']]);
                $replaced = true;
            }
        }
        $this->app->db->run('UPDATE {file_edit_state} SET version_id = ?, seq = ?, autosave_version_id = ?, updated_at = ? WHERE node_id = ?',
            [$versionId, (int) $edit['seq'], $versionId, App::now(), $nodeId]);
        return $replaced;
    }

    /** Files: a new version uploaded (not from the editor): editors start again from it. */
    public function replaced(int $nodeId, int $versionId): void
    {
        if ($this->app->db->value('SELECT 1 FROM {file_edit_state} WHERE node_id = ?', [$nodeId])) {
            $this->app->db->run('UPDATE {file_edit_state} SET generation = generation + 1, version_id = ?, seq = 0, autosave_version_id = NULL, updated_at = ? WHERE node_id = ?',
                [$versionId, App::now(), $nodeId]);
            $this->app->db->run('DELETE FROM {file_edit_ops} WHERE node_id = ?', [$nodeId]);
        }
    }

    // ------------------------------------------------------------------------------------------------ comments

    public function comments(array $user, int $nodeId): array
    {
        $this->files()->need($user, $nodeId);
        $people = $this->files()->people();
        return array_map(fn ($c) => ['id' => (int) $c['id'], 'parent_id' => $c['parent_id'] ? (int) $c['parent_id'] : null, 'anchor' => $c['anchor'],
            'body' => (string) $this->app->crypto->decrypt($c['body_enc'], 'files.comment'), 'by' => $people[(int) $c['user_id']]['name'] ?? 'Someone',
            'user_id' => (int) $c['user_id'], 'color' => self::color((int) $c['user_id']), 'at' => gmdate('c', strtotime($c['created_at'] . ' UTC')),
            'resolved' => (bool) $c['resolved_at']], $this->app->db->all('SELECT * FROM {file_comments} WHERE node_id = ? ORDER BY id', [$nodeId]));
    }

    /** Anyone who can see the file can comment (viewers too). */
    public function comment(array $user, int $nodeId, string $anchor, string $body, ?int $parentId): array
    {
        $node = $this->files()->need($user, $nodeId);
        $body = trim($body);
        if ($body === '' || mb_strlen($body) > 5000) {
            throw new HttpError(422, 'Write a comment (up to 5,000 characters).', 'bad_comment');
        }
        if ($parentId && !$this->app->db->value('SELECT 1 FROM {file_comments} WHERE id = ? AND node_id = ? AND parent_id IS NULL', [$parentId, $nodeId])) {
            throw new HttpError(404, 'That comment has gone.', 'not_found');
        }
        $this->app->db->insert('INSERT INTO {file_comments} (node_id, parent_id, anchor, body_enc, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [$nodeId, $parentId, mb_substr($anchor, 0, 200), $this->app->crypto->encrypt($body, 'files.comment'), $user['id'], App::now()]);
        $this->files()->log('comment', (int) $node['id'], $user);
        return $this->comments($user, $nodeId);
    }

    public function resolve(array $user, int $commentId, bool $resolved): array
    {
        $c = $this->app->db->one('SELECT * FROM {file_comments} WHERE id = ?', [$commentId]);
        if (!$c) {
            throw new HttpError(404, 'That comment has gone.', 'not_found');
        }
        $this->files()->need($user, (int) $c['node_id']);
        $this->app->db->run('UPDATE {file_comments} SET resolved_at = ?, resolved_by = ? WHERE id = ?', [$resolved ? App::now() : null, $resolved ? $user['id'] : null, $commentId]);
        return $this->comments($user, (int) $c['node_id']);
    }

    /** Your own comment, or anyone's if you can edit the file. */
    public function deleteComment(array $user, int $commentId): array
    {
        $c = $this->app->db->one('SELECT * FROM {file_comments} WHERE id = ?', [$commentId]);
        if (!$c) {
            throw new HttpError(404, 'That comment has gone.', 'not_found');
        }
        $this->files()->need($user, (int) $c['node_id'], (int) $c['user_id'] === (int) $user['id'] ? 'viewer' : 'editor');
        $this->app->db->run('DELETE FROM {file_comments} WHERE id = ? OR parent_id = ?', [$commentId, $commentId]);
        return $this->comments($user, (int) $c['node_id']);
    }

    // ------------------------------------------------------------------------------------------------ housekeeping

    /** Changes a save includes, a day on; who was here an hour on. */
    public function cleanup(): void
    {
        $this->app->db->run('DELETE o FROM {file_edit_ops} o JOIN {file_edit_state} s ON s.node_id = o.node_id
            WHERE (o.generation < s.generation OR o.id <= s.seq) AND o.created_at < ?', [gmdate('Y-m-d H:i:s', time() - 86400)]);
        $this->app->db->run('DELETE FROM {file_edit_presence} WHERE seen_at < ?', [gmdate('Y-m-d H:i:s', time() - 3600)]);
    }
}
