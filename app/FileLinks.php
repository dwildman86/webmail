<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Share links for Files: anyone with the link can view and download a file or folder ('view'), or send files into a
 * folder ('request', a file request). Off until an administrator turns them on (Settings → Files), and only while the
 * GhostParse plan includes Files. Each can have a password, an expiry and a download limit, and can be revoked.
 * Tokens are 256-bit random; only their hash is looked up (the link itself is kept encrypted, to copy again).
 */
final class FileLinks
{
    public function __construct(private App $app)
    {
    }

    private function files(): Files
    {
        return new Files($this->app);
    }

    public function create(array $user, int $nodeId, string $kind, ?string $password, ?int $days, ?int $maxDownloads): array
    {
        $files = $this->files();
        $s = $files->settings();
        if (!$s['links']) {
            throw new HttpError(403, 'Share links are turned off. An administrator can turn them on in Settings → Files.', 'links_off');
        }
        if (!$files->allowed()) {
            throw new HttpError(402, 'Share links need an active GhostParse plan.', 'files_plan');
        }
        $node = $files->need($user, $nodeId, 'editor');
        if ($node['vault']) {
            throw new HttpError(422, "Vault files can't be shared: only you can open them.", 'vault');
        }
        if (!in_array($kind, ['view', 'request'], true) || ($kind === 'request' && $node['kind'] !== 'folder')) {
            throw new HttpError(422, 'A file request needs a folder for the files to go in.', 'bad_link');
        }
        $password = $password !== null && $password !== '' ? $password : null;
        if ($s['links_password'] && $password === null) {
            throw new HttpError(422, 'Your organisation asks for a password on every share link.', 'password_required');
        }
        if ($password !== null && mb_strlen($password) < 6) {
            throw new HttpError(422, 'Use a password of at least 6 characters.', 'weak_password');
        }
        $max = (int) $s['links_max_days'];
        $days = $days ?: ($max ?: null);
        if ($days !== null && ($days < 1 || ($max && $days > $max))) {
            throw new HttpError(422, "Links can last up to $max days.", 'bad_expiry');
        }
        if ($maxDownloads !== null && ($maxDownloads < 1 || $maxDownloads > 100000)) {
            throw new HttpError(422, 'Choose a download limit from 1 to 100,000, or none.', 'bad_limit');
        }
        $token = sodium_bin2base64(random_bytes(32), SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        $id = $this->app->db->insert('INSERT INTO {file_links} (node_id, token_hash, token_enc, kind, password_hash, expires_at, max_downloads, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            $nodeId, hash('sha256', $token), $this->app->crypto->encrypt($token, 'files.link'), $kind,
            $password !== null ? sodium_crypto_pwhash_str($password, SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE, SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE) : null,
            $days ? gmdate('Y-m-d H:i:s', time() + $days * 86400) : null, $maxDownloads, $user['id'], App::now()]);
        $files->log('link', $nodeId, $user, ['kind' => $kind, 'password' => $password !== null, 'days' => $days]);
        return $this->present($this->app->db->one('SELECT * FROM {file_links} WHERE id = ?', [$id]));
    }

    public function url(string $token): string
    {
        return $this->app->baseUrl() . '/share.php?t=' . $token;
    }

    private function present(array $l): array
    {
        return ['id' => (int) $l['id'], 'kind' => $l['kind'], 'url' => $this->url((string) $this->app->crypto->decrypt($l['token_enc'], 'files.link')),
            'password' => $l['password_hash'] !== null, 'expires_at' => $l['expires_at'] ? gmdate('c', strtotime($l['expires_at'] . ' UTC')) : null,
            'max_downloads' => $l['max_downloads'] !== null ? (int) $l['max_downloads'] : null, 'downloads' => (int) $l['downloads'],
            'expired' => ($l['expires_at'] && strtotime($l['expires_at'] . ' UTC') < time()) || ($l['max_downloads'] !== null && (int) $l['downloads'] >= (int) $l['max_downloads']),
            'created_at' => gmdate('c', strtotime($l['created_at'] . ' UTC'))];
    }

    /** A node's links that still work (or ran out), for those who can edit it. */
    public function forNode(array $user, array $node): array
    {
        if (!in_array($this->files()->role($user, $node), ['owner', 'editor'], true)) {
            return [];
        }
        return array_map(fn ($l) => $this->present($l), $this->app->db->all('SELECT * FROM {file_links} WHERE node_id = ? AND revoked_at IS NULL ORDER BY id DESC', [$node['id']]));
    }

    public function revoke(array $user, int $linkId): void
    {
        $l = $this->app->db->one('SELECT * FROM {file_links} WHERE id = ? AND revoked_at IS NULL', [$linkId]);
        if (!$l) {
            throw new HttpError(404, 'That link is already off.', 'not_found');
        }
        $this->files()->need($user, (int) $l['node_id'], 'editor');
        $this->app->db->run('UPDATE {file_links} SET revoked_at = ? WHERE id = ?', [App::now(), $linkId]);
        $this->files()->log('link_off', (int) $l['node_id'], $user);
    }

    /** Every link to one person's files, at once. Returns how many. */
    public function revokeAll(int $ownerId): int
    {
        return $this->app->db->run('UPDATE {file_links} l JOIN {file_nodes} n ON n.id = l.node_id SET l.revoked_at = ? WHERE n.owner_id = ? AND l.revoked_at IS NULL',
            [App::now(), $ownerId])->rowCount();
    }

    /** php security-reset.php: every share link off. */
    public function revokeEverything(): int
    {
        return $this->app->db->run('UPDATE {file_links} SET revoked_at = ? WHERE revoked_at IS NULL', [App::now()])->rowCount();
    }

    // ------------------------------------------------------------------------------------------------ someone opening a link

    /** The link and its file or folder, if it still works; a reason it doesn't otherwise (shown on the page). */
    public function resolve(string $token): array
    {
        $files = $this->files();
        $l = strlen($token) >= 40 && strlen($token) <= 64 ? $this->app->db->one('SELECT * FROM {file_links} WHERE token_hash = ?', [hash('sha256', $token)]) : null;
        $node = $l ? $files->node((int) $l['node_id']) : null;
        if (!$l || !$node || $l['revoked_at'] || $node['trashed_at'] || $node['vault']) {
            throw new HttpError(404, "This link doesn't work any more: it was turned off, or what it shared was deleted.", 'link_gone');
        }
        if (!$files->settings()['links'] || !$files->allowed()) {
            throw new HttpError(404, "This link doesn't work at the moment.", 'link_gone');
        }
        if ($l['expires_at'] && strtotime($l['expires_at'] . ' UTC') < time()) {
            throw new HttpError(410, 'This link has expired. Ask whoever sent it for a new one.', 'link_expired');
        }
        if ($l['kind'] === 'view' && $l['max_downloads'] !== null && (int) $l['downloads'] >= (int) $l['max_downloads']) {
            throw new HttpError(410, 'This link has been used as many times as it was allowed. Ask whoever sent it for a new one.', 'link_used');
        }
        return [$l + ['owner_id' => (int) $node['owner_id']], $node];
    }

    /** Something under the link's folder (or the linked file itself). */
    public function within(array $link, int $id): array
    {
        $files = $this->files();
        $n = $files->node($id);
        for ($m = $n, $i = 0; $m && $i < 100; $m = $m['parent_id'] ? $files->node((int) $m['parent_id']) : null, $i++) {
            if ((int) $m['id'] === (int) $link['node_id']) {
                if ($n['trashed_at']) {
                    break;
                }
                return $n;
            }
        }
        throw new HttpError(404, "That isn't part of what was shared.", 'not_found');
    }

    private function cookieName(array $link): string
    {
        return 'wmlink' . (int) $link['id'];
    }

    /** Has this visitor given the link's password (in the last hour)? */
    public function unlocked(array $link): bool
    {
        if ($link['password_hash'] === null) {
            return true;
        }
        $c = (string) ($_COOKIE[$this->cookieName($link)] ?? '');
        if (!preg_match('/^(\d+)\.([a-f0-9]{32})$/', $c, $m) || (int) $m[1] < time()) {
            return false;
        }
        return hash_equals(bin2hex($this->app->crypto->blindIndex($link['id'] . '|' . $link['token_hash'] . '|' . $m[1], 'files.unlock')), $m[2]);
    }

    public function unlock(array $link, string $password): bool
    {
        if ($link['password_hash'] === null || !sodium_crypto_pwhash_str_verify($link['password_hash'], $password)) {
            return false;
        }
        $until = time() + 3600;
        setcookie($this->cookieName($link), $until . '.' . bin2hex($this->app->crypto->blindIndex($link['id'] . '|' . $link['token_hash'] . '|' . $until, 'files.unlock')),
            ['expires' => $until, 'path' => parse_url($this->app->baseUrl(), PHP_URL_PATH) . '/share.php', 'secure' => Http::isHttps(), 'httponly' => true, 'samesite' => 'Lax']);
        return true;
    }

    public function counted(array $link): void
    {
        $this->app->db->run('UPDATE {file_links} SET downloads = downloads + 1, last_used_at = ? WHERE id = ?', [App::now(), $link['id']]);
    }

    public function touched(array $link): void
    {
        $this->app->db->run('UPDATE {file_links} SET last_used_at = ? WHERE id = ?', [App::now(), $link['id']]);
    }
}
