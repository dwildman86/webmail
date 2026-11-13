<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Files: folders and documents, like OneDrive, stored encrypted (FileCrypto) on this server's disk or an S3-compatible
 * bucket. Shared with people or a mailbox's team (viewer or editor, inherited down folders), and through share links
 * (FileLinks) when an administrator allows them. Each person has a private vault too (Vault), encrypted in the browser.
 *
 * Offered while the GhostParse account has an active plan (GET /v1/me features.files). Without one, files already
 * stored can still be opened, downloaded and deleted, but nothing new is added and share links stop working.
 *
 * A tree belongs to whoever owns its top folder: files anyone adds inside count towards that person's quota, and
 * stay theirs. Administrators can't see other people's files.
 */
final class Files
{
    /** An upload arrives in pieces of this size (a whole number of encryption chunks, and over S3's 5 MB part minimum). */
    public const UPLOAD_PIECE = 8 * 1024 * 1024;
    /** Opened, downloaded or zipped in one go (attaching to an email, a folder's ZIP) up to this size per file. */
    public const MAX_IN_MEMORY = 50 * 1024 * 1024;
    /** Read from storage this much at a time while streaming a download. */
    private const READ_CHUNKS = 64;
    /** Shown in the page (in a sandbox) rather than downloaded. Never HTML, SVG or anything that runs script. */
    public const INLINE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf',
        'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'video/mp4', 'video/webm', 'video/ogg', 'text/plain'];
    private const DEFAULTS = [
        'store' => 'local', 's3' => null, 'quota_user_mb' => 5120, 'quota_total_mb' => 0, 'max_file_mb' => 2048, 'blocked' => [],
        'links' => false, 'links_password' => false, 'links_max_days' => 30, 'trash_days' => 30, 'versions' => 10,
    ];
    /** Never accepted from a file request (strangers uploading), whatever the administrator's list. */
    public const REQUEST_BLOCKED = ['exe', 'scr', 'pif', 'com', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'msi', 'hta', 'jar', 'ps1', 'lnk', 'dll', 'apk', 'app', 'dmg', 'iso'];

    private array $roles = [];
    private ?array $people = null;

    public function __construct(private App $app)
    {
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    // ------------------------------------------------------------------------------------------------ settings and plan

    public function settings(): array
    {
        $raw = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'files'"), true);
        return array_intersect_key((is_array($raw) ? $raw : []) + self::DEFAULTS, self::DEFAULTS);
    }

    /** For Settings → Files: the S3 secret is never sent back, only whether one is set. */
    public function publicSettings(): array
    {
        $s = $this->settings();
        if ($s['s3']) {
            $s['s3'] = array_diff_key($s['s3'], ['secret_enc' => 1]) + ['secret_set' => !empty($s['s3']['secret_enc'])];
        }
        return $s;
    }

    public function saveSettings(array $in): array
    {
        $s = $this->settings();
        foreach (['quota_user_mb' => [0, 10_000_000], 'quota_total_mb' => [0, 100_000_000], 'max_file_mb' => [1, 1_000_000],
            'links_max_days' => [0, 3650], 'trash_days' => [1, 365], 'versions' => [1, 100]] as $k => [$min, $max]) {
            if (array_key_exists($k, $in)) {
                $v = (int) $in[$k];
                if ($v < $min || $v > $max) {
                    throw new HttpError(422, "Choose a number from $min to $max", 'bad_settings');
                }
                $s[$k] = $v;
            }
        }
        foreach (['links', 'links_password'] as $k) {
            if (array_key_exists($k, $in)) {
                $s[$k] = (bool) $in[$k];
            }
        }
        if (array_key_exists('blocked', $in)) {
            $list = is_array($in['blocked']) ? $in['blocked'] : preg_split('/[\s,]+/', (string) $in['blocked']);
            $s['blocked'] = array_values(array_unique(array_filter(array_map(fn ($e) => strtolower(ltrim(trim((string) $e), '.')), $list),
                fn ($e) => preg_match('/^[a-z0-9]{1,10}$/', $e))));
        }
        if (array_key_exists('s3', $in) && is_array($in['s3'])) {
            $old = $s['s3'] ?? [];
            $new = ['endpoint' => trim((string) ($in['s3']['endpoint'] ?? $old['endpoint'] ?? '')), 'region' => trim((string) ($in['s3']['region'] ?? $old['region'] ?? '')),
                'bucket' => trim((string) ($in['s3']['bucket'] ?? $old['bucket'] ?? '')), 'access_key' => trim((string) ($in['s3']['access_key'] ?? $old['access_key'] ?? '')),
                'path_style' => (bool) ($in['s3']['path_style'] ?? $old['path_style'] ?? false),
                'secret_enc' => ($in['s3']['secret_key'] ?? '') !== '' ? $this->c()->encrypt((string) $in['s3']['secret_key'], 'files.s3') : ($old['secret_enc'] ?? null)];
            $s['s3'] = $new;
        }
        if (array_key_exists('store', $in)) {
            if (!in_array($in['store'], ['local', 's3'], true)) {
                throw new HttpError(422, 'Choose this server or an S3 bucket', 'bad_settings');
            }
            if ($in['store'] === 's3') {
                (self::$stores['s3'] ?? $this->s3Store($s['s3']))->test();
            }
            $s['store'] = $in['store'];
        }
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('files', ?)", [json_encode($s)]);
        return $this->publicSettings();
    }

    /** Settings → Files → Test connection, with what's typed (before saving). */
    public function testS3(array $in): void
    {
        $s = $this->settings()['s3'] ?? [];
        $c = ['endpoint' => trim((string) ($in['endpoint'] ?? $s['endpoint'] ?? '')), 'region' => trim((string) ($in['region'] ?? $s['region'] ?? '')),
            'bucket' => trim((string) ($in['bucket'] ?? $s['bucket'] ?? '')), 'access_key' => trim((string) ($in['access_key'] ?? $s['access_key'] ?? '')),
            'path_style' => (bool) ($in['path_style'] ?? $s['path_style'] ?? false),
            'secret_enc' => ($in['secret_key'] ?? '') !== '' ? $this->c()->encrypt((string) $in['secret_key'], 'files.s3') : ($s['secret_enc'] ?? null)];
        $this->s3Store($c)->test();
    }

    private function s3Store(?array $c): S3Store
    {
        if (!$c || empty($c['bucket']) || empty($c['access_key']) || empty($c['secret_enc'])) {
            throw new HttpError(422, 'Fill in the bucket, access key and secret first', 'bad_s3');
        }
        return new S3Store(['endpoint' => $c['endpoint'] ?? '', 'region' => $c['region'] ?: 'us-east-1', 'bucket' => $c['bucket'],
            'access_key' => $c['access_key'], 'secret_key' => (string) $this->c()->decrypt($c['secret_enc'], 'files.s3'), 'path_style' => !empty($c['path_style'])]);
    }

    /** A store by name ('local' or 's3'), or the one new files go to. Tests swap in their own. */
    public function store(?string $name = null): FileStore
    {
        $name ??= $this->settings()['store'];
        if (isset(self::$stores[$name])) {
            return self::$stores[$name];
        }
        return $name === 's3' ? $this->s3Store($this->settings()['s3']) : new LocalStore();
    }

    /** @var array<string, FileStore> */
    public static array $stores = [];

    /** Does the GhostParse plan include Files? Asked at most every 6 hours; the last answer stands when it can't be reached. */
    public function allowed(bool $refresh = false): bool
    {
        $known = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'files_allowed'"), true);
        if (!$refresh && is_array($known) && ($known['at'] ?? 0) > time() - 6 * 3600) {
            return (bool) $known['allowed'];
        }
        try {
            $allowed = (bool) ($this->app->gp->me()['features']['files'] ?? false);
        } catch (\Throwable) {
            return (bool) ($known['allowed'] ?? false);
        }
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('files_allowed', ?)", [json_encode(['at' => time(), 'allowed' => $allowed])]);
        return $allowed;
    }

    private function needPlan(): void
    {
        if (!$this->allowed()) {
            throw new HttpError(402, 'Adding files needs an active GhostParse plan. Your files are still here to open, download or delete.', 'files_plan');
        }
    }

    /** The webmail's people, id → ['name', 'email'] (both stored encrypted). */
    public function people(): array
    {
        if ($this->people === null) {
            $this->people = [];
            foreach ($this->app->db->all('SELECT id, email_enc, name_enc FROM {users} ORDER BY id') as $r) {
                $email = (string) $this->c()->decrypt($r['email_enc'], 'users.email');
                $this->people[(int) $r['id']] = ['name' => ($this->c()->decrypt($r['name_enc'], 'users.name') ?? '') ?: $email, 'email' => $email];
            }
        }
        return $this->people;
    }

    // ------------------------------------------------------------------------------------------------ nodes and access

    public function node(int $id): ?array
    {
        return $this->app->db->one('SELECT * FROM {file_nodes} WHERE id = ?', [$id]);
    }

    public function name(array $node): string
    {
        return (string) $this->c()->decrypt($node['name_enc'], 'files.name');
    }

    /** The node and its ancestors, nearest first. */
    private function chain(array $node): array
    {
        $chain = [$node];
        for ($i = 0; $node['parent_id'] && $i < 100; $i++) {
            $node = $this->node((int) $node['parent_id']);
            if (!$node) {
                break;
            }
            $chain[] = $node;
        }
        return $chain;
    }

    private function mailboxIds(int $userId): array
    {
        return array_map('intval', array_column($this->app->db->all('SELECT mailbox_id FROM {user_mailboxes} WHERE user_id = ?', [$userId]), 'mailbox_id'));
    }

    /** owner, editor, viewer or null: owners own the tree; a share on the node or any folder above it gives the rest. */
    public function role(array $user, array $node): ?string
    {
        $key = $user['id'] . ':' . $node['id'];
        if (array_key_exists($key, $this->roles)) {
            return $this->roles[$key];
        }
        if ((int) $node['owner_id'] === (int) $user['id']) {
            return $this->roles[$key] = 'owner';
        }
        if ($node['vault']) {
            return $this->roles[$key] = null;
        }
        $ids = array_column($this->chain($node), 'id');
        $boxes = $this->mailboxIds((int) $user['id']);
        $params = [...$ids, (int) $user['id']];
        $sql = 'SELECT role FROM {file_shares} WHERE node_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ') AND (user_id = ?';
        if ($boxes) {
            $sql .= ' OR mailbox_id IN (' . implode(',', array_fill(0, count($boxes), '?')) . ')';
            $params = [...$params, ...$boxes];
        }
        $roles = array_column($this->app->db->all("$sql)", $params), 'role');
        return $this->roles[$key] = in_array('editor', $roles, true) ? 'editor' : ($roles ? 'viewer' : null);
    }

    /** The node, if the user may do this much with it ('viewer' < 'editor' < 'owner'). Not found otherwise. */
    public function need(array $user, int $id, string $min = 'viewer'): array
    {
        $node = $id ? $this->node($id) : null;
        $role = $node ? $this->role($user, $node) : null;
        if (!$node || !$role) {
            throw new HttpError(404, "That file or folder isn't there, or isn't shared with you.", 'not_found');
        }
        $rank = ['viewer' => 1, 'editor' => 2, 'owner' => 3];
        if ($rank[$role] < $rank[$min]) {
            throw new HttpError(403, $min === 'owner' ? 'Only its owner can do that.' : "It's shared with you to view, not to change.", 'forbidden');
        }
        if ($node['trashed_at'] && $min !== 'owner') {
            throw new HttpError(404, "That's in the bin.", 'trashed');
        }
        return $node + ['role' => $role];
    }

    /** A clean name: no slashes or control characters, not "." or "..", at most 255 characters. */
    public static function cleanName(string $name): string
    {
        $name = trim(preg_replace('/[\x00-\x1F\x7F\/\\\\]+/u', ' ', $name) ?? '');
        $name = mb_substr(preg_replace('/\s+/u', ' ', $name) ?? '', 0, 255);
        if ($name === '' || $name === '.' || $name === '..') {
            throw new HttpError(422, 'Give it a name', 'bad_name');
        }
        return $name;
    }

    private function siblingNames(array $owner, ?int $parentId, bool $vault, ?int $except = null): array
    {
        $rows = $parentId === null
            ? $this->app->db->all('SELECT id, name_enc FROM {file_nodes} WHERE owner_id = ? AND parent_id IS NULL AND vault = ? AND trashed_at IS NULL', [$owner['id'], (int) $vault])
            : $this->app->db->all('SELECT id, name_enc FROM {file_nodes} WHERE parent_id = ? AND trashed_at IS NULL', [$parentId]);
        $names = [];
        foreach ($rows as $r) {
            if ((int) $r['id'] !== $except) {
                $names[mb_strtolower($this->c()->decrypt($r['name_enc'], 'files.name'))] = (int) $r['id'];
            }
        }
        return $names;
    }

    /** "report.pdf" → "report (2).pdf" when the folder has one already. */
    private function freeName(array $taken, string $name): string
    {
        if (!isset($taken[mb_strtolower($name)])) {
            return $name;
        }
        $dot = strrpos($name, '.');
        [$base, $ext] = $dot > 0 ? [substr($name, 0, $dot), substr($name, $dot)] : [$name, ''];
        for ($i = 2; $i < 10000; $i++) {
            $try = "$base ($i)$ext";
            if (!isset($taken[mb_strtolower($try)])) {
                return $try;
            }
        }
        return $base . ' (' . bin2hex(random_bytes(3)) . ")$ext";
    }

    /** Where something new goes: a folder the user may add to (null = their own top level, or their vault's). */
    private function target(array $user, ?int $parentId, bool $vault = false): array
    {
        if (!$parentId) {
            return ['owner' => $user, 'parent' => null, 'vault' => $vault];
        }
        $parent = $this->need($user, $parentId, 'editor');
        if ($parent['kind'] !== 'folder') {
            throw new HttpError(422, "That's a file, not a folder", 'not_folder');
        }
        if ((bool) $parent['vault'] !== $vault) {
            throw new HttpError(422, $vault ? 'Vault files only go in the vault.' : "Files outside the vault can't go in it.", 'vault_mismatch');
        }
        return ['owner' => ['id' => (int) $parent['owner_id']], 'parent' => (int) $parent['id'], 'vault' => (bool) $parent['vault']];
    }

    // ------------------------------------------------------------------------------------------------ listing

    /** What one item looks like to the page. */
    private function item(array $n, ?string $role, array $sharedIds = []): array
    {
        return ['id' => (int) $n['id'], 'kind' => $n['kind'], 'name' => $this->name($n), 'size' => (int) $n['size'], 'mime' => $n['mime'],
            'updated_at' => gmdate('c', strtotime($n['updated_at'] . ' UTC')), 'vault' => (bool) $n['vault'], 'role' => $role,
            'owner_id' => (int) $n['owner_id'], 'shared' => isset($sharedIds[(int) $n['id']]),
            'trashed_at' => $n['trashed_at'] ? gmdate('c', strtotime($n['trashed_at'] . ' UTC')) : null];
    }

    private function sharedIds(array $ids): array
    {
        if (!$ids) {
            return [];
        }
        $in = implode(',', array_fill(0, count($ids), '?'));
        $rows = $this->app->db->all("SELECT DISTINCT node_id FROM {file_shares} WHERE node_id IN ($in)
            UNION SELECT DISTINCT node_id FROM {file_links} WHERE revoked_at IS NULL AND node_id IN ($in)", [...$ids, ...$ids]);
        return array_flip(array_map('intval', array_column($rows, 'node_id')));
    }

    private static function sort(array $items): array
    {
        usort($items, fn ($a, $b) => [$a['kind'] === 'folder' ? 0 : 1, mb_strtolower($a['name'])] <=> [$b['kind'] === 'folder' ? 0 : 1, mb_strtolower($b['name'])]);
        return $items;
    }

    /**
     * A folder's contents, or a view: mine (top level), vault, shared (with me), recent, trash, search (q=).
     * Also the path to the folder, what the user may do there, their usage, and the rules the page needs.
     */
    public function list(array $user, array $q): array
    {
        $db = $this->app->db;
        $view = (string) ($q['view'] ?? 'mine');
        $folder = null;
        $path = [];
        $role = 'owner';
        if (!empty($q['folder'])) {
            $folder = $this->need($user, (int) $q['folder']);
            if ($folder['kind'] !== 'folder') {
                throw new HttpError(422, "That's a file, not a folder", 'not_folder');
            }
            $role = $folder['role'];
            foreach (array_reverse($this->chain($folder)) as $n) {
                if ($this->role($user, $n)) {
                    $path[] = ['id' => (int) $n['id'], 'name' => $this->name($n)];
                }
            }
            $rows = $db->all('SELECT * FROM {file_nodes} WHERE parent_id = ? AND trashed_at IS NULL', [$folder['id']]);
            $view = $folder['vault'] ? 'vault' : ((int) $folder['owner_id'] === (int) $user['id'] ? 'mine' : 'shared');
        } elseif ($view === 'vault') {
            $rows = $db->all('SELECT * FROM {file_nodes} WHERE owner_id = ? AND parent_id IS NULL AND vault = 1 AND trashed_at IS NULL', [$user['id']]);
        } elseif ($view === 'shared') {
            $boxes = $this->mailboxIds((int) $user['id']);
            $where = 's.user_id = ?' . ($boxes ? ' OR s.mailbox_id IN (' . implode(',', array_fill(0, count($boxes), '?')) . ')' : '');
            $rows = $db->all("SELECT DISTINCT n.* FROM {file_nodes} n JOIN {file_shares} s ON s.node_id = n.id
                WHERE ($where) AND n.owner_id <> ? AND n.trashed_at IS NULL", [$user['id'], ...$boxes, $user['id']]);
            $role = null;
        } elseif ($view === 'recent') {
            $rows = $db->all("SELECT * FROM {file_nodes} WHERE owner_id = ? AND kind = 'file' AND vault = 0 AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 50", [$user['id']]);
        } elseif ($view === 'trash') {
            $rows = $db->all('SELECT * FROM {file_nodes} WHERE owner_id = ? AND trash_root = 1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC', [$user['id']]);
        } elseif ($view === 'search') {
            $needle = mb_strtolower(trim((string) ($q['q'] ?? '')));
            $rows = [];
            if (mb_strlen($needle) >= 2) {
                // Names are encrypted: read and match them here. Own files, then what's shared directly.
                foreach ($db->all('SELECT * FROM {file_nodes} WHERE owner_id = ? AND vault = 0 AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 5000', [$user['id']]) as $n) {
                    if (str_contains(mb_strtolower($this->name($n)), $needle)) {
                        $rows[] = $n;
                    }
                }
                foreach ($this->list($user, ['view' => 'shared'])['items'] as $i) {
                    if (str_contains(mb_strtolower($i['name']), $needle)) {
                        $rows[] = $this->node($i['id']);
                    }
                }
                $rows = array_slice($rows, 0, 200);
            }
        } else {
            $view = 'mine';
            $rows = $db->all('SELECT * FROM {file_nodes} WHERE owner_id = ? AND parent_id IS NULL AND vault = 0 AND trashed_at IS NULL', [$user['id']]);
        }
        $shared = $this->sharedIds(array_map(fn ($r) => (int) $r['id'], $rows));
        $items = array_map(fn ($n) => $this->item($n, $folder ? $role : $this->role($user, $n), $shared), $rows);
        if (!in_array($view, ['recent', 'trash'], true)) {
            $items = self::sort($items);
        }
        $s = $this->settings();
        return [
            'view' => $view, 'folder' => $folder ? $this->item($folder, $role, $shared) + ['path' => $path] : null, 'role' => $role, 'items' => $items,
            'usage' => $this->usage((int) $user['id']), 'allowed' => $this->allowed(),
            'rules' => ['links' => (bool) $s['links'], 'links_password' => (bool) $s['links_password'], 'links_max_days' => (int) $s['links_max_days'],
                'max_file' => $s['max_file_mb'] * 1024 * 1024, 'piece' => self::UPLOAD_PIECE, 'trash_days' => (int) $s['trash_days']],
        ];
    }

    public function usage(int $userId): array
    {
        $s = $this->settings();
        $used = (int) $this->app->db->value('SELECT COALESCE(SUM(v.size), 0) FROM {file_versions} v JOIN {file_nodes} n ON n.id = v.node_id WHERE n.owner_id = ?', [$userId]);
        return ['used' => $used, 'quota' => $s['quota_user_mb'] ? $s['quota_user_mb'] * 1024 * 1024 : null];
    }

    /** Room for $bytes more in this person's quota, and the whole webmail's. */
    private function checkRoom(int $ownerId, int $bytes): void
    {
        $s = $this->settings();
        $u = $this->usage($ownerId);
        if ($u['quota'] !== null && $u['used'] + $bytes > $u['quota']) {
            throw new HttpError(507, 'There isn\'t room: that would go over the storage allowed (' . self::human($u['quota']) . '). Delete something, or empty the bin.', 'over_quota');
        }
        if ($s['quota_total_mb']) {
            $all = (int) $this->app->db->value('SELECT COALESCE(SUM(size), 0) FROM {file_versions}');
            if ($all + $bytes > $s['quota_total_mb'] * 1024 * 1024) {
                throw new HttpError(507, "The webmail's storage is full. Ask your administrator.", 'over_quota');
            }
        }
    }

    public static function human(int $bytes): string
    {
        foreach (['GB' => 1 << 30, 'MB' => 1 << 20, 'KB' => 1 << 10] as $unit => $n) {
            if ($bytes >= $n) {
                return round($bytes / $n, $bytes >= 10 * $n ? 0 : 1) . " $unit";
            }
        }
        return "$bytes bytes";
    }

    // ------------------------------------------------------------------------------------------------ folders and changes

    public function createFolder(array $user, ?int $parentId, string $name, bool $vault = false): array
    {
        $this->needPlan();
        $t = $this->target($user, $parentId, $vault);
        $name = self::cleanName($name);
        if (isset($this->siblingNames($t['owner'], $t['parent'], $t['vault'])[mb_strtolower($name)])) {
            throw new HttpError(409, "There's already something called “{$name}” here.", 'name_taken');
        }
        $now = App::now();
        $id = $this->app->db->insert('INSERT INTO {file_nodes} (owner_id, parent_id, kind, vault, name_enc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$t['owner']['id'], $t['parent'], 'folder', (int) $t['vault'], $this->c()->encrypt($name, 'files.name'), $user['id'], $now, $now]);
        $this->log('folder', $id, $user);
        return $this->item($this->node($id), 'owner');
    }

    public function rename(array $user, int $id, string $name): array
    {
        $node = $this->need($user, $id, 'editor');
        $name = self::cleanName($name);
        $taken = $this->siblingNames(['id' => (int) $node['owner_id']], $node['parent_id'] ? (int) $node['parent_id'] : null, (bool) $node['vault'], (int) $node['id']);
        if (isset($taken[mb_strtolower($name)])) {
            throw new HttpError(409, "There's already something called “{$name}” here.", 'name_taken');
        }
        $this->app->db->run('UPDATE {file_nodes} SET name_enc = ?, updated_at = ? WHERE id = ?', [$this->c()->encrypt($name, 'files.name'), App::now(), $id]);
        $this->log('rename', $id, $user);
        return $this->item($this->node($id), $node['role']);
    }

    /** Into another folder of the same tree (or, for the owner, their top level). Never into itself. */
    public function move(array $user, int $id, ?int $to): array
    {
        $node = $this->need($user, $id, 'editor');
        if ($to) {
            $dest = $this->need($user, $to, 'editor');
            if ($dest['kind'] !== 'folder' || (int) $dest['owner_id'] !== (int) $node['owner_id'] || (bool) $dest['vault'] !== (bool) $node['vault']) {
                throw new HttpError(422, 'It can only move to another folder of the same owner' . ($node['vault'] ? ', inside the vault' : '') . '.', 'bad_move');
            }
            if (in_array((int) $node['id'], array_map('intval', array_column($this->chain($dest), 'id')), true)) {
                throw new HttpError(422, "A folder can't go inside itself.", 'bad_move');
            }
        } elseif ((int) $node['owner_id'] !== (int) $user['id']) {
            throw new HttpError(403, 'Only its owner can move it to their top level.', 'forbidden');
        }
        $taken = $this->siblingNames(['id' => (int) $node['owner_id']], $to, (bool) $node['vault'], (int) $node['id']);
        $name = $this->freeName($taken, $this->name($node));
        $this->app->db->run('UPDATE {file_nodes} SET parent_id = ?, name_enc = ?, updated_at = ? WHERE id = ?', [$to ?: null, $this->c()->encrypt($name, 'files.name'), App::now(), $id]);
        $this->log('move', $id, $user);
        return $this->item($this->node($id), $node['role']);
    }

    /** A copy of a file beside it (re-encrypted with its own key). */
    public function copy(array $user, int $id, ?int $to): array
    {
        $this->needPlan();
        $node = $this->need($user, $id);
        if ($node['kind'] !== 'file' || $node['vault']) {
            throw new HttpError(422, 'Only files outside the vault can be copied.', 'bad_copy');
        }
        $version = $this->currentVersion($node);
        $dest = $to ?? ($node['parent_id'] ? (int) $node['parent_id'] : null);
        return $this->storeBytes($user, $dest, $this->name($node), $this->readAll($version), $node['mime']);
    }

    /** Into the bin, with everything inside it. An editor's deletions go to the owner's bin. */
    public function trash(array $user, int $id): void
    {
        $node = $this->need($user, $id, 'editor');
        $now = App::now();
        $ids = $this->subtree((int) $node['id']);
        $in = implode(',', array_fill(0, count($ids), '?'));
        $this->app->db->run("UPDATE {file_nodes} SET trashed_at = ? WHERE id IN ($in) AND trashed_at IS NULL", [$now, ...$ids]);
        $this->app->db->run('UPDATE {file_nodes} SET trash_root = 1 WHERE id = ?', [$id]);
        $this->log('trash', $id, $user, ['name' => $this->name($node)]);
    }

    public function restore(array $user, int $id): array
    {
        $node = $this->need($user, $id, 'owner');
        if (!$node['trash_root']) {
            throw new HttpError(422, "That isn't in the bin.", 'not_trashed');
        }
        $ids = $this->subtree((int) $node['id']);
        $in = implode(',', array_fill(0, count($ids), '?'));
        $this->app->db->run("UPDATE {file_nodes} SET trashed_at = NULL WHERE id IN ($in) AND trashed_at = ?", [...$ids, $node['trashed_at']]);
        // Its folder is gone or in the bin too: back to the top level.
        $parent = $node['parent_id'] ? $this->node((int) $node['parent_id']) : null;
        $parentId = $parent && !$parent['trashed_at'] ? (int) $parent['id'] : null;
        $name = $this->freeName($this->siblingNames(['id' => (int) $node['owner_id']], $parentId, (bool) $node['vault'], (int) $node['id']), $this->name($node));
        $this->app->db->run('UPDATE {file_nodes} SET trash_root = 0, parent_id = ?, name_enc = ? WHERE id = ?', [$parentId, $this->c()->encrypt($name, 'files.name'), $id]);
        $this->log('restore', $id, $user);
        return $this->item($this->node($id), 'owner');
    }

    /** Gone for good, from the bin: its stored files are deleted too. */
    public function deleteForever(array $user, int $id): void
    {
        $node = $this->need($user, $id, 'owner');
        if (!$node['trashed_at'] && !$node['vault']) {
            throw new HttpError(422, 'Put it in the bin first.', 'not_trashed');
        }
        $this->log('delete', $id, $user, ['name' => $this->name($node)]);
        $this->deleteTree((int) $node['id']);
    }

    public function emptyTrash(array $user): int
    {
        $n = 0;
        foreach ($this->app->db->all('SELECT id FROM {file_nodes} WHERE owner_id = ? AND trash_root = 1 AND trashed_at IS NOT NULL', [$user['id']]) as $r) {
            $this->deleteTree((int) $r['id']);
            $n++;
        }
        return $n;
    }

    /** The node and everything under it. */
    private function subtree(int $id): array
    {
        $all = [$id];
        $frontier = [$id];
        while ($frontier) {
            $in = implode(',', array_fill(0, count($frontier), '?'));
            $frontier = array_map('intval', array_column($this->app->db->all("SELECT id FROM {file_nodes} WHERE parent_id IN ($in)", $frontier), 'id'));
            $all = [...$all, ...$frontier];
        }
        return $all;
    }

    /** Deletes the stored objects, then the rows (their children and versions go with them). */
    private function deleteTree(int $id): void
    {
        $ids = $this->subtree($id);
        $in = implode(',', array_fill(0, count($ids), '?'));
        foreach ($this->app->db->all("SELECT store, object_key FROM {file_versions} WHERE node_id IN ($in)", $ids) as $v) {
            $this->deleteObject($v['store'], $v['object_key']);
        }
        $this->app->db->run('DELETE FROM {file_nodes} WHERE id = ?', [$id]);
    }

    private function deleteObject(string $store, string $key): void
    {
        try {
            $this->store($store)->delete($key);
        } catch (\Throwable $e) {
            error_log("webmail: couldn't delete a stored file ($store): " . $e->getMessage());
        }
    }

    // ------------------------------------------------------------------------------------------------ uploading

    private static function ext(string $name): string
    {
        $dot = strrpos($name, '.');
        return $dot === false ? '' : strtolower(substr($name, $dot + 1));
    }

    /**
     * Start an upload into a folder (null: the top level, or the vault's), or as a new version of a file ($nodeId).
     * The file then arrives in pieces (appendUpload). $link: a file request's share link (someone outside uploading).
     */
    public function startUpload(?array $user, ?int $parentId, string $name, int $size, ?int $nodeId = null, bool $vault = false, ?array $link = null): array
    {
        $this->needPlan();
        $s = $this->settings();
        $name = self::cleanName($name);
        if ($size < 0 || $size > $s['max_file_mb'] * 1024 * 1024) {
            throw new HttpError(413, 'That file is bigger than the ' . self::human($s['max_file_mb'] * 1024 * 1024) . ' allowed.', 'too_big');
        }
        $ext = self::ext($name);
        if ($ext !== '' && (in_array($ext, $s['blocked'], true) || ($link && in_array($ext, self::REQUEST_BLOCKED, true)))) {
            throw new HttpError(422, ".$ext files aren't allowed here.", 'blocked_type');
        }
        if ($nodeId) {
            $node = $this->need($user, $nodeId, 'editor');
            if ($node['kind'] !== 'file' || (bool) $node['vault'] !== $vault) {
                throw new HttpError(422, 'A new version has to replace a file of the same kind.', 'bad_version');
            }
            [$ownerId, $parentId] = [(int) $node['owner_id'], $node['parent_id'] ? (int) $node['parent_id'] : null];
        } elseif ($link) {
            [$ownerId, $parentId] = [(int) $link['owner_id'], (int) $link['node_id']];
        } else {
            $t = $this->target($user, $parentId, $vault);
            [$ownerId, $parentId] = [(int) $t['owner']['id'], $t['parent']];
        }
        $this->checkRoom($ownerId, $size);
        $store = $this->store();
        $object = bin2hex(random_bytes(20));
        $key = FileCrypto::newKey();
        $state = $store->begin($object);
        $token = bin2hex(random_bytes(16));
        $this->app->db->insert('INSERT INTO {file_uploads} (token, user_id, link_id, parent_id, node_id, name_enc, size, store, object_key, key_enc, state, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [$token, $user['id'] ?? null, $link['id'] ?? null, $parentId ?? 0, $nodeId, $this->c()->encrypt($name, 'files.name'),
            $size, $store->name(), $object, FileCrypto::wrap($this->c(), $key), json_encode(['owner' => $ownerId, 'vault' => $vault, 's' => $state]), App::now()]);
        $result = ['upload' => $token, 'piece' => self::UPLOAD_PIECE, 'received' => 0];
        // An empty file has nothing to send: it's done now.
        return $size === 0 ? $result + $this->appendUpload($user, $token, 0, '', $link) : $result;
    }

    /** One piece, in order, at $offset. When the last arrives the file is stored. A retried piece is answered with where to carry on. */
    public function appendUpload(?array $user, string $token, int $offset, string $bytes, ?array $link = null): array
    {
        return $this->app->db->tx(function () use ($user, $token, $offset, $bytes, $link) {
            $u = $this->app->db->one('SELECT * FROM {file_uploads} WHERE token = ? FOR UPDATE', [$token]);
            if (!$u || ($link ? (int) $u['link_id'] !== (int) $link['id'] : (int) $u['user_id'] !== (int) ($user['id'] ?? 0))) {
                throw new HttpError(404, 'That upload has finished or expired. Start it again.', 'no_upload');
            }
            $size = (int) $u['size'];
            $received = (int) $u['received'];
            if ($offset !== $received) {
                return ['received' => $received, 'done' => false];
            }
            $last = $received + strlen($bytes) >= $size;
            if ($received + strlen($bytes) > $size || (!$last && strlen($bytes) !== self::UPLOAD_PIECE)) {
                throw new HttpError(422, "That piece of the file doesn't fit.", 'bad_piece');
            }
            $state = json_decode((string) $u['state'], true);
            $key = FileCrypto::unwrap($this->c(), $u['key_enc']);
            $sealed = FileCrypto::sealRun($key, $u['object_key'], intdiv($received, FileCrypto::CHUNK), $bytes, $last);
            $store = $this->store($u['store']);
            $state['s'] = $store->append($u['object_key'], $state['s'], $sealed, intdiv($received, self::UPLOAD_PIECE) + 1);
            $mime = $u['mime'] ?: self::sniff($bytes, $this->c()->decrypt($u['name_enc'], 'files.name'));
            $this->app->db->run('UPDATE {file_uploads} SET received = ?, state = ?, mime = ? WHERE id = ?', [$received + strlen($bytes), json_encode($state), $mime, $u['id']]);
            if (!$last) {
                return ['received' => $received + strlen($bytes), 'done' => false];
            }
            $store->complete($u['object_key'], $state['s']);
            $node = $this->finish(['mime' => $mime] + $u, $state, $user, $link);
            return ['received' => $size, 'done' => true, 'file' => $node];
        });
    }

    /** The upload is complete: a new file in its folder, or a new version of one. */
    private function finish(array $u, array $state, ?array $user, ?array $link): array
    {
        $db = $this->app->db;
        $now = App::now();
        $name = (string) $this->c()->decrypt($u['name_enc'], 'files.name');
        $nodeId = $u['node_id'] ? (int) $u['node_id'] : null;
        if (!$nodeId) {
            $parentId = (int) $u['parent_id'] ?: null;
            $name = $this->freeName($this->siblingNames(['id' => (int) $state['owner']], $parentId, (bool) $state['vault']), $name);
            $nodeId = $db->insert('INSERT INTO {file_nodes} (owner_id, parent_id, kind, vault, name_enc, mime, size, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$state['owner'], $parentId, 'file', (int) $state['vault'], $this->c()->encrypt($name, 'files.name'), $u['mime'], $u['size'], $user['id'] ?? null, $now, $now]);
        }
        $versionId = $db->insert('INSERT INTO {file_versions} (node_id, store, object_key, key_enc, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$nodeId, $u['store'], $u['object_key'], $u['key_enc'], $u['size'], $user['id'] ?? null, $now]);
        $db->run('UPDATE {file_nodes} SET version_id = ?, size = ?, mime = ?, updated_at = ? WHERE id = ?', [$versionId, $u['size'], $u['mime'], $now, $nodeId]);
        $db->run('DELETE FROM {file_uploads} WHERE id = ?', [$u['id']]);
        $this->pruneVersions($nodeId);
        $this->log($u['node_id'] ? 'version' : 'upload', $nodeId, $user, ['name' => $name], $link);
        $node = $this->node($nodeId);
        return $this->item($node, $user ? $this->role($user, $node) : null);
    }

    /** Keep the newest versions only (Settings → Files). */
    private function pruneVersions(int $nodeId): void
    {
        $keep = $this->settings()['versions'];
        foreach (array_slice($this->app->db->all('SELECT id, store, object_key FROM {file_versions} WHERE node_id = ? ORDER BY id DESC', [$nodeId]), $keep) as $v) {
            $this->deleteObject($v['store'], $v['object_key']);
            $this->app->db->run('DELETE FROM {file_versions} WHERE id = ?', [$v['id']]);
        }
    }

    /** A whole file at once (an attachment saved from an email, a copy): stored like an upload. */
    public function storeBytes(array $user, ?int $parentId, string $name, string $bytes, ?string $mime = null): array
    {
        $start = $this->startUpload($user, $parentId, $name, strlen($bytes));
        if (!empty($start['done'])) {
            return $start['file'];
        }
        $r = [];
        foreach (str_split($bytes, self::UPLOAD_PIECE) as $i => $piece) {
            $r = $this->appendUpload($user, $start['upload'], $i * self::UPLOAD_PIECE, $piece);
        }
        return $r['file'];
    }

    /** The type from the file's first bytes (not what the browser claims), else from its extension. */
    public static function sniff(string $head, string $name): string
    {
        $ext = self::ext($name);
        if ($head !== '' && class_exists(\finfo::class)) {
            $t = (new \finfo(FILEINFO_MIME_TYPE))->buffer(substr($head, 0, 65536));
            if (is_string($t) && $t !== '' && $t !== 'application/octet-stream' && !($t === 'text/plain' && in_array($ext, ['csv', 'md', 'json', 'log'], true))) {
                return substr($t, 0, 127);
            }
        }
        $map = ['pdf' => 'application/pdf', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp',
            'txt' => 'text/plain', 'csv' => 'text/csv', 'md' => 'text/markdown', 'json' => 'application/json', 'log' => 'text/plain', 'mp4' => 'video/mp4', 'mp3' => 'audio/mpeg',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'zip' => 'application/zip'];
        return $map[$ext] ?? 'application/octet-stream';
    }

    // ------------------------------------------------------------------------------------------------ reading

    public function currentVersion(array $node, ?int $versionId = null): array
    {
        $v = $versionId
            ? $this->app->db->one('SELECT * FROM {file_versions} WHERE id = ? AND node_id = ?', [$versionId, $node['id']])
            : ($node['version_id'] ? $this->app->db->one('SELECT * FROM {file_versions} WHERE id = ?', [$node['version_id']]) : null);
        if (!$v) {
            throw new HttpError(404, "That file's contents aren't there.", 'no_version');
        }
        return $v;
    }

    /** Bytes $start…$end (inclusive) of a stored version, decrypted, handed to $out a window at a time. */
    public function readRange(array $version, int $start, int $end, callable $out): void
    {
        $size = (int) $version['size'];
        $key = FileCrypto::unwrap($this->c(), $version['key_enc']);
        $store = $this->store($version['store']);
        $chunks = FileCrypto::chunks($size);
        $sealedChunk = FileCrypto::CHUNK + FileCrypto::TAG;
        $first = intdiv($start, FileCrypto::CHUNK);
        $lastChunk = $size === 0 ? 0 : intdiv($end, FileCrypto::CHUNK);
        for ($i = $first; $i <= $lastChunk; $i += self::READ_CHUNKS) {
            $n = min(self::READ_CHUNKS, $lastChunk - $i + 1);
            $offset = $i * $sealedChunk;
            $length = min($n * $sealedChunk, FileCrypto::storedSize($size) - $offset);
            $sealed = $store->read($version['object_key'], $offset, $length);
            for ($j = 0; $j < $n; $j++) {
                $index = $i + $j;
                $plain = FileCrypto::openChunk($key, $version['object_key'], $index, substr($sealed, $j * $sealedChunk, $sealedChunk), $index === $chunks - 1);
                $from = $index === $first ? $start - $index * FileCrypto::CHUNK : 0;
                $to = $index === $lastChunk ? $end - $index * FileCrypto::CHUNK : FileCrypto::CHUNK - 1;
                $out(substr($plain, $from, $to - $from + 1));
            }
        }
    }

    /** A whole (smallish) file in memory: for attaching to an email or a ZIP. */
    public function readAll(array $version): string
    {
        if ((int) $version['size'] > self::MAX_IN_MEMORY) {
            throw new HttpError(413, 'That file is too big to use this way (over ' . self::human(self::MAX_IN_MEMORY) . '). Download it instead.', 'too_big');
        }
        $buf = '';
        if ((int) $version['size'] > 0) {
            $this->readRange($version, 0, (int) $version['size'] - 1, function (string $s) use (&$buf) {
                $buf .= $s;
            });
        }
        return $buf;
    }

    /**
     * Send a file: as a download, or shown in the page (only types that can't run script, in a sandbox). Supports one
     * byte range (Range: bytes=…), so videos seek and large PDFs open quickly. Ends the request.
     */
    public function send(array $node, array $version, bool $inline, ?string $range = null): never
    {
        $size = (int) $version['size'];
        $name = $this->name($node);
        $mime = $node['mime'] ?: 'application/octet-stream';
        $show = $inline && (in_array($mime, self::INLINE, true) || str_starts_with($mime, 'text/'));
        $type = $show ? (str_starts_with($mime, 'text/') ? 'text/plain; charset=utf-8' : $mime) : 'application/octet-stream';
        [$start, $end] = [0, max(0, $size - 1)];
        $partial = false;
        if ($range && $size > 0 && preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m) && ($m[1] !== '' || $m[2] !== '')) {
            if ($m[1] === '') {
                $start = max(0, $size - (int) $m[2]);
            } else {
                $start = (int) $m[1];
                $end = $m[2] === '' ? $size - 1 : min((int) $m[2], $size - 1);
            }
            if ($start > $end || $start >= $size) {
                http_response_code(416);
                header("Content-Range: bytes */$size");
                exit;
            }
            $partial = true;
        }
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        session_write_close();
        http_response_code($partial ? 206 : 200);
        header("Content-Type: $type");
        header('Content-Length: ' . ($size === 0 ? 0 : $end - $start + 1));
        header('Accept-Ranges: bytes');
        header('Cache-Control: private, no-store');
        header('X-Content-Type-Options: nosniff');
        $ascii = preg_replace('/[^\w.\- ()]+/u', '_', $name) ?: 'file';
        header(($show ? 'Content-Disposition: inline' : 'Content-Disposition: attachment') . "; filename=\"$ascii\"; filename*=UTF-8''" . rawurlencode($name));
        if ($show) {
            // Framed by the webmail's own preview only. Not PDFs: browsers' PDF viewers don't run in a sandbox.
            header('X-Frame-Options: SAMEORIGIN');
            header($mime === 'application/pdf' ? "Content-Security-Policy: default-src 'none'; frame-ancestors 'self'"
                : "Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'");
        }
        if ($partial) {
            header("Content-Range: bytes $start-$end/$size");
        }
        if ($size > 0 && ($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
            set_time_limit(0);
            $this->readRange($version, $start, $end, function (string $s) {
                echo $s;
                flush();
            });
        }
        exit;
    }

    /** A folder as a ZIP, streamed. Files over 50 MB (or 1 GB in all) are too much for one go: they're downloaded singly. */
    public function zip(array $user, int $id): never
    {
        $folder = $this->need($user, $id);
        if ($folder['kind'] !== 'folder' || $folder['vault']) {
            throw new HttpError(422, 'Only folders outside the vault can be downloaded as a ZIP.', 'bad_zip');
        }
        $files = [];
        $walk = function (int $parent, string $prefix) use (&$walk, &$files) {
            foreach ($this->app->db->all('SELECT * FROM {file_nodes} WHERE parent_id = ? AND trashed_at IS NULL', [$parent]) as $n) {
                $path = $prefix . $this->name($n);
                $n['kind'] === 'folder' ? $walk((int) $n['id'], "$path/") : $files[] = [$n, $path];
            }
        };
        $walk((int) $folder['id'], '');
        $total = array_sum(array_map(fn ($f) => (int) $f[0]['size'], $files));
        foreach ($files as [$n]) {
            if ((int) $n['size'] > self::MAX_IN_MEMORY || $total > 1024 * 1024 * 1024) {
                throw new HttpError(413, 'This folder has files too big to put in one ZIP. Download them one at a time.', 'too_big');
            }
        }
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        session_write_close();
        set_time_limit(0);
        $name = $this->name($folder);
        header('Content-Type: application/zip');
        header('Cache-Control: private, no-store');
        header("Content-Disposition: attachment; filename=\"" . (preg_replace('/[^\w.\- ()]+/u', '_', $name) ?: 'folder') . ".zip\"; filename*=UTF-8''" . rawurlencode("$name.zip"));
        $out = fopen('php://output', 'wb');
        $zip = new Zip($out);
        foreach ($files as [$n, $path]) {
            $zip->add($path, $this->readAll($this->currentVersion($n)), strtotime($n['updated_at'] . ' UTC'));
        }
        $zip->finish();
        $this->log('zip', (int) $folder['id'], $user);
        exit;
    }

    // ------------------------------------------------------------------------------------------------ versions

    public function versions(array $user, int $id): array
    {
        $node = $this->need($user, $id);
        $people = $this->people();
        return array_map(fn ($v) => ['id' => (int) $v['id'], 'size' => (int) $v['size'], 'current' => (int) $v['id'] === (int) $node['version_id'],
            'at' => gmdate('c', strtotime($v['created_at'] . ' UTC')), 'by' => $v['created_by'] ? ($people[(int) $v['created_by']]['name'] ?? null) : 'Someone with a link'],
            $this->app->db->all('SELECT * FROM {file_versions} WHERE node_id = ? ORDER BY id DESC', [$id]));
    }

    /** An earlier version becomes the current one (the others stay). */
    public function restoreVersion(array $user, int $id, int $versionId): array
    {
        $node = $this->need($user, $id, 'editor');
        $v = $this->currentVersion($node, $versionId);
        $this->app->db->run('UPDATE {file_nodes} SET version_id = ?, size = ?, updated_at = ? WHERE id = ?', [$v['id'], $v['size'], App::now(), $id]);
        $this->log('version_restore', $id, $user);
        return $this->item($this->node($id), $node['role']);
    }

    // ------------------------------------------------------------------------------------------------ sharing with people

    public function shares(array $user, int $id): array
    {
        $node = $this->need($user, $id);
        if ($node['vault']) {
            return ['people' => [], 'links' => []];
        }
        $rows = $this->app->db->all('SELECT * FROM {file_shares} WHERE node_id = ? ORDER BY id', [$id]);
        $people = $this->people();
        $boxes = [];
        foreach ((new Mailstore($this->app))->allMailboxes() as $m) {
            $boxes[(int) $m['id']] = $m['address'];
        }
        return ['people' => array_map(fn ($s) => ['id' => (int) $s['id'], 'role' => $s['role'],
            'user_id' => $s['user_id'] ? (int) $s['user_id'] : null, 'mailbox_id' => $s['mailbox_id'] ? (int) $s['mailbox_id'] : null,
            'label' => $s['user_id'] ? ($people[(int) $s['user_id']]['name'] ?? 'Someone') : 'Everyone with ' . ($boxes[(int) $s['mailbox_id']] ?? 'a mailbox')], $rows),
            'links' => (new FileLinks($this->app))->forNode($user, $node)];
    }

    /** Who can be chosen: the webmail's people, and its mailboxes (everyone who reads one). */
    public function shareCandidates(): array
    {
        $users = [];
        foreach ($this->people() as $id => $p) {
            $users[] = ['id' => $id, 'name' => $p['name'], 'email' => $p['email']];
        }
        usort($users, fn ($a, $b) => strcasecmp($a['name'], $b['name']));
        return ['users' => $users,
            'mailboxes' => array_map(fn ($m) => ['id' => (int) $m['id'], 'address' => $m['address']], (new Mailstore($this->app))->allMailboxes())];
    }

    public function share(array $user, int $id, ?int $userId, ?int $mailboxId, string $role): array
    {
        $node = $this->need($user, $id, 'editor');
        if ($node['vault']) {
            throw new HttpError(422, "Vault files can't be shared: only you can open them.", 'vault');
        }
        if (!in_array($role, ['viewer', 'editor'], true) || (!$userId === !$mailboxId)) {
            throw new HttpError(422, 'Choose a person or a mailbox, and whether they can view or edit.', 'bad_share');
        }
        if ($userId && ($userId === (int) $node['owner_id'] || !$this->app->db->value('SELECT 1 FROM {users} WHERE id = ?', [$userId]))) {
            throw new HttpError(422, $userId === (int) $node['owner_id'] ? "It's theirs already." : "That person isn't here.", 'bad_share');
        }
        if ($mailboxId && !$this->app->db->value('SELECT 1 FROM {mailboxes} WHERE id = ?', [$mailboxId])) {
            throw new HttpError(422, "That mailbox isn't here.", 'bad_share');
        }
        $existing = $this->app->db->value('SELECT id FROM {file_shares} WHERE node_id = ? AND ' . ($userId ? 'user_id = ?' : 'mailbox_id = ?'), [$id, $userId ?: $mailboxId]);
        if ($existing) {
            $this->app->db->run('UPDATE {file_shares} SET role = ? WHERE id = ?', [$role, $existing]);
        } else {
            $this->app->db->insert('INSERT INTO {file_shares} (node_id, user_id, mailbox_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [$id, $userId, $mailboxId, $role, $user['id'], App::now()]);
        }
        $this->log('share', $id, $user, ['with' => $userId ? "user:$userId" : "mailbox:$mailboxId", 'role' => $role]);
        $this->roles = [];
        return $this->shares($user, $id);
    }

    public function unshare(array $user, int $shareId): void
    {
        $s = $this->app->db->one('SELECT * FROM {file_shares} WHERE id = ?', [$shareId]);
        if (!$s) {
            throw new HttpError(404, 'Already removed.', 'not_found');
        }
        // Anyone who can edit may remove sharing; and people can remove themselves.
        if ((int) $s['user_id'] !== (int) $user['id']) {
            $this->need($user, (int) $s['node_id'], 'editor');
        }
        $this->app->db->run('DELETE FROM {file_shares} WHERE id = ?', [$shareId]);
        $this->log('unshare', (int) $s['node_id'], $user);
        $this->roles = [];
    }

    // ------------------------------------------------------------------------------------------------ activity

    public function log(string $action, ?int $nodeId, ?array $user, array $detail = [], ?array $link = null): void
    {
        $owner = $nodeId ? $this->app->db->value('SELECT owner_id FROM {file_nodes} WHERE id = ?', [$nodeId]) : null;
        $this->app->db->insert('INSERT INTO {file_activity} (at, node_id, owner_id, user_id, link_id, action, detail_enc, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [App::now(), $nodeId, $owner, $user['id'] ?? null, $link['id'] ?? null, $action, $detail ? $this->c()->encryptJson($detail, 'files.activity') : null, Http::ip() ?: null]);
    }

    /** What happened to a file or folder (anyone who can see it), or across one person's files. */
    public function activity(array $user, ?int $id): array
    {
        $rows = $id
            ? ($this->need($user, $id) ? $this->app->db->all('SELECT * FROM {file_activity} WHERE node_id = ? ORDER BY id DESC LIMIT 100', [$id]) : [])
            : $this->app->db->all('SELECT * FROM {file_activity} WHERE owner_id = ? ORDER BY id DESC LIMIT 100', [$user['id']]);
        $people = $this->people();
        return array_map(fn ($r) => ['at' => gmdate('c', strtotime($r['at'] . ' UTC')), 'action' => $r['action'], 'node_id' => $r['node_id'] ? (int) $r['node_id'] : null,
            'by' => $r['user_id'] ? ($people[(int) $r['user_id']]['name'] ?? 'Someone') : ($r['link_id'] ? 'Someone with a link' : null),
            'detail' => $r['detail_enc'] ? $this->c()->decryptJson($r['detail_enc'], 'files.activity') : null], $rows);
    }

    // ------------------------------------------------------------------------------------------------ housekeeping

    /** With the due work: the bin and old activity emptied, abandoned uploads tidied. */
    public function cleanup(): void
    {
        $db = $this->app->db;
        $days = $this->settings()['trash_days'];
        foreach ($db->all('SELECT id FROM {file_nodes} WHERE trash_root = 1 AND trashed_at < ? LIMIT 200', [gmdate('Y-m-d H:i:s', time() - $days * 86400)]) as $r) {
            $this->deleteTree((int) $r['id']);
        }
        foreach ($db->all('SELECT * FROM {file_uploads} WHERE created_at < ? LIMIT 200', [gmdate('Y-m-d H:i:s', time() - 86400)]) as $u) {
            try {
                $this->store($u['store'])->abort($u['object_key'], json_decode((string) $u['state'], true)['s'] ?? []);
            } catch (\Throwable) {
                // Nothing to tidy.
            }
            $db->run('DELETE FROM {file_uploads} WHERE id = ?', [$u['id']]);
        }
        $db->run('DELETE FROM {file_activity} WHERE at < ?', [gmdate('Y-m-d H:i:s', time() - 90 * 86400)]);
    }

    public function cleanupDue(): bool
    {
        return (bool) $this->app->db->value('SELECT 1 FROM {file_uploads} WHERE created_at < ? LIMIT 1', [gmdate('Y-m-d H:i:s', time() - 86400)])
            || (bool) $this->app->db->value('SELECT 1 FROM {file_nodes} WHERE trash_root = 1 AND trashed_at < ? LIMIT 1', [gmdate('Y-m-d H:i:s', time() - $this->settings()['trash_days'] * 86400)]);
    }

    /**
     * Moving stored files to the store new files go to (after switching between this server and S3), a few at a
     * time with the due work. Each is copied, checked, switched over, then deleted from where it was.
     */
    public function moveStep(int $seconds = 15): array
    {
        $target = $this->settings()['store'];
        $until = microtime(true) + $seconds;
        $moved = 0;
        while (microtime(true) < $until) {
            $v = $this->app->db->one('SELECT * FROM {file_versions} WHERE store <> ? ORDER BY id LIMIT 1', [$target]);
            if (!$v) {
                break;
            }
            $from = $this->store($v['store']);
            $to = $this->store($target);
            $stored = FileCrypto::storedSize((int) $v['size']);
            $state = $to->begin($v['object_key']);
            $part = 1;
            // Copied as stored (still encrypted), in upload-sized parts.
            $step = self::UPLOAD_PIECE + intdiv(self::UPLOAD_PIECE, FileCrypto::CHUNK) * FileCrypto::TAG;
            for ($o = 0; $o < $stored; $o += $step, $part++) {
                $state = $to->append($v['object_key'], $state, $from->read($v['object_key'], $o, min($step, $stored - $o)), $part);
            }
            $to->complete($v['object_key'], $state);
            if ($to->size($v['object_key']) !== $stored) {
                throw new \RuntimeException('A moved file came out the wrong size; it was left where it was');
            }
            $this->app->db->run('UPDATE {file_versions} SET store = ? WHERE id = ?', [$target, $v['id']]);
            $this->deleteObject($v['store'], $v['object_key']);
            $moved++;
        }
        return ['moved' => $moved, 'left' => (int) $this->app->db->value('SELECT COUNT(*) FROM {file_versions} WHERE store <> ?', [$target])];
    }

    public function moveDue(): bool
    {
        $s = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'files'"), true);
        return is_array($s) && !empty($s['moving']) && (bool) $this->app->db->value('SELECT 1 FROM {file_versions} WHERE store <> ? LIMIT 1', [$s['store'] ?? 'local']);
    }

    /** Settings → Files: start (or stop) moving existing files to the store new files go to. */
    public function setMoving(bool $on): array
    {
        $raw = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'files'"), true) ?: [];
        $raw['moving'] = $on;
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('files', ?)", [json_encode($raw)]);
        return $this->storeStatus();
    }

    public function storeStatus(): array
    {
        $s = $this->settings();
        $raw = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'files'"), true) ?: [];
        $counts = [];
        foreach ($this->app->db->all('SELECT store, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM {file_versions} GROUP BY store') as $r) {
            $counts[$r['store']] = ['files' => (int) $r['n'], 'bytes' => (int) $r['bytes']];
        }
        return ['store' => $s['store'], 'moving' => !empty($raw['moving']), 'stored' => $counts];
    }

    /** A person is being removed: their files (not their vault, which only they could open) go to someone else. */
    public function handOver(int $fromUserId, int $toUserId): void
    {
        foreach ($this->app->db->all('SELECT id FROM {file_nodes} WHERE owner_id = ? AND vault = 1 AND parent_id IS NULL', [$fromUserId]) as $r) {
            $this->deleteTree((int) $r['id']);
        }
        $tops = $this->app->db->all('SELECT id FROM {file_nodes} WHERE owner_id = ? AND parent_id IS NULL', [$fromUserId]);
        if (!$tops) {
            return;
        }
        $name = $this->freeName($this->siblingNames(['id' => $toUserId], null, false), 'From ' . ($this->people()[$fromUserId]['name'] ?? 'a former colleague'));
        $now = App::now();
        $folder = $this->app->db->insert('INSERT INTO {file_nodes} (owner_id, parent_id, kind, vault, name_enc, created_by, created_at, updated_at) VALUES (?, NULL, ?, 0, ?, ?, ?, ?)',
            [$toUserId, 'folder', $this->c()->encrypt($name, 'files.name'), $toUserId, $now, $now]);
        $this->app->db->run('UPDATE {file_nodes} SET owner_id = ? WHERE owner_id = ?', [$toUserId, $fromUserId]);
        $this->app->db->run('UPDATE {file_nodes} SET parent_id = ? WHERE id IN (' . implode(',', array_map('intval', array_column($tops, 'id'))) . ')', [$folder]);
        $this->app->db->run('DELETE FROM {file_shares} WHERE user_id = ?', [$fromUserId]);
    }
}
