<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\App;
use Webmail\Auth;
use Webmail\Config;
use Webmail\HttpError;
use Webmail\Importer;
use Webmail\Mailstore;

final class ImportTest extends TestCase
{
    private $server;
    private int $port;
    private string $dir;
    private array $mailbox;
    private array $user;
    private Importer $importer;
    private bool $ghostparseDown = false;

    private static function msg(string $id, string $subject, string $body = 'Hello', string $date = 'Tue, 05 Mar 2019 09:30:00 +0000'): string
    {
        return "From: Jane Doe <jane@customer.example>\r\nTo: support@acme.test\r\nSubject: $subject\r\nDate: $date\r\nMessage-ID: <$id@customer.example>\r\n\r\n$body\r\n";
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = sys_get_temp_dir() . '/wm-imap-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->writeMailbox([
            ['raw' => 'INBOX', 'messages' => [
                ['uid' => 1, 'flags' => ['\\Seen', '\\Flagged'], 'raw' => self::msg('a1', 'Order 1')],
                ['uid' => 2, 'flags' => [], 'raw' => self::msg('a2', 'Order 2')],
            ]],
            ['raw' => 'Sent', 'attrs' => ['\\Sent'], 'messages' => [['uid' => 7, 'raw' => self::msg('s1', 'Re: Order 1')]]],
            ['raw' => 'Trash', 'attrs' => ['\\Trash'], 'messages' => [['uid' => 1, 'raw' => self::msg('t1', 'Old junk')]]],
            ['raw' => '[Gmail]', 'attrs' => ['\\Noselect'], 'messages' => []],
            ['raw' => '[Gmail]/All Mail', 'attrs' => ['\\All'], 'messages' => [['uid' => 1, 'raw' => self::msg('a1', 'Order 1')]]],
            ['raw' => 'Clients/Entw&APw-rfe', 'messages' => [['uid' => 3, 'raw' => self::msg('c1', 'Quote')], ['uid' => 4, 'raw' => self::msg('a2', 'Order 2')]]],
        ]);
        $this->port = random_int(20000, 40000);
        $this->server = proc_open(['php', __DIR__ . '/fixtures/fake-imap.php', (string) $this->port, "{$this->dir}/mailbox.json", "{$this->dir}/log"], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $this->assertSame("ready\n", fgets($pipes[1]));

        // The webmail, allowed to reach the stand-in server on this machine without TLS.
        $this->app = new App(new Config($this->config + ['import_allow_private' => true]), $this->app->db, $this->app->gp);
        App::set($this->app);
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@acme.test', 'Acme Support');
        $uid = (new Auth($this->app))->createUser('sam@acme.test', 'Sam', 'correct horse battery', 'user');
        $store->grant($uid, $mb);
        $this->user = ['id' => $uid, 'name' => 'Sam', 'role' => 'user'];
        $this->mailbox = $store->mailbox($uid, $mb);
        $this->importer = new Importer($this->app);

        // GhostParse's parser, as far as these messages need.
        $this->answers['POST /v1/parse'] = function (array $_, ?string $raw) {
            if ($this->ghostparseDown) {
                return [503, ['error' => 'unavailable', 'message' => 'Service unavailable']];
            }
            [$head, $body] = explode("\r\n\r\n", str_replace("\n", "\r\n", str_replace("\r\n", "\n", (string) $raw)), 2) + [1 => ''];
            preg_match('/^Subject: (.*)$/mi', $head, $s);
            preg_match('/^Message-ID: (.*)$/mi', $head, $id);
            preg_match('/^Date: (.*)$/mi', $head, $d);
            return [200, ['data' => ['message_id' => trim($id[1] ?? ''), 'subject' => trim($s[1] ?? ''), 'from' => ['address' => 'jane@customer.example', 'name' => 'Jane Doe'],
                'to' => [['address' => 'support@acme.test', 'name' => null]], 'date' => date('c', strtotime(trim($d[1] ?? 'now'))), 'text' => trim($body), 'attachments' => [],
                'thread_id' => 'thr_' . md5(preg_replace('/^re: /i', '', trim($s[1] ?? '')))]]];
        };
    }

    protected function tearDown(): void
    {
        proc_terminate($this->server);
        proc_close($this->server);
        exec('rm -rf ' . escapeshellarg($this->dir));
        parent::tearDown();
    }

    private function writeMailbox(array $folders): void
    {
        file_put_contents("{$this->dir}/mailbox.json", json_encode(['user' => 'jane@old.example', 'pass' => 'app-password', 'token' => 'access-fresh', 'folders' => $folders]));
    }

    private function login(array $extra = []): array
    {
        return $extra + ['host' => 'localhost', 'port' => $this->port, 'security' => 'none', 'username' => 'jane@old.example', 'password' => 'app-password'];
    }

    private function messages(): array
    {
        return $this->app->db->all('SELECT folder, is_read, is_starred FROM {messages} WHERE mailbox_id = ? ORDER BY id', [$this->mailbox['id']]);
    }

    private function runToEnd(int $id): array
    {
        for ($i = 0; $i < 20; $i++) {
            $r = $this->importer->step($this->user, $id, 0.0);
            if ($r['status'] !== 'running' || $r['note']) {
                return $r;
            }
        }
        $this->fail('import never finished');
    }

    public function testItListsTheOldMailboxsFoldersWithWhereTheyWouldGo(): void
    {
        $folders = $this->importer->probe($this->login())['folders'];
        $this->assertSame([
            ['INBOX', 'inbox', 2], ['Sent', 'sent', 1], ['Clients/Entwürfe', 'archive', 2], ['Trash', null, 1], ['[Gmail]/All Mail', null, 1],
        ], array_map(fn ($f) => [$f['name'], $f['target'], $f['count']], $folders), 'inbox first, then Sent; Trash and All Mail left out by default; names decoded');

        try {
            $this->importer->probe($this->login(['password' => 'wrong']));
            $this->fail('wrong password');
        } catch (HttpError $e) {
            $this->assertStringContainsString('app password', $e->getMessage());
        }
    }

    public function testItCopiesTheChosenFoldersInStepsReadOnlyAndOnlyOnce(): void
    {
        $job = $this->importer->startImap($this->user, $this->mailbox['id'], $this->login(), [
            ['raw' => 'INBOX', 'target' => 'inbox'], ['raw' => 'Sent', 'target' => 'sent'], ['raw' => 'Clients/Entw&APw-rfe', 'target' => 'archive'],
            ['raw' => 'Trash', 'target' => null],
        ]);
        $this->assertSame(['INBOX', 'Sent', 'Clients/Entwürfe'], array_column($job['folders'], 'name'));
        $done = $this->runToEnd($job['id']);
        $this->assertSame('done', $done['status']);
        // a2 is in the inbox and Clients: one copy, in the inbox (copied first).
        $this->assertSame(['imported' => 4, 'skipped' => 1, 'failed' => 0], array_intersect_key($done, array_flip(['imported', 'skipped', 'failed'])));
        $this->assertSame([
            ['folder' => 'inbox', 'is_read' => 1, 'is_starred' => 1],
            ['folder' => 'inbox', 'is_read' => 0, 'is_starred' => 0],
            ['folder' => 'sent', 'is_read' => 1, 'is_starred' => 0],
            ['folder' => 'archive', 'is_read' => 0, 'is_starred' => 0],
        ], $this->messages());
        // Encrypted like everything else, and searchable.
        $list = (new Mailstore($this->app))->list($this->user['id'], $this->mailbox['id'], 'inbox', 1, 'order');
        $this->assertCount(2, $list['messages']);

        // Read-only on the old server: EXAMINE and PEEK, never SELECT, STORE or EXPUNGE.
        $log = file_get_contents("{$this->dir}/log");
        $this->assertStringContainsString('BODY.PEEK[]', $log);
        $this->assertDoesNotMatchRegularExpression('/\b(SELECT|STORE|EXPUNGE|COPY|MOVE|DELETE)\b/', $log);
        $this->assertStringNotContainsString('app-password', $log);

        // Checking again later copies only what's new.
        $this->writeMailbox(array_merge(json_decode(file_get_contents("{$this->dir}/mailbox.json"), true)['folders'], []));
        $box = json_decode(file_get_contents("{$this->dir}/mailbox.json"), true);
        $box['folders'][0]['messages'][] = ['uid' => 3, 'flags' => [], 'raw' => self::msg('a3', 'Order 3 (arrived during the move)')];
        file_put_contents("{$this->dir}/mailbox.json", json_encode($box));
        $again = $this->importer->again($this->user, $job['id']);
        $this->assertSame('running', $again['status']);
        $after = $this->runToEnd($job['id']);
        $this->assertSame(5, $after['imported']);
        $this->assertSame(1, substr_count(file_get_contents("{$this->dir}/log"), 'BODY.PEEK[]') - 3, 'one more fetch, of the new message only');

        // Forgetting the password: no more checks.
        $forgot = $this->importer->forget($this->user, $job['id']);
        $this->assertFalse($forgot['can_check_again']);
        $this->expectException(HttpError::class);
        $this->importer->again($this->user, $job['id']);
    }

    public function testItCarriesOnWhereItStoppedWhenGhostParseIsUnreachable(): void
    {
        $job = $this->importer->startImap($this->user, $this->mailbox['id'], $this->login(), [['raw' => 'INBOX', 'target' => 'inbox']]);
        $this->ghostparseDown = true;
        $r = $this->importer->step($this->user, $job['id'], 0.0);
        $this->assertSame('running', $r['status']);
        $this->assertStringContainsString("Couldn't reach GhostParse", $r['note']);
        $this->assertSame(0, $r['imported']);
        $this->ghostparseDown = false;
        $this->assertSame(['done', 2], [($d = $this->runToEnd($job['id']))['status'], $d['imported']]);
    }

    public function testAnImportBelongsToItsUserAndTheirMailboxes(): void
    {
        $other = ['id' => (new Auth($this->app))->createUser('eve@acme.test', 'Eve', 'correct horse battery', 'user'), 'name' => 'Eve', 'role' => 'user'];
        try {
            $this->importer->startImap($other, $this->mailbox['id'], $this->login(), [['raw' => 'INBOX', 'target' => 'inbox']]);
            $this->fail('not her mailbox');
        } catch (HttpError $e) {
            $this->assertSame(404, $e->status);
        }
        $job = $this->importer->startImap($this->user, $this->mailbox['id'], $this->login(), [['raw' => 'INBOX', 'target' => 'inbox']]);
        $this->expectException(HttpError::class);
        $this->importer->step($other, $job['id']);
    }

    public function testOnlyRealMailServersOverEncryptedConnections(): void
    {
        $strict = new Importer(new App(new Config($this->config), $this->app->db, $this->app->gp));
        foreach ([
            [['host' => 'localhost'], '/mail server\'s name/'],
            [['host' => 'imap.gmail.com', 'security' => 'none'], '/never sent unencrypted/'],
            [['host' => 'imap.gmail.com', 'port' => 25], '/993/'],
            [['host' => 'imap.gmail.com', 'password' => ''], '/password/'],
        ] as [$in, $pattern]) {
            try {
                $strict->imapSettings($in + $this->login(['port' => 993, 'security' => 'ssl']));
                $this->fail("accepted " . json_encode($in));
            } catch (HttpError $e) {
                $this->assertMatchesRegularExpression($pattern, $e->getMessage());
            }
        }
    }

    public function testAnMboxUploadedInPiecesIsSplitIntoItsMessages(): void
    {
        $mbox = "From jane@customer.example Tue Mar  5 09:30:00 2019\n" . str_replace("\r\n", "\n", self::msg('m1', 'First', "From the top: a body line that isn't a separator\nLine one\n>From the start of a line, escaped\n"))
            . "\nFrom MAILER-DAEMON Wed Mar  6 10:00:00 2019\nX-Gmail-Labels: Sent,Starred\n" . str_replace("\r\n", "\n", self::msg('m2', 'Second'))
            . "\nFrom x@y Thu Mar  7 10:00:00 2019\nX-Gmail-Labels: Archived,Unread,Category Updates\n" . str_replace("\r\n", "\n", self::msg('m3', 'Third'));
        $job = $this->importer->startFile($this->user, $this->mailbox['id'], 'takeout.mbox', strlen($mbox), 'inbox');
        $this->assertSame('uploading', $job['status']);
        $half = intdiv(strlen($mbox), 2);
        $this->importer->appendChunk($this->user, $job['id'], 0, substr($mbox, 0, $half));
        $retry = $this->importer->appendChunk($this->user, $job['id'], 0, substr($mbox, 0, $half));
        $this->assertSame($half, $retry['received'], 'a repeated piece is ignored');
        $up = $this->importer->appendChunk($this->user, $job['id'], $half, substr($mbox, $half));
        $this->assertSame('running', $up['status']);
        $done = $this->runToEnd($job['id']);
        $this->assertSame(['done', 3], [$done['status'], $done['imported']]);
        $this->assertSame([
            ['folder' => 'inbox', 'is_read' => 1, 'is_starred' => 0],
            ['folder' => 'sent', 'is_read' => 1, 'is_starred' => 1],
            ['folder' => 'archive', 'is_read' => 0, 'is_starred' => 0],
        ], $this->messages());
        $first = array_values(array_filter($this->requests, fn ($r) => $r['path'] === '/v1/parse'))[0]['raw'];
        $this->assertStringContainsString("\nFrom the start of a line, escaped", $first, 'mboxrd escaping undone');
        $this->assertStringNotContainsString('From jane@customer.example Tue', $first, 'the separator line is left out');
        $this->assertSame([], glob(dirname(__DIR__) . '/storage/imports/*.part') ?: [], 'the upload is deleted');
    }

    public function testASingleEmlFile(): void
    {
        $eml = self::msg('e1', 'Just one');
        $job = $this->importer->startFile($this->user, $this->mailbox['id'], 'message.eml', strlen($eml), 'archive');
        $this->importer->appendChunk($this->user, $job['id'], 0, $eml);
        $this->assertSame(['done', 1], [($d = $this->runToEnd($job['id']))['status'], $d['imported']]);
        $this->assertSame('archive', $this->messages()[0]['folder']);
    }

    public function testAMailboxSignedInWithGoogleRefreshesItsTokenThroughGhostParse(): void
    {
        $this->answers['POST /v1/mail-oauth/refresh'] = fn (array $b) => $b['refresh_token'] === 'refresh-good'
            ? [200, ['access_token' => 'access-fresh', 'expires_in' => 3599]]
            : [422, ['error' => 'mail_oauth_revoked', 'message' => 'Google no longer allows this access (it was removed or has expired). Sign in again.']];
        // As claimed from GhostParse an hour ago: the access token has run out.
        // The provider's server, played by the stand-in.
        $oauth = Importer::oauthSettings(
            ['provider' => 'google', 'email' => 'Jane@Old.Example', 'access_token' => 'access-old', 'refresh_token' => 'refresh-good', 'expires_in' => -10]);
        $oauth['host'] = 'localhost';
        $oauth['port'] = $this->port;
        $oauth['security'] = 'none';
        $folders = $this->importer->probe([], $oauth)['folders'];
        $this->assertSame('INBOX', $folders[0]['name'], 'signed in with the refreshed token');

        $job = $this->importer->startImap($this->user, $this->mailbox['id'], [], [['raw' => 'INBOX', 'target' => 'inbox']], $oauth);
        $this->assertSame(['jane@old.example', 'google', true], [$job['username'], $job['provider'], $job['can_check_again']]);
        $this->assertSame(['done', 2], [($d = $this->runToEnd($job['id']))['status'], $d['imported']]);
        $this->assertStringContainsString('AUTHENTICATE XOAUTH2 ***', file_get_contents("{$this->dir}/log"));
        $this->assertStringNotContainsString('access-fresh', file_get_contents("{$this->dir}/log"));

        // The sign-in is removed at Google: checking again stops with the reason.
        $row = $this->app->db->one('SELECT settings_enc FROM {imports} WHERE id = ?', [$job['id']]);
        $s = $this->app->crypto->decryptJson($row['settings_enc'], 'imports.settings');
        $this->assertSame('refresh-good', $s['refresh_token'], 'kept encrypted for checking again');
        $s['refresh_token'] = 'refresh-revoked';
        $s['expires_at'] = 0;
        $this->app->db->run('UPDATE {imports} SET settings_enc = ? WHERE id = ?', [$this->app->crypto->encryptJson($s, 'imports.settings'), $job['id']]);
        $this->importer->again($this->user, $job['id']);
        $stopped = $this->importer->step($this->user, $job['id'], 0.0);
        $this->assertSame('failed', $stopped['status']);
        $this->assertStringContainsString('Sign in again', $stopped['note']);

        // Forgetting removes the tokens.
        $this->assertFalse($this->importer->forget($this->user, $job['id'])['can_check_again']);
        $left = $this->app->crypto->decryptJson($this->app->db->value('SELECT settings_enc FROM {imports} WHERE id = ?', [$job['id']]), 'imports.settings');
        $this->assertArrayNotHasKey('refresh_token', $left);
    }

    public function testAWrongTokenIsRefusedCleanly(): void
    {
        $this->answers['POST /v1/mail-oauth/refresh'] = fn () => [200, ['access_token' => 'access-wrong', 'expires_in' => 3599]];
        // The provider's server, played by the stand-in.
        $oauth = Importer::oauthSettings(
            ['provider' => 'microsoft', 'email' => 'jane@old.example', 'access_token' => 'x', 'refresh_token' => 'refresh-x', 'expires_in' => -10]);
        $oauth['host'] = 'localhost';
        $oauth['port'] = $this->port;
        $oauth['security'] = 'none';
        $this->expectExceptionMessage("didn't accept the sign-in");
        $this->importer->probe([], $oauth);
    }
}
