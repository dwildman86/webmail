<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Importing email from an old mailbox: over IMAP (any provider that offers it), or from a file (.mbox from Google
 * Takeout, Thunderbird or Apple Mail, or a single .eml). Each message goes through GhostParse's parser (POST
 * /v1/parse: not stored there, not counted), so imported mail looks, searches and threads like new mail.
 *
 * Shared hosting stops a request after 30-60 seconds and often has no cron, so an import runs in short steps that the
 * page keeps asking for while it's open. Each step copies what it can in about 20 seconds and records where it got
 * to (each folder's last UID, or the file's byte offset): close the page and it carries on next time. Running an IMAP
 * import again copies only what's new, which is how the last few emails are caught after the domain's mail moves here.
 */
final class Importer
{
    /** GhostParse's message size limit is 25 MB; leave room. */
    public const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
    /** Upload chunks: under the 32 MB upload limit the webmail asks hosts for. */
    public const CHUNK_BYTES = 8 * 1024 * 1024;
    public const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;
    private const BATCH = 10;

    /** @var \Closure(string, int, string): Imap */
    private \Closure $connect;

    public function __construct(private App $app, ?\Closure $connect = null)
    {
        $this->connect = $connect ?? fn (string $host, int $port, string $security) => new Imap($host, $port, $security);
    }

    // ---------------------------------------------------------------------------------------------- IMAP

    /** Sign-in settings, checked: an internet mail server on port 993 (TLS) or 143 (STARTTLS). */
    public function imapSettings(array $in): array
    {
        $host = strtolower(trim((string) ($in['host'] ?? '')));
        $security = (string) ($in['security'] ?? 'ssl');
        $port = (int) ($in['port'] ?? ($security === 'starttls' ? 143 : 993));
        $s = ['host' => $host, 'port' => $port, 'security' => $security, 'username' => trim((string) ($in['username'] ?? '')), 'password' => (string) ($in['password'] ?? '')];
        $allowPrivate = (bool) $this->app->config->get('import_allow_private', false);
        if (!preg_match($allowPrivate ? '/^[a-z0-9.-]+$/' : '/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/', $host)) {
            throw new HttpError(422, 'Enter the mail server\'s name, like imap.gmail.com or mail.example.com.', 'bad_host');
        }
        if ($s['username'] === '' || $s['password'] === '') {
            throw new HttpError(422, 'Enter the email address (or username) and password for the old mailbox.', 'missing');
        }
        if (!in_array($security, $allowPrivate ? ['ssl', 'starttls', 'none'] : ['ssl', 'starttls'], true)) {
            throw new HttpError(422, 'Choose SSL/TLS or STARTTLS: passwords are never sent unencrypted.', 'bad_security');
        }
        if (!$allowPrivate) {
            if (!in_array($port, [993, 143], true)) {
                throw new HttpError(422, 'Use port 993 (SSL/TLS) or 143 (STARTTLS).', 'bad_port');
            }
            // Only real internet servers: not this server's own network (and whatever else it can reach).
            $ips = @gethostbynamel($host) ?: [];
            if (!$ips) {
                throw new HttpError(422, "Couldn't find a server called $host.", 'bad_host');
            }
            foreach ($ips as $ip) {
                if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                    throw new HttpError(422, "$host is a private address: use your old provider's internet address for IMAP.", 'bad_host');
                }
            }
        }
        return $s;
    }

    private function open(array $s): Imap
    {
        $imap = ($this->connect)($s['host'], (int) $s['port'], $s['security']);
        try {
            $imap->connect();
            if (($s['auth'] ?? 'password') === 'oauth') {
                $imap->loginXoauth2($s['username'], (string) $s['access_token']);
            } else {
                $imap->login($s['username'], $s['password']);
            }
        } catch (ImapError $e) {
            throw new HttpError(422, $e->getMessage(), 'imap_error');
        }
        return $imap;
    }

    /**
     * Settings for a mailbox signed in with Google or Microsoft (as GhostParse's claim returns them). The server is the
     * provider's own.
     */
    public static function oauthSettings(array $claim): array
    {
        if (!in_array($claim['provider'] ?? '', ['google', 'microsoft'], true) || empty($claim['refresh_token']) || empty($claim['email'])) {
            throw new HttpError(422, 'That sign-in didn\'t give access to the mailbox. Sign in again.', 'oauth');
        }
        return ['auth' => 'oauth', 'provider' => $claim['provider'], 'host' => $claim['provider'] === 'google' ? 'imap.gmail.com' : 'outlook.office365.com',
            'port' => 993, 'security' => 'ssl', 'username' => strtolower($claim['email']), 'password' => '',
            'refresh_token' => $claim['refresh_token'], 'access_token' => $claim['access_token'] ?? '', 'expires_at' => time() + (int) ($claim['expires_in'] ?? 0)];
    }

    /** A signed-in mailbox's access token lasts about an hour: refresh it (through GhostParse) when it's nearly out. */
    public function freshen(array &$s): bool
    {
        if (($s['auth'] ?? '') !== 'oauth' || ((int) ($s['expires_at'] ?? 0) > time() + 120 && !empty($s['access_token']))) {
            return false;
        }
        try {
            $t = $this->app->gp->mailOAuthRefresh($s['provider'], $s['refresh_token']);
        } catch (GhostParseError $e) {
            throw new HttpError($e->status === 422 ? 422 : 502, $e->getMessage(), 'oauth');
        }
        $s['access_token'] = $t['access_token'];
        $s['expires_at'] = time() + (int) ($t['expires_in'] ?? 3600);
        if (!empty($t['refresh_token'])) {
            $s['refresh_token'] = $t['refresh_token'];
        }
        return true;
    }

    /** Where a folder's mail goes here, or null to leave it out by default (Trash, Spam, virtual folders). */
    public static function suggestTarget(array $folder): ?string
    {
        $attrs = $folder['attrs'] ?? [];
        $name = mb_strtolower($folder['name']);
        $leaf = preg_replace('/^.*[\/.]/u', '', $name);
        $parent = mb_substr($name, 0, max(0, mb_strlen($name) - mb_strlen($leaf) - 1));
        // Names count only where servers put these folders (the top, or under INBOX or [Gmail]); "Clients/Sent" is the customer's own.
        $standard = in_array($parent, ['', 'inbox', '[gmail]', '[google mail]'], true);
        if (strtoupper($folder['raw']) === 'INBOX') {
            return 'inbox';
        }
        if (array_intersect($attrs, ['\\all', '\\flagged', '\\important'])) {
            return null; // Gmail's All Mail, Starred and Important repeat other folders
        }
        if (in_array('\\sent', $attrs, true) || ($standard && in_array($leaf, ['sent', 'sent items', 'sent messages', 'sent mail', 'gesendet', 'envoyés', 'enviados'], true))) {
            return 'sent';
        }
        if (in_array('\\drafts', $attrs, true) || ($standard && in_array($leaf, ['drafts', 'draft', 'entwürfe', 'brouillons', 'borradores'], true))) {
            return 'drafts';
        }
        if (in_array('\\trash', $attrs, true) || ($standard && in_array($leaf, ['trash', 'deleted items', 'deleted messages', 'bin', 'papierkorb', 'corbeille'], true))) {
            return null;
        }
        if (in_array('\\junk', $attrs, true) || ($standard && in_array($leaf, ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail'], true))) {
            return null;
        }
        return 'archive';
    }

    /** Sign in to the old mailbox and list its folders, with how many messages each has and where they'd go. */
    public function probe(array $in, ?array $oauth = null): array
    {
        $s = $oauth ?? $this->imapSettings($in);
        $this->freshen($s);
        $imap = $this->open($s);
        try {
            $folders = [];
            foreach ($imap->folders() as $f) {
                $count = null;
                try {
                    $count = $imap->examine($f['raw'])['exists'];
                } catch (ImapError) {
                }
                $folders[] = ['raw' => $f['raw'], 'name' => $f['name'], 'count' => $count, 'target' => self::suggestTarget($f)];
            }
        } catch (ImapError $e) {
            throw new HttpError(502, $e->getMessage(), 'imap_error');
        } finally {
            $imap->logout();
        }
        // The inbox first, then Sent, then the rest: the order they're copied in.
        $rank = ['inbox' => 0, 'sent' => 1, 'drafts' => 2, 'archive' => 3];
        usort($folders, fn ($a, $b) => [$rank[$a['target']] ?? 9, $a['name']] <=> [$rank[$b['target']] ?? 9, $b['name']]);
        return ['folders' => $folders];
    }

    /** @param array<int, array{raw: string, target: ?string}> $choices */
    public function startImap(array $user, int $mailboxId, array $in, array $choices, ?array $oauth = null): array
    {
        (new Mailstore($this->app))->mailbox($user['id'], $mailboxId);
        $s = $oauth ?? $this->imapSettings($in);
        $this->freshen($s);
        $folders = [];
        foreach ($choices as $c) {
            $target = $c['target'] ?? null;
            if (in_array($target, ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'], true) && is_string($c['raw'] ?? null)) {
                $folders[] = ['raw' => $c['raw'], 'name' => Imap::decodeName($c['raw']), 'target' => $target, 'uidvalidity' => 0, 'last_uid' => 0, 'total' => null, 'done' => false];
            }
        }
        if (!$folders) {
            throw new HttpError(422, 'Choose at least one folder to copy.', 'no_folders');
        }
        $this->open($s)->logout(); // the sign-in works
        return $this->create($user, $mailboxId, 'imap', $s, ['folders' => $folders]);
    }

    // ---------------------------------------------------------------------------------------------- this hosting account

    /**
     * Where this hosting account keeps its mail: ~/mail/<domain>/<user>/ (cPanel, and most hosts using Dovecot with
     * Maildir). The webmail runs as the account's own user, so it can read them: no password needed.
     */
    private function mailRoot(): ?string
    {
        $configured = $this->app->config->get('maildir_root');
        if (is_string($configured) && $configured !== '') {
            return is_dir($configured) ? rtrim($configured, '/') : null;
        }
        $home = getenv('HOME') ?: '';
        if ($home === '' && function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
            $home = (string) (posix_getpwuid(posix_geteuid())['dir'] ?? '');
        }
        if ($home === '' && preg_match('#^(/home\d*/[^/]+)/#', __DIR__, $m)) {
            $home = $m[1];
        }
        $root = $home !== '' ? "$home/mail" : '';
        return $root !== '' && @is_dir($root) && @is_readable($root) ? $root : null;
    }

    /** A mailbox's Maildir folders: the inbox (the mailbox's own cur/ and new/), then .Sent, .Drafts, .Clients.Projects… */
    private static function maildirFolders(string $path): array
    {
        $folders = [];
        $count = fn (string $dir) => count(array_filter(array_merge(@scandir("$dir/cur") ?: [], @scandir("$dir/new") ?: []), fn ($f) => $f[0] !== '.'));
        if (is_dir("$path/cur") || is_dir("$path/new")) {
            $folders[] = ['raw' => '', 'name' => 'INBOX', 'attrs' => [], 'count' => $count($path)];
        }
        foreach (@scandir($path) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || $entry[0] !== '.' || !is_dir("$path/$entry/cur")) {
                continue;
            }
            $name = 'INBOX' . str_replace('.', '/', $entry); // ".Clients.Projects" is INBOX/Clients/Projects
            $folders[] = ['raw' => $entry, 'name' => Imap::decodeName($name), 'attrs' => [], 'count' => $count("$path/$entry")];
        }
        return $folders;
    }

    /** The mailboxes on this hosting account, with their folders and where each would go. */
    public function localMailboxes(): array
    {
        $root = $this->mailRoot();
        if (!$root) {
            return [];
        }
        $out = [];
        foreach (@scandir($root) ?: [] as $domain) {
            if ($domain[0] === '.' || !str_contains($domain, '.') || !is_dir("$root/$domain")) {
                continue;
            }
            foreach (@scandir("$root/$domain") ?: [] as $local) {
                $path = "$root/$domain/$local";
                if ($local[0] === '.' || !is_dir($path) || !(is_dir("$path/cur") || is_dir("$path/new"))) {
                    continue;
                }
                $folders = array_map(fn ($f) => $f + ['target' => self::suggestTarget(['raw' => $f['name'], 'name' => $f['name'], 'attrs' => []])], self::maildirFolders($path));
                $folders = array_map(fn ($f) => ['raw' => $f['raw'], 'name' => $f['raw'] === '' ? 'Inbox' : preg_replace('#^INBOX/#', '', $f['name']), 'count' => $f['count'], 'target' => $f['target']], $folders);
                $out[] = ['address' => "$local@$domain", 'folders' => $folders, 'total' => array_sum(array_column($folders, 'count'))];
            }
        }
        usort($out, fn ($a, $b) => strcmp($a['address'], $b['address']));
        return $out;
    }

    private function localPath(string $address): string
    {
        $root = $this->mailRoot();
        if (!$root || !preg_match('/^([a-z0-9._+-]+)@([a-z0-9.-]+)$/i', $address, $m) || str_contains($address, '..')) {
            throw new HttpError(404, 'That mailbox isn\'t on this hosting account.', 'not_found');
        }
        $path = realpath("$root/{$m[2]}/{$m[1]}");
        if (!$path || !str_starts_with($path, realpath($root) . '/')) {
            throw new HttpError(404, 'That mailbox isn\'t on this hosting account.', 'not_found');
        }
        return $path;
    }

    public function startMaildir(array $user, int $mailboxId, string $address, array $choices): array
    {
        (new Mailstore($this->app))->mailbox($user['id'], $mailboxId);
        $path = $this->localPath($address);
        $known = array_column(self::maildirFolders($path), 'name', 'raw');
        $folders = [];
        foreach ($choices as $c) {
            $raw = (string) ($c['raw'] ?? '');
            $target = $c['target'] ?? null;
            if (array_key_exists($raw, $known) && in_array($target, ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'], true)) {
                $folders[] = ['raw' => $raw, 'name' => $raw === '' ? 'Inbox' : preg_replace('#^INBOX/#', '', $known[$raw]), 'target' => $target, 'last' => '', 'total' => null, 'done' => false];
            }
        }
        if (!$folders) {
            throw new HttpError(422, 'Choose at least one folder to copy.', 'no_folders');
        }
        return $this->create($user, $mailboxId, 'maildir', ['address' => strtolower($address)], ['folders' => $folders]);
    }

    /**
     * Copy a Maildir folder's messages in name order (names start with the time they arrived), from after the last one
     * copied. Flags are in the name: ":2,S" read, "F" starred; anything still in new/ is unread.
     */
    private function stepMaildir(array &$job, float $until): void
    {
        try {
            $path = $this->localPath($job['settings']['address']);
        } catch (HttpError $e) {
            $this->save($job, ['status' => 'failed', 'note' => $e->getMessage()]);
            return;
        }
        $didWork = false;
        foreach ($job['state']['folders'] as &$f) {
            if ($f['done']) {
                continue;
            }
            $dir = $f['raw'] === '' ? $path : "$path/{$f['raw']}";
            $files = [];
            foreach (['cur', 'new'] as $sub) {
                foreach (@scandir("$dir/$sub") ?: [] as $name) {
                    if ($name[0] !== '.') {
                        $files[explode(':', $name, 2)[0]] = ["$dir/$sub/$name", $sub, $name];
                    }
                }
            }
            ksort($files, SORT_STRING);
            $f['total'] = count($files);
            foreach ($files as $key => [$file, $sub, $name]) {
                if (strcmp((string) $key, (string) $f['last']) <= 0) {
                    continue;
                }
                if ($didWork && microtime(true) >= $until) {
                    $this->save($job, ['note' => null]);
                    return;
                }
                $didWork = true;
                $flags = $sub === 'cur' && str_contains($name, ':2,') ? substr($name, strpos($name, ':2,') + 3) : '';
                $size = @filesize($file);
                if ($size === false) {
                    $f['last'] = (string) $key; // moved or deleted since it was listed
                    continue;
                }
                if ($size > self::MAX_MESSAGE_BYTES) {
                    $job['skipped']++;
                } elseif (!$this->importOne($job, (string) file_get_contents($file), $f['target'], str_contains($flags, 'S'), str_contains($flags, 'F'))) {
                    return;
                }
                $f['last'] = (string) $key;
                $this->save($job);
            }
            $f['done'] = true;
            $this->save($job);
        }
        unset($f);
        $this->save($job, ['status' => 'done', 'finished_at' => App::now(), 'note' => null]);
    }

    // ---------------------------------------------------------------------------------------------- files

    /** A file to upload in chunks: .mbox (many messages) or .eml (one). */
    public function startFile(array $user, int $mailboxId, string $filename, int $size, string $folder): array
    {
        (new Mailstore($this->app))->mailbox($user['id'], $mailboxId);
        if ($size <= 0 || $size > self::MAX_FILE_BYTES) {
            throw new HttpError(422, 'That file is empty or larger than 20 GB.', 'bad_size');
        }
        if (!in_array($folder, ['inbox', 'archive', 'sent'], true)) {
            $folder = 'archive';
        }
        $dir = self::uploadDir();
        $path = $dir . '/' . bin2hex(random_bytes(12)) . '.part';
        if (@file_put_contents($path, '') === false) {
            throw new HttpError(500, 'The webmail\'s storage folder isn\'t writable, so the file can\'t be uploaded.', 'storage');
        }
        @chmod($path, 0600);
        $name = mb_substr(basename($filename), 0, 200);
        return $this->create($user, $mailboxId, 'file', ['name' => $name, 'size' => $size, 'folder' => $folder, 'path' => $path], ['offset' => 0, 'received' => 0], 'uploading');
    }

    private static function uploadDir(): string
    {
        $dir = dirname(__DIR__) . '/storage/imports';
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        return $dir;
    }

    /** One chunk of the file, in order. When the last arrives, the import starts. */
    public function appendChunk(array $user, int $id, int $offset, string $bytes): array
    {
        $job = $this->job($user, $id);
        if ($job['status'] !== 'uploading') {
            throw new HttpError(409, 'This file is uploaded already.', 'not_uploading');
        }
        $s = $job['settings'];
        if ($offset !== (int) $job['state']['received']) {
            // A retried chunk: say where to carry on from.
            return $this->present($job);
        }
        if (strlen($bytes) > self::CHUNK_BYTES || $offset + strlen($bytes) > $s['size']) {
            throw new HttpError(422, 'That piece of the file doesn\'t fit.', 'bad_chunk');
        }
        if (@file_put_contents($s['path'], $bytes, FILE_APPEND | LOCK_EX) === false) {
            throw new HttpError(507, 'The upload stopped: the hosting account may be out of disk space.', 'storage');
        }
        $job['state']['received'] = $offset + strlen($bytes);
        $status = $job['state']['received'] >= $s['size'] ? 'running' : 'uploading';
        $this->save($job, ['status' => $status]);
        return $this->present($this->job($user, $id));
    }

    // ---------------------------------------------------------------------------------------------- running

    private function create(array $user, int $mailboxId, string $kind, array $settings, array $state, string $status = 'running'): array
    {
        $c = $this->app->crypto;
        $id = $this->app->db->insert('INSERT INTO {imports} (user_id, mailbox_id, kind, status, settings_enc, state_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$user['id'], $mailboxId, $kind, $status, $c->encryptJson($settings, 'imports.settings'), $c->encryptJson($state, 'imports.state'), App::now(), App::now()]);
        return $this->present($this->job($user, $id));
    }

    private function job(array $user, int $id): array
    {
        $r = $this->app->db->one('SELECT * FROM {imports} WHERE id = ? AND user_id = ?', [$id, $user['id']]);
        if (!$r) {
            throw new HttpError(404, 'Import not found', 'not_found');
        }
        $c = $this->app->crypto;
        $r['settings'] = $c->decryptJson($r['settings_enc'], 'imports.settings');
        $r['state'] = $c->decryptJson($r['state_enc'], 'imports.state') ?? [];
        $r['note'] = $c->decrypt($r['note_enc'], 'imports.note');
        return $r;
    }

    private function save(array $job, array $fields = []): void
    {
        $c = $this->app->crypto;
        $set = ['state_enc' => $c->encryptJson($job['state'], 'imports.state'), 'imported' => $job['imported'], 'skipped' => $job['skipped'], 'failed' => $job['failed'], 'updated_at' => App::now()];
        if (array_key_exists('note', $fields)) {
            $set['note_enc'] = $c->encrypt($fields['note'], 'imports.note');
        }
        if (array_key_exists('settings', $fields)) {
            $set['settings_enc'] = $c->encryptJson($fields['settings'], 'imports.settings');
        }
        foreach (['status', 'finished_at'] as $k) {
            if (array_key_exists($k, $fields)) {
                $set[$k] = $fields[$k];
            }
        }
        $this->app->db->run('UPDATE {imports} SET ' . implode(', ', array_map(fn ($k) => "$k = ?", array_keys($set))) . ' WHERE id = ?', [...array_values($set), $job['id']]);
    }

    public function list(array $user): array
    {
        $ids = array_column($this->app->db->all('SELECT id FROM {imports} WHERE user_id = ? ORDER BY id DESC LIMIT 20', [$user['id']]), 'id');
        return array_map(fn ($id) => $this->present($this->job($user, (int) $id)), $ids);
    }

    private function present(array $job): array
    {
        $s = $job['settings'] ?? [];
        $out = ['id' => (int) $job['id'], 'kind' => $job['kind'], 'status' => $job['status'], 'mailbox_id' => (int) $job['mailbox_id'],
            'imported' => (int) $job['imported'], 'skipped' => (int) $job['skipped'], 'failed' => (int) $job['failed'], 'note' => $job['note'],
            'created_at' => $job['created_at'], 'finished_at' => $job['finished_at']];
        if ($job['kind'] === 'imap') {
            $out += ['host' => $s['host'] ?? '', 'username' => $s['username'] ?? '', 'provider' => $s['provider'] ?? null,
                'can_check_again' => !empty($s['password']) || !empty($s['refresh_token']),
                'folders' => array_map(fn ($f) => ['name' => $f['name'], 'target' => $f['target'], 'total' => $f['total'], 'done' => $f['done']], $job['state']['folders'] ?? [])];
        } elseif ($job['kind'] === 'maildir') {
            $out += ['address' => $s['address'] ?? '', 'can_check_again' => true,
                'folders' => array_map(fn ($f) => ['name' => $f['name'], 'target' => $f['target'], 'total' => $f['total'], 'done' => $f['done']], $job['state']['folders'] ?? [])];
        } else {
            $out += ['filename' => $s['name'] ?? '', 'size' => (int) ($s['size'] ?? 0), 'received' => (int) ($job['state']['received'] ?? 0), 'offset' => (int) ($job['state']['offset'] ?? 0)];
        }
        return $out;
    }

    /**
     * Copy for about $budget seconds, then stop and say how far it got. Only one step of an import runs at a time.
     */
    public function step(array $user, int $id, float $budget = 20.0): array
    {
        $job = $this->job($user, $id);
        if ($job['status'] !== 'running') {
            return $this->present($job);
        }
        $lock = 'wm_import_' . $this->app->db->value('SELECT DATABASE()') . '_' . $id;
        if (!(int) $this->app->db->value('SELECT GET_LOCK(?, 0)', [$lock])) {
            return $this->present($job) + ['busy' => true];
        }
        @set_time_limit((int) ceil($budget) + 60);
        $until = microtime(true) + $budget;
        try {
            match ($job['kind']) {
                'imap' => $this->stepImap($job, $until),
                'maildir' => $this->stepMaildir($job, $until),
                default => $this->stepFile($job, $until),
            };
        } finally {
            $this->app->db->value('SELECT RELEASE_LOCK(?)', [$lock]);
        }
        return $this->present($this->job($user, $id));
    }

    /** Parse with GhostParse and store one message. Returns false to stop the step (GhostParse unreachable or at its daily cap). */
    private function importOne(array &$job, string $raw, string $folder, bool $read, bool $starred): bool
    {
        if (strlen($raw) > self::MAX_MESSAGE_BYTES) {
            $job['skipped']++;
            return true;
        }
        try {
            $data = $this->app->gp->parse($raw);
        } catch (GhostParseError $e) {
            if ($e->status === 422 || $e->status === 413) {
                $job['failed']++;
                return true;
            }
            $this->save($job, ['note' => $e->status === 429 ? $e->getMessage() : "Couldn't reach GhostParse ({$e->getMessage()}): it'll carry on next time."]);
            return false;
        }
        $key = 'imp:' . substr(hash('sha256', !empty($data['message_id']) ? 'm' . $data['message_id'] : 'r' . $raw), 0, 40);
        $data['size'] = strlen($raw);
        $stored = (new Mailstore($this->app))->storeImported((int) $job['mailbox_id'], $data, $folder, $read || $folder === 'sent' || $folder === 'drafts', $starred, $key);
        $stored ? $job['imported']++ : $job['skipped']++;
        return true;
    }

    private function stepImap(array &$job, float $until): void
    {
        $s = $job['settings'];
        if (empty($s['password']) && empty($s['refresh_token'])) {
            $this->save($job, ['status' => 'done', 'note' => 'The old mailbox\'s sign-in was forgotten, so it can\'t be checked again.']);
            return;
        }
        try {
            if ($this->freshen($s)) {
                $job['settings'] = $s;
                $this->save($job, ['settings' => $s]);
            }
        } catch (HttpError $e) {
            $this->save($job, $e->status === 422 ? ['status' => 'failed', 'note' => $e->getMessage()] : ['note' => $e->getMessage()]);
            return;
        }
        try {
            $imap = $this->open($s);
        } catch (HttpError $e) {
            $this->save($job, ['note' => $e->getMessage()]);
            return;
        }
        $didWork = false;
        try {
            foreach ($job['state']['folders'] as $i => &$f) {
                if ($f['done']) {
                    continue;
                }
                $info = $imap->examine($f['raw']);
                if ($f['uidvalidity'] && $f['uidvalidity'] !== $info['uidvalidity']) {
                    $f['last_uid'] = 0; // the server renumbered the folder: go through it again (copies already here are skipped)
                }
                $f['uidvalidity'] = $info['uidvalidity'];
                $f['total'] = $info['exists'];
                $uids = $imap->uidsAfter((int) $f['last_uid']);
                foreach (array_chunk($uids, self::BATCH) as $batch) {
                    if ($didWork && microtime(true) >= $until) {
                        $this->save($job, ['note' => null]);
                        return;
                    }
                    $didWork = true;
                    $sizes = $imap->sizes($batch);
                    $small = array_values(array_filter($batch, fn ($u) => ($sizes[$u] ?? 0) <= self::MAX_MESSAGE_BYTES));
                    $job['skipped'] += count($batch) - count($small);
                    $messages = $imap->fetch($small);
                    foreach ($batch as $uid) {
                        if (isset($messages[$uid])) {
                            $m = $messages[$uid];
                            if (!$this->importOne($job, $m['raw'], $f['target'], in_array('\\seen', $m['flags'], true), in_array('\\flagged', $m['flags'], true))) {
                                return;
                            }
                        }
                        $f['last_uid'] = $uid;
                    }
                    $this->save($job);
                }
                $f['done'] = true;
                $this->save($job);
            }
            unset($f);
            $this->save($job, ['status' => 'done', 'finished_at' => App::now(), 'note' => null]);
        } catch (ImapError $e) {
            $this->save($job, ['note' => 'The old server stopped answering (' . $e->getMessage() . '). It\'ll carry on next time.']);
        } finally {
            $imap->logout();
        }
    }

    /** Copy what's new since last time (after the domain's mail has moved here). */
    public function again(array $user, int $id): array
    {
        $job = $this->job($user, $id);
        if ($job['kind'] === 'file' || ($job['kind'] === 'imap' && empty($job['settings']['password']) && empty($job['settings']['refresh_token']))) {
            throw new HttpError(409, 'This import can\'t be checked again: start a new one.', 'cannot_repeat');
        }
        foreach ($job['state']['folders'] as &$f) {
            $f['done'] = false;
        }
        unset($f);
        $this->save($job, ['status' => 'running', 'finished_at' => null, 'note' => null]);
        return $this->present($this->job($user, $id));
    }

    /** Forget the old mailbox's password (an import can't be checked again after this). */
    public function forget(array $user, int $id): array
    {
        $job = $this->job($user, $id);
        $s = $job['settings'];
        if ($job['kind'] === 'imap') {
            $s['password'] = '';
            unset($s['refresh_token'], $s['access_token']);
        }
        $this->save($job, ['settings' => $s] + ($job['status'] === 'running' ? ['status' => 'done', 'finished_at' => App::now()] : []));
        return $this->present($this->job($user, $id));
    }

    /** Remove the import from the list (the email it copied stays). */
    public function delete(array $user, int $id): void
    {
        $job = $this->job($user, $id);
        if ($job['kind'] === 'file' && !empty($job['settings']['path'])) {
            @unlink($job['settings']['path']);
        }
        $this->app->db->run('DELETE FROM {imports} WHERE id = ?', [$id]);
    }

    // ---------------------------------------------------------------------------------------------- files

    private function stepFile(array &$job, float $until): void
    {
        $s = $job['settings'];
        $fh = @fopen($s['path'], 'rb');
        if (!$fh) {
            $this->save($job, ['status' => 'failed', 'note' => 'The uploaded file is gone. Upload it again.']);
            return;
        }
        $offset = (int) $job['state']['offset'];
        fseek($fh, $offset);
        $first = fread($fh, 5);
        fseek($fh, $offset);
        if ($offset === 0 && $first !== 'From ') {
            // One message (.eml).
            $raw = stream_get_contents($fh);
            fclose($fh);
            $this->importOne($job, (string) $raw, $s['folder'], true, false);
            $job['state']['offset'] = $s['size'];
            $this->finishFile($job);
            return;
        }
        $message = '';
        $start = $offset;
        $prevBlank = true;
        // A message starts at a "From " line after a blank line (or at the start of the file).
        // Separators look like "From sender Wed Jan 20 10:11:12 2021" (Thunderbird: "From - …"; Google Takeout adds
        // a time zone), so a body line that happens to start with "From " isn't taken for one.
        $separator = fn ($line) => $line !== false && preg_match('/^From \S+ +(Mon|Tue|Wed|Thu|Fri|Sat|Sun) /', $line) === 1;
        while (true) {
            $pos = ftell($fh);
            $line = fgets($fh);
            $isSeparator = $line === false || ($separator($line) && $prevBlank && $pos > $start);
            if ($isSeparator && $message !== '') {
                [$folder, $read, $starred] = self::mboxFolder($message, $s['folder']);
                if (!$this->importOne($job, $message, $folder, $read, $starred)) {
                    fclose($fh);
                    return;
                }
                $job['state']['offset'] = $pos;
                $message = '';
                if ($line !== false && microtime(true) >= $until) {
                    fclose($fh);
                    $this->save($job, ['note' => null]);
                    return;
                }
            }
            if ($line === false) {
                break;
            }
            $wasBlank = $prevBlank;
            $prevBlank = trim($line) === '';
            if ($separator($line) && $message === '' && $wasBlank) {
                continue; // the separator line itself
            }
            // mboxrd: ">From " (with any number of >) at the start of a line was escaped; take one > off.
            $message .= preg_match('/^>+From /', $line) ? substr($line, 1) : $line;
            if (strlen($message) > self::MAX_MESSAGE_BYTES + 1) {
                // Too large to import: skip to the next separator.
                $blank = false;
                while (($l = fgets($fh)) !== false && !($separator($l) && $blank)) {
                    $blank = trim($l) === '';
                }
                $job['skipped']++;
                $message = '';
                $prevBlank = true;
                if ($l !== false) {
                    fseek($fh, -strlen($l), SEEK_CUR);
                }
            }
        }
        fclose($fh);
        $job['state']['offset'] = $s['size'];
        $this->finishFile($job);
    }

    private function finishFile(array &$job): void
    {
        @unlink($job['settings']['path']);
        $this->save($job, ['status' => 'done', 'finished_at' => App::now(), 'note' => null]);
    }

    /**
     * Where a message from an .mbox goes, and whether it's read or starred: from Gmail's labels (Google Takeout), the
     * Status and X-Mozilla-Status headers (Thunderbird, Apple Mail), else the folder chosen for the file.
     * @return array{0: string, 1: bool, 2: bool}
     */
    public static function mboxFolder(string $raw, string $default): array
    {
        $end = strpos($raw, "\n\n");
        $head = $end === false ? $raw : substr($raw, 0, $end);
        $head = preg_replace("/\r?\n[ \t]+/", ' ', $head);
        if (preg_match('/^X-Gmail-Labels:(.*)$/mi', $head, $m)) {
            $labels = array_map(fn ($l) => strtolower(trim($l, " \t\r\"")), str_getcsv(trim($m[1])));
            $folder = match (true) {
                in_array('spam', $labels, true) => 'spam',
                in_array('trash', $labels, true) => 'trash',
                in_array('drafts', $labels, true) || in_array('draft', $labels, true) => 'drafts',
                in_array('sent', $labels, true) => 'sent',
                in_array('inbox', $labels, true) => 'inbox',
                default => 'archive',
            };
            return [$folder, !in_array('unread', $labels, true), in_array('starred', $labels, true)];
        }
        $read = true;
        $starred = false;
        if (preg_match('/^Status:\s*(\S*)/mi', $head, $m)) {
            $read = str_contains(strtoupper($m[1]), 'R');
        }
        if (preg_match('/^X-Mozilla-Status:\s*([0-9a-f]{4})/mi', $head, $m)) {
            $flags = hexdec($m[1]);
            $read = (bool) ($flags & 0x1);
            $starred = (bool) ($flags & 0x4);
        }
        return [$default, $read, $starred];
    }
}
