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
            case 'POST admin/users/mfa-reset':
                $id = (int) ($in['id'] ?? 0);
                if ($id === $me['id']) {
                    throw new HttpError(422, "You can't reset your own two-step verification here. Change it under Sign-in & alerts.", 'self');
                }
                (new Mfa($this->app))->reset($id);
                Http::json(['ok' => true]);
            case 'POST admin/users/update':
                $this->updateUser($me, (int) ($in['id'] ?? 0), $in);
                Http::json(['ok' => true]);
            case 'GET admin/mailboxes':
                Http::json(['mailboxes' => $store->allMailboxes()]);
            case 'GET admin/addresses':
                $domains = $this->app->gp->domains();
                // A domain with mailboxes here but receiving off at GhostParse (set up before 1.18.0): turned on, once.
                if ($this->ensureReceiving($domains)) {
                    $domains = $this->app->gp->domains();
                }
                Http::json(['addresses' => $this->ghostparseAddresses($domains), 'domains' => $this->domainSummary($domains)]);
            // Receiving on at GhostParse for one domain, then its DNS checked straight away.
            case 'POST admin/domains/receiving':
                Http::json($this->turnOnReceiving((string) ($in['domain_id'] ?? '')));
            case 'POST admin/domains/verify':
                Http::json($this->checkDomain((string) ($in['domain_id'] ?? '')));
            // A new address at GhostParse, made a mailbox here straight away.
            case 'POST admin/addresses':
                try {
                    $address = Installer::createAddress($this->app->gp, (string) ($in['domain_id'] ?? ''), (string) ($in['local_part'] ?? ''));
                } catch (InstallError $e) {
                    throw new HttpError(422, $e->getMessage(), 'invalid_address');
                }
                $id = $this->connectAddress($address, (string) ($in['display_name'] ?? ''));
                $store->grant($me['id'], $id);
                Http::json(['id' => $id, 'address' => $address], 201);
            case 'POST admin/mailboxes':
                $id = $this->connectAddress((string) ($in['address'] ?? ''), (string) ($in['display_name'] ?? ''));
                $store->grant($me['id'], $id);
                Http::json(['id' => $id], 201);
            case 'POST admin/mailboxes/delete':
                $this->app->db->run('DELETE FROM {mailboxes} WHERE id = ?', [(int) ($in['id'] ?? 0)]);
                Http::json(['ok' => true]);
            case 'GET admin/status':
                Http::json($this->status());
            // Updates: what's newest at GhostParse, and installing it (with the administrator's password).
            case 'GET admin/update':
                Http::json((new Updater($this->app))->check(($_GET['refresh'] ?? '') === '1'));
            case 'POST admin/update':
                (new Auth($this->app))->confirm($me['id'], $in);
                Http::json((new Updater($this->app))->install());
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
                'mailbox_ids' => array_map('intval', array_column($this->app->db->all('SELECT mailbox_id FROM {user_mailboxes} WHERE user_id = ?', [$r['id']]), 'mailbox_id')),
                'two_step' => (new Mfa($this->app))->configured((int) $r['id']),
                'passkeys' => (int) $this->app->db->value('SELECT COUNT(*) FROM {passkeys} WHERE user_id = ?', [$r['id']]),
                'sessions' => (int) $this->app->db->value('SELECT COUNT(*) FROM {sessions} WHERE user_id = ? AND updated_at >= ?', [$r['id'], time() - 30 * 86400]),
                'allowed_ips' => (new Security($this->app))->userRanges((int) $r['id'])];
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
            // A new password signs them out everywhere.
            $db->run('UPDATE {users} SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [Auth::hash((string) $in['password']), $id]);
        }
        if (array_key_exists('allowed_ips', $in)) {
            $ranges = Security::ranges($in['allowed_ips']);
            if ($id === $me['id'] && $ranges && !Security::inRanges(Http::ip(), $ranges)) {
                throw new HttpError(422, 'Your address now (' . Http::ip() . ") isn't in those ranges: you'd be signed out. Add it first.", 'locks_you_out');
            }
            (new Security($this->app))->setUserRanges($id, $ranges);
            // Signed in from elsewhere: those sessions end at their next request (Auth checks every time).
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
        // Signs out the person's other sessions; this one carries on.
        $this->app->db->run('UPDATE {users} SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [Auth::hash($new), $userId]);
        if (($_SESSION['uid'] ?? null) === $userId) {
            $_SESSION['sv'] = (int) $this->app->db->value('SELECT session_version FROM {users} WHERE id = ?', [$userId]);
        }
    }

    /** The account's addresses on GhostParse, with whether each is a mailbox here already. */
    public function ghostparseAddresses(?array $domains = null): array
    {
        $store = new Mailstore($this->app);
        $out = [];
        foreach ($domains ?? $this->app->gp->domains() as $d) {
            foreach ($d['addresses'] ?? [] as $a) {
                if (!empty($a['is_pattern'])) {
                    continue;
                }
                $out[] = ['domain_id' => $d['id'], 'address_id' => $a['id'], 'address' => $a['address'], 'can_send' => (bool) $a['can_send'],
                    'can_receive' => (bool) $a['can_receive'], 'sending_ready' => (bool) ($d['sending_ready'] ?? false),
                    'inbound_ready' => (bool) ($d['inbound_ready'] ?? false), 'inbound_enabled' => (bool) ($d['inbound_enabled'] ?? false),
                    'webhook_url' => $a['webhook_url'] ?? null,
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
        // A mailbox needs its domain to receive: turned on at GhostParse if it isn't. The address is connected either way.
        if (!$match['inbound_enabled']) {
            try {
                $this->app->gp->updateDomain($match['domain_id'], ['inbound_enabled' => true]);
                $this->rememberAuto($match['domain_id']);
            } catch (GhostParseError $e) {
                error_log("webmail: couldn't turn on receiving for {$address}'s domain: {$e->getMessage()}");
            }
        }
        return (new Mailstore($this->app))->createMailbox($address, $displayName);
    }

    /**
     * Each domain, and whether it can receive: receiving switched on at GhostParse, and its MX record pointing there
     * (first in line). `mx` is the record to add, `mailboxes` how many of its addresses are mailboxes here.
     */
    public function domainSummary(array $domains): array
    {
        $connected = [];
        foreach ($this->ghostparseAddresses($domains) as $a) {
            $connected[$a['domain_id']] = ($connected[$a['domain_id']] ?? 0) + ($a['connected'] ? 1 : 0);
        }
        return array_map(function ($d) use ($connected) {
            $mx = null;
            foreach ($d['records'] ?? [] as $r) {
                if (($r['kind'] ?? '') === 'mx') {
                    $mx = $r;
                }
            }
            return ['id' => (string) $d['id'], 'name' => (string) $d['name'], 'ready' => (bool) ($d['inbound_ready'] ?? false),
                'receiving' => (bool) ($d['inbound_enabled'] ?? false), 'mx_ok' => (bool) ($mx['verified'] ?? false),
                'mx' => $mx ? ['host' => (string) ($mx['host'] ?? $d['name']), 'value' => (string) ($mx['value'] ?? ''), 'priority' => (int) ($mx['priority'] ?? 10)] : null,
                'mailboxes' => $connected[$d['id']] ?? 0];
        }, $domains);
    }

    /** Receiving on for one of the account's domains, and its DNS checked now so the answer is current. */
    public function turnOnReceiving(string $domainId): array
    {
        $this->domainOf($domainId);
        try {
            $this->app->gp->updateDomain($domainId, ['inbound_enabled' => true]);
        } catch (GhostParseError $e) {
            throw new HttpError(422, "GhostParse didn't turn receiving on: {$e->getMessage()}", 'ghostparse_error');
        }
        return $this->checkDomain($domainId);
    }

    /** GhostParse looks up the domain's DNS now: the domain as it stands, and what's wrong with its MX record, if anything. */
    public function checkDomain(string $domainId): array
    {
        $this->domainOf($domainId);
        try {
            $r = $this->app->gp->verifyDomain($domainId);
        } catch (GhostParseError $e) {
            throw new HttpError(422, "GhostParse couldn't check the domain: {$e->getMessage()}", 'ghostparse_error');
        }
        $mx = $r['checks']['mx'] ?? null;
        return ['domain' => $this->domainSummary([$r['domain'] ?? []] )[0] ?? null,
            'mx' => $mx ? ['ok' => (bool) $mx['ok'], 'found' => $mx['found'] ?? [], 'error' => $mx['error'] ?? null] : null];
    }

    private function domainOf(string $domainId): array
    {
        foreach ($this->app->gp->domains() as $d) {
            if ((string) $d['id'] === $domainId) {
                return $d;
            }
        }
        throw new HttpError(404, "That domain isn't on your GhostParse account.", 'unknown_domain');
    }

    /**
     * Domains with mailboxes here whose receiving is off at GhostParse are turned on, once each: if someone turns it off
     * again in GhostParse afterwards, that's their choice and it stays off. Returns the names turned on.
     */
    public function ensureReceiving(?array $domains = null): array
    {
        $domains ??= $this->app->gp->domains();
        $done = $this->autoDomains();
        $turned = [];
        foreach ($this->domainSummary($domains) as $d) {
            if ($d['receiving'] || !$d['mailboxes'] || in_array($d['id'], $done, true)) {
                continue;
            }
            try {
                $this->app->gp->updateDomain($d['id'], ['inbound_enabled' => true]);
                $turned[] = $d['name'];
            } catch (GhostParseError $e) {
                error_log("webmail: couldn't turn on receiving for {$d['name']}: {$e->getMessage()}");
            }
            $this->rememberAuto($d['id']);
        }
        return $turned;
    }

    private function autoDomains(): array
    {
        $v = json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'receiving_auto'"), true);
        return is_array($v) ? $v : [];
    }

    private function rememberAuto(string $domainId): void
    {
        $ids = array_values(array_unique([...$this->autoDomains(), $domainId]));
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('receiving_auto', ?)", [json_encode($ids)]);
    }

    /** What an administrator should know: the GhostParse account, and anything not ready yet. */
    public function status(): array
    {
        $problems = [];
        try {
            $me = $this->app->gp->me();
            $this->ensureReceiving();
        } catch (GhostParseError $e) {
            return ['ok' => false, 'problems' => ["Can't reach GhostParse with the API key: {$e->getMessage()}"]];
        }
        foreach ($this->ghostparseAddresses() as $a) {
            if (!$a['connected']) {
                continue;
            }
            if (!$a['inbound_ready']) {
                $problems[] = $a['inbound_enabled']
                    ? "{$a['address']}: its domain isn't receiving email yet: its MX record has to point at GhostParse, first in line (Settings → Connect addresses)."
                    : "{$a['address']}: receiving is switched off for its domain at GhostParse. Turn it on under Settings → Connect addresses.";
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
