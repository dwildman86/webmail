<?php
declare(strict_types=1);

namespace Webmail;

/**
 * The private vault: a part of Files encrypted in the browser, with a key the server never sees.
 *
 * The browser makes a random vault key and wraps it with each way of opening the vault: a passphrase (PBKDF2), a
 * passkey (the WebAuthn PRF extension: a secret only that passkey can produce) and a recovery key shown once. Only
 * those wrapped copies are kept here. Files and their names are encrypted in the browser before they're uploaded (and
 * then encrypted again at rest like any file). Nobody else, not an administrator, not GhostParse, can open them; if
 * every way in is lost, so are the files. Vault files can't be shared, linked, searched or previewed by the server.
 */
final class Vault
{
    private const METHODS = ['passphrase', 'passkey', 'recovery'];

    public function __construct(private App $app)
    {
    }

    private function rows(int $userId): array
    {
        return $this->app->db->all('SELECT * FROM {vault_keys} WHERE user_id = ? ORDER BY id', [$userId]);
    }

    /** Whether there's a vault, its ways in (not the keys), and the passkeys that could be one. */
    public function status(array $user): array
    {
        $c = $this->app->crypto;
        return [
            'set_up' => (bool) $this->rows((int) $user['id']),
            'methods' => array_map(fn ($r) => ['id' => (int) $r['id'], 'method' => $r['method'], 'label' => $r['label'], 'credential_id' => $r['credential_id'],
                'created_at' => gmdate('c', strtotime($r['created_at'] . ' UTC'))], $this->rows((int) $user['id'])),
            'passkeys' => array_map(fn ($p) => ['credential_id' => $c->decrypt($p['credential_id_enc'], 'passkeys.credential_id'),
                'name' => $p['name_enc'] ? $c->decrypt($p['name_enc'], 'passkeys.name') : null],
                $this->app->db->all('SELECT credential_id_enc, name_enc FROM {passkeys} WHERE user_id = ?', [$user['id']])),
        ];
    }

    /** The wrapped vault key for each way in: the browser unwraps one. */
    public function keys(array $user): array
    {
        return array_map(fn ($r) => ['id' => (int) $r['id'], 'method' => $r['method'], 'credential_id' => $r['credential_id'], 'wrapped' => $r['wrapped']],
            $this->rows((int) $user['id']));
    }

    private function clean(array $m): array
    {
        $method = (string) ($m['method'] ?? '');
        $wrapped = (string) ($m['wrapped'] ?? '');
        if (!in_array($method, self::METHODS, true) || $wrapped === '' || strlen($wrapped) > 4000 || !json_decode($wrapped, true)) {
            throw new HttpError(422, "That way of opening the vault wasn't sent properly.", 'bad_vault');
        }
        $cred = $method === 'passkey' ? (string) ($m['credential_id'] ?? '') : null;
        if ($method === 'passkey' && !preg_match('/^[A-Za-z0-9_-]{16,255}$/', $cred)) {
            throw new HttpError(422, 'That passkey wasn\'t recognised.', 'bad_vault');
        }
        return ['method' => $method, 'wrapped' => $wrapped, 'credential_id' => $cred, 'label' => mb_substr(trim((string) ($m['label'] ?? '')), 0, 100) ?: null];
    }

    /** First time: a recovery key and at least one everyday way in (passphrase or passkey). Its top folder is made too. */
    public function setup(array $user, array $methods): array
    {
        if ($this->rows((int) $user['id'])) {
            throw new HttpError(409, 'You have a vault already.', 'vault_exists');
        }
        $methods = array_map(fn ($m) => $this->clean((array) $m), $methods);
        $kinds = array_column($methods, 'method');
        if (!in_array('recovery', $kinds, true) || !array_intersect(['passphrase', 'passkey'], $kinds) || count($methods) > 10) {
            throw new HttpError(422, 'A vault needs a recovery key and a passphrase or passkey.', 'bad_vault');
        }
        $this->app->db->tx(function () use ($user, $methods) {
            foreach ($methods as $m) {
                $this->insert((int) $user['id'], $m);
            }
        });
        return $this->status($user);
    }

    private function insert(int $userId, array $m): void
    {
        $this->app->db->insert('INSERT INTO {vault_keys} (user_id, method, credential_id, label, wrapped, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [$userId, $m['method'], $m['credential_id'], $m['label'], $m['wrapped'], App::now()]);
    }

    /** Another way in (wrapped in the browser, with the vault open). One passphrase and one recovery key at a time. */
    public function add(array $user, array $m): array
    {
        if (!$this->rows((int) $user['id'])) {
            throw new HttpError(404, "You don't have a vault yet.", 'no_vault');
        }
        $m = $this->clean($m);
        if ($m['method'] !== 'passkey') {
            $this->app->db->run('DELETE FROM {vault_keys} WHERE user_id = ? AND method = ?', [$user['id'], $m['method']]);
        } else {
            $this->app->db->run('DELETE FROM {vault_keys} WHERE user_id = ? AND method = ? AND credential_id = ?', [$user['id'], 'passkey', $m['credential_id']]);
        }
        $this->insert((int) $user['id'], $m);
        return $this->status($user);
    }

    /** One way in removed: never the recovery key, nor the last everyday way in. */
    public function remove(array $user, int $id): array
    {
        $rows = $this->rows((int) $user['id']);
        $row = current(array_filter($rows, fn ($r) => (int) $r['id'] === $id));
        if (!$row) {
            throw new HttpError(404, 'Already removed.', 'not_found');
        }
        $everyday = array_filter($rows, fn ($r) => $r['method'] !== 'recovery');
        if ($row['method'] === 'recovery' || count($everyday) <= 1) {
            throw new HttpError(422, $row['method'] === 'recovery' ? 'The recovery key stays: make a new one instead.' : 'Keep at least one passphrase or passkey.', 'last_method');
        }
        $this->app->db->run('DELETE FROM {vault_keys} WHERE id = ?', [$id]);
        return $this->status($user);
    }

    /** Start again: the vault and everything in it deleted (it can't be opened without a way in). */
    public function reset(array $user): void
    {
        $files = new Files($this->app);
        foreach ($this->app->db->all('SELECT id FROM {file_nodes} WHERE owner_id = ? AND vault = 1 AND parent_id IS NULL', [$user['id']]) as $r) {
            $files->deleteForever($user, (int) $r['id']);
        }
        $this->app->db->run('DELETE FROM {vault_keys} WHERE user_id = ?', [$user['id']]);
        $files->log('vault_reset', null, $user);
    }
}
