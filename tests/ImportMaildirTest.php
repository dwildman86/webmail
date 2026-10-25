<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\App;
use Webmail\Auth;
use Webmail\Config;
use Webmail\HttpError;
use Webmail\Importer;
use Webmail\Mailstore;

/** Copying the hosting account's own mailboxes (cPanel's ~/mail/<domain>/<user>/ Maildir folders). */
final class ImportMaildirTest extends TestCase
{
    private string $root;
    private array $user;
    private array $mailbox;
    private Importer $importer;

    private function put(string $dir, string $name, string $id, string $subject): void
    {
        @mkdir(dirname("{$this->root}/$dir/$name"), 0700, true);
        file_put_contents("{$this->root}/$dir/$name", "From: Jane <jane@customer.example>\nTo: support@shop.test\nSubject: $subject\nDate: Tue, 05 Mar 2019 09:30:00 +0000\nMessage-ID: <$id@x>\n\nHello\n");
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->root = sys_get_temp_dir() . '/wm-maildir-' . bin2hex(random_bytes(4));
        $box = 'shop.test/support';
        foreach (['cur', 'new', 'tmp'] as $d) {
            @mkdir("{$this->root}/$box/$d", 0700, true);
        }
        $this->put($box, 'cur/1551778200.M1P1.server:2,SF', 'i1', 'Read and starred');
        $this->put($box, 'new/1551778300.M2P2.server', 'i2', 'Not read yet');
        $this->put($box, '.Sent/cur/1551778400.M3P3.server:2,S', 's1', 'My reply');
        $this->put($box, '.Trash/cur/1551778500.M4P4.server:2,S', 't1', 'Deleted');
        $this->put($box, '.Clients.Projects/cur/1551778600.M5P5.server:2,S', 'c1', 'Project notes');
        @mkdir("{$this->root}/shop.test/hello/cur", 0700, true);
        $this->put('shop.test/hello', 'cur/1551778700.M6P6.server:2,', 'h1', 'Hello mailbox');

        $this->app = new App(new Config($this->config + ['maildir_root' => $this->root]), $this->app->db, $this->app->gp);
        App::set($this->app);
        $store = new Mailstore($this->app);
        $mb = $store->createMailbox('support@shop.test', 'Shop');
        $uid = (new Auth($this->app))->createUser('sam@shop.test', 'Sam', 'correct horse battery', 'user');
        $store->grant($uid, $mb);
        $this->user = ['id' => $uid, 'name' => 'Sam', 'role' => 'user'];
        $this->mailbox = $store->mailbox($uid, $mb);
        $this->importer = new Importer($this->app);
        $this->answers['POST /v1/parse'] = function (array $_, ?string $raw) {
            preg_match('/^Subject: (.*)$/m', (string) $raw, $s);
            preg_match('/^Message-ID: (.*)$/m', (string) $raw, $id);
            return [200, ['data' => ['message_id' => trim($id[1]), 'subject' => trim($s[1]), 'from' => ['address' => 'jane@customer.example', 'name' => 'Jane'],
                'to' => [], 'date' => '2019-03-05T09:30:00Z', 'text' => 'Hello', 'attachments' => [], 'thread_id' => 'thr_' . md5($s[1])]]];
        };
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
        parent::tearDown();
    }

    public function testItFindsTheAccountsMailboxesAndCopiesOneWithoutAPassword(): void
    {
        $found = $this->importer->localMailboxes();
        $this->assertSame(['hello@shop.test', 'support@shop.test'], array_column($found, 'address'));
        $support = $found[1];
        $this->assertSame(5, $support['total']);
        $this->assertSame([['Inbox', 'inbox', 2], ['Clients/Projects', 'archive', 1], ['Sent', 'sent', 1], ['Trash', null, 1]],
            array_map(fn ($f) => [$f['name'], $f['target'], $f['count']], $support['folders']));

        $job = $this->importer->startMaildir($this->user, $this->mailbox['id'], 'support@shop.test', array_map(fn ($f) => ['raw' => $f['raw'], 'target' => $f['target']], $support['folders']));
        for ($i = 0; $i < 10 && ($job = $this->importer->step($this->user, $job['id'], 0.0))['status'] === 'running'; $i++) {
        }
        $this->assertSame(['done', 4], [$job['status'], $job['imported']]);
        $rows = $this->app->db->all('SELECT folder, is_read, is_starred FROM {messages} ORDER BY sent_at, id');
        $this->assertSame([['inbox', 1, 1], ['inbox', 0, 0], ['archive', 1, 0], ['sent', 1, 0]],
            array_map(fn ($r) => [$r['folder'], (int) $r['is_read'], (int) $r['is_starred']], $rows));

        // New mail on the old mailbox (before the domain moved): checking again copies just that.
        $this->put('shop.test/support', 'new/1551779000.M9P9.server', 'i9', 'Arrived during the move');
        $this->importer->again($this->user, $job['id']);
        $again = $this->importer->step($this->user, $job['id'], 0.0);
        $this->assertSame(['done', 5], [$again['status'], $again['imported']]);
    }

    public function testOnlyThisAccountsOwnMailFolders(): void
    {
        foreach (['../../etc/passwd@x.y', 'support@../shop.test', 'nobody@shop.test', 'support@other.test'] as $bad) {
            try {
                $this->importer->startMaildir($this->user, $this->mailbox['id'], $bad, [['raw' => '', 'target' => 'inbox']]);
                $this->fail("accepted $bad");
            } catch (HttpError $e) {
                $this->assertSame(404, $e->status, $bad);
            }
        }
        // A folder name that isn't one of the mailbox's own folders is ignored.
        $this->expectExceptionMessage('Choose at least one folder');
        $this->importer->startMaildir($this->user, $this->mailbox['id'], 'support@shop.test', [['raw' => '../hello', 'target' => 'inbox']]);
    }
}
