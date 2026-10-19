<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Administration: users, mailboxes and who can use them, and connecting GhostParse addresses (each mailbox is one of
 * the account's addresses, with its webhook pointed at this webmail).
 */
final class Admin
{
    public function __construct(private App $app)
    {
    }

    public function route(string $action, string $method, array $me): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        $store = new Mailstore($this->app);
        switch ("$method $action") {
            case 'GET admin/users':
                Http::json(['users' => $this->users()]);
            case 'POST admin/users':
                $id = (new Auth($this->app))->createUser((string) ($in['email'] ?? ''), (string) ($in['name'] ?? ''), (string) ($in['password'] ?? ''),
                    ($in['role'] ?? 'user') === 'admin' ? 'admin' : 'user');
                foreach ((array) ($in['mailbox_ids'] ?? []) as $mb) {
                    $store->grant($id, (int) $mb);
                }
                Http::json(['id' => $id], 201);
            case 'POST admin/users/update':
                $this->updateUser($me, (int) ($in['id'] ?? 0), $in);
                Http::json(['ok' => true]);
            case 'GET admin/mailboxes':
                Http::json(['mailboxes' => $store->allMailboxes()]);
            case 'GET admin/addresses':
                Http::json(['addresses' => $this->ghostparseAddresses()]);
            case 'POST admin/mailboxes':
                $id = $this->connectAddress((string) ($in['address'] ?? ''), (string) ($in['display_name'] ?? ''));
                $store->grant($me['id'], $id);
                Http::json(['id' => $id], 201);
            case 'POST admin/mailboxes/delete':
                $this->app->db->run('DELETE FROM {mailboxes} WHERE id = ?', [(int) ($in['id'] ?? 0)]);
                Http::json(['ok' => true]);
            case 'GET admin/status':
                Http::json($this->status());
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    public function users(): array
    {
        $c = $this->app->crypto;
        $out = [];
        foreach ($this->app->db->all('SELECT id, email_enc, name_enc, role, disabled, created_at, last_login_at FROM {users} ORDER BY id') as $r) {
            $out[] = ['id' => (int) $r['id'], 'email' => $c->decrypt($r['email_enc'], 'users.email'), 'name' => $c->decrypt($r['name_enc'], 'users.name') ?? '',
                'role' => $r['role'], 'disabled' => (bool) $r['disabled'], 'created_at' => $r['created_at'], 'last_login_at' => $r['last_login_at'],
                'mailbox_ids' => array_map('intval', array_column($this->app->db->all('SELECT mailbox_id FROM {user_mailboxes} WHERE user_id = ?', [$r['id']]), 'mailbox_id'))];
        }
        return $out;
    }

    private function updateUser(array $me, int $id, array $in): void
    {
        $db = $this->app->db;
        if (!$db->value('SELECT id FROM {users} WHERE id = ?', [$id])) {
            throw new HttpError(404, 'User not found', 'not_found');
        }
        if ($id === $me['id'] && ((isset($in['role']) && $in['role'] !== 'admin') || !empty($in['disabled']))) {
            throw new HttpError(422, "You can't remove your own administrator access", 'self');
        }
        if (isset($in['role'])) {
            $db->run('UPDATE {users} SET role = ? WHERE id = ?', [$in['role'] === 'admin' ? 'admin' : 'user', $id]);
        }
        if (isset($in['disabled'])) {
            $db->run('UPDATE {users} SET disabled = ? WHERE id = ?', [$in['disabled'] ? 1 : 0, $id]);
        }
        if (isset($in['name'])) {
            $db->run('UPDATE {users} SET name_enc = ? WHERE id = ?', [$this->app->crypto->encrypt(mb_substr((string) $in['name'], 0, 100), 'users.name'), $id]);
        }
        if (!empty($in['password'])) {
            Auth::checkPassword((string) $in['password']);
            $db->run('UPDATE {users} SET password_hash = ? WHERE id = ?', [Auth::hash((string) $in['password']), $id]);
        }
        if (isset($in['mailbox_ids'])) {
            $db->run('DELETE FROM {user_mailboxes} WHERE user_id = ?', [$id]);
            foreach ((array) $in['mailbox_ids'] as $mb) {
                (new Mailstore($this->app))->grant($id, (int) $mb);
            }
        }
    }

    public function changePassword(int $userId, string $current, string $new): void
    {
        $hash = (string) $this->app->db->value('SELECT password_hash FROM {users} WHERE id = ?', [$userId]);
        if (!password_verify($current, $hash)) {
            throw new HttpError(422, 'Your current password is wrong', 'wrong_password');
        }
        Auth::checkPassword($new);
        $this->app->db->run('UPDATE {users} SET password_hash = ? WHERE id = ?', [Auth::hash($new), $userId]);
    }

    /** The account's addresses on GhostParse, with whether each is a mailbox here already. */
    public function ghostparseAddresses(): array
    {
        $store = new Mailstore($this->app);
        $out = [];
        foreach ($this->app->gp->domains() as $d) {
            foreach ($d['addresses'] ?? [] as $a) {
                if (!empty($a['is_pattern'])) {
                    continue;
                }
                $out[] = ['domain_id' => $d['id'], 'address_id' => $a['id'], 'address' => $a['address'], 'can_send' => (bool) $a['can_send'],
                    'can_receive' => (bool) $a['can_receive'], 'sending_ready' => (bool) ($d['sending_ready'] ?? false),
                    'inbound_ready' => (bool) ($d['inbound_ready'] ?? false), 'webhook_url' => $a['webhook_url'] ?? null,
                    'connected' => (bool) $this->app->db->value('SELECT id FROM {mailboxes} WHERE address_bidx = ?', [$store->addressIndex($a['address'])])];
            }
        }
        return $out;
    }

    /**
     * Make one of the account's addresses a mailbox: it receives and sends, and its webhook is this webmail's
     * webhook.php. Other addresses on the account keep using the account's own webhook.
     */
    public function connectAddress(string $address, string $displayName = ''): int
    {
        $address = mb_strtolower(trim($address));
        $match = null;
        foreach ($this->ghostparseAddresses() as $a) {
            if (mb_strtolower($a['address']) === $address) {
                $match = $a;
            }
        }
        if (!$match) {
            throw new HttpError(422, "$address isn't an address on your GhostParse account. Add it under Domains first.", 'unknown_address');
        }
        try {
            $this->app->gp->updateAddress($match['domain_id'], $match['address_id'],
                ['can_send' => true, 'can_receive' => true, 'webhook_url' => $this->app->baseUrl() . '/webhook.php']);
        } catch (GhostParseError $e) {
            throw new HttpError(422, "GhostParse didn't accept the change: {$e->getMessage()}", 'ghostparse_error');
        }
        return (new Mailstore($this->app))->createMailbox($address, $displayName);
    }

    /** What an administrator should know: the GhostParse account, and anything not ready yet. */
    public function status(): array
    {
        $problems = [];
        try {
            $me = $this->app->gp->me();
        } catch (GhostParseError $e) {
            return ['ok' => false, 'problems' => ["Can't reach GhostParse with the API key: {$e->getMessage()}"]];
        }
        foreach ($this->ghostparseAddresses() as $a) {
            if (!$a['connected']) {
                continue;
            }
            if (!$a['inbound_ready']) {
                $problems[] = "{$a['address']}: its domain isn't receiving email yet (check its MX record in GhostParse).";
            }
            if (!$a['sending_ready']) {
                $problems[] = "{$a['address']}: its domain isn't verified for sending yet (check its DNS records in GhostParse).";
            }
            if ($a['webhook_url'] !== $this->app->baseUrl() . '/webhook.php') {
                $problems[] = "{$a['address']}: its webhook doesn't point at this webmail. Connect it again under Settings → Mailboxes.";
            }
        }
        return ['ok' => !$problems, 'account' => $me['account'] ?? null, 'problems' => $problems];
    }
}
