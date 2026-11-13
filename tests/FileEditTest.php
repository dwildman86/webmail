<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\FileEdit;
use Webmail\Files;
use Webmail\HttpError;
use Webmail\LocalStore;

final class FileEditTest extends TestCase
{
    private Files $files;
    private FileEdit $edit;
    private array $olive;
    private array $sam;
    private array $kim;
    private string $root;

    protected function setUp(): void
    {
        parent::setUp();
        $this->answers['GET /v1/me'] = fn () => [200, ['account' => ['id' => 'acc'], 'features' => ['files' => true]]];
        $this->root = sys_get_temp_dir() . '/wmedit-' . bin2hex(random_bytes(4));
        Files::$stores = ['local' => new LocalStore($this->root)];
        $auth = new Auth($this->app);
        $mk = fn ($email, $name) => ['id' => $auth->createUser($email, $name, 'correct horse battery'), 'role' => 'user', 'name' => $name, 'email' => $email];
        $this->olive = $mk('olive@acme.test', 'Olive');
        $this->sam = $mk('sam@acme.test', 'Sam');
        $this->kim = $mk('kim@acme.test', 'Kim');
        $this->files = new Files($this->app);
        $this->edit = new FileEdit($this->app);
    }

    protected function tearDown(): void
    {
        Files::$stores = [];
        exec('rm -rf ' . escapeshellarg($this->root));
        parent::tearDown();
    }

    private function save(array $user, int $nodeId, string $bytes, ?array $edit): void
    {
        $s = $this->files->startUpload($user, null, 'ignored', strlen($bytes), $nodeId, false, null, $edit);
        $this->files->appendUpload($user, $s['upload'], 0, $bytes);
    }

    private function fails(callable $fn, int $status): void
    {
        try {
            $fn();
            $this->fail("Expected HTTP $status");
        } catch (HttpError $e) {
            $this->assertSame($status, $e->status, $e->getMessage());
        }
    }

    public function testChangesAreOrderedSharedAndSavedWithoutLosingAny(): void
    {
        $f = $this->files->storeBytes($this->olive, null, 'Budget.csv', "a,b\n1,2\n");
        $this->files->share($this->olive, $f['id'], $this->sam['id'], null, 'editor');
        $this->files->share($this->olive, $f['id'], $this->kim['id'], null, 'viewer');
        $this->fails(fn () => $this->edit->open($this->olive, $this->files->storeBytes($this->olive, null, 'photo.jpg', 'x')['id'], 'aaaaaaaaaaaaaaaa'), 422);

        $o = $this->edit->open($this->olive, $f['id'], 'olive00000000001');
        $this->assertSame(['spreadsheet', true, 1, 0, [], true], [$o['file']['kind'], $o['can_edit'], $o['generation'], $o['base_seq'], $o['ops'], $o['saver']]);
        $s = $this->edit->open($this->sam, $f['id'], 'sam0000000000001');
        $this->assertFalse($s['saver'], 'Olive opened it first: her browser saves');
        $this->assertSame(['Olive'], array_column($s['others'], 'name'));
        $k = $this->edit->open($this->kim, $f['id'], 'kim0000000000001');
        $this->assertFalse($k['can_edit']);

        // Both edit at once; the server's order is the truth.
        $r1 = $this->edit->sync($this->olive, $f['id'], 'olive00000000001', 1, 0, [['seen' => 0, 'op' => ['t' => 'set', 'r' => 1, 'c' => 0, 'v' => '10']]], ['cell' => 'A2']);
        $r2 = $this->edit->sync($this->sam, $f['id'], 'sam0000000000001', 1, 0, [['seen' => 0, 'op' => ['t' => 'set', 'r' => 1, 'c' => 1, 'v' => '20']]], ['cell' => 'B2']);
        $this->assertSame([['t' => 'set', 'r' => 1, 'c' => 0, 'v' => '10']], array_column($r1['ops'], 'op'));
        $this->assertSame(['olive00000000001', 'sam0000000000001'], array_column($r2['ops'], 'client'), 'Sam gets both, in order');
        $olive = array_values(array_filter($r2['others'], fn ($x) => $x['name'] === 'Olive'))[0];
        $this->assertSame(['cell' => 'A2'], $olive['state'], "where Olive's cursor is");
        $this->assertSame(FileEdit::color($this->olive['id']), $olive['color']);
        $this->fails(fn () => $this->edit->sync($this->kim, $f['id'], 'kim0000000000001', 1, 0, [['seen' => 0, 'op' => ['t' => 'set']]], null), 403);
        $view = $this->edit->sync($this->kim, $f['id'], 'kim0000000000001', 1, 0, [], null);
        $this->assertCount(2, $view['ops'], 'viewers see changes live');

        // Nobody saved yet: someone opening now gets the file plus both changes.
        $this->assertCount(2, $this->edit->open($this->kim, $f['id'], 'kim0000000000002')['ops']);
        // Olive saves, up to change 2: new joiners start from the save.
        $seq = $r2['ops'][1]['seq'];
        $this->save($this->olive, $f['id'], "a,b\n10,20\n", ['seq' => $seq, 'generation' => 1]);
        $after = $this->edit->open($this->kim, $f['id'], 'kim0000000000003');
        $this->assertSame([$seq, []], [$after['base_seq'], $after['ops']]);
        // A second autosave soon after replaces the first: one version for the session, not dozens.
        $r3 = $this->edit->sync($this->olive, $f['id'], 'olive00000000001', 1, $seq, [['seen' => $seq, 'op' => ['t' => 'set', 'r' => 1, 'c' => 0, 'v' => '11']]], null);
        $this->save($this->olive, $f['id'], "a,b\n11,20\n", ['seq' => $r3['ops'][0]['seq'], 'generation' => 1]);
        $this->assertCount(2, $this->files->versions($this->olive, $f['id']), 'the original upload and one autosave');
        $this->assertStringContainsString('11,20', $this->files->readAll($this->files->currentVersion($this->files->node($f['id']))));

        // A new version uploaded by hand: open editors are told to load it again.
        $this->save($this->sam, $f['id'], "a,b\n99,99\n", null);
        $this->assertTrue($this->edit->sync($this->olive, $f['id'], 'olive00000000001', 1, 0, [], null)['reload']);
        $this->assertSame([2, 0, []], [($x = $this->edit->open($this->olive, $f['id'], 'olive00000000001'))['generation'], $x['base_seq'], $x['ops']]);
        $this->edit->leave($this->olive, $f['id'], 'olive00000000001');
        $this->assertNotContains('Olive', array_column($this->edit->sync($this->sam, $f['id'], 'sam0000000000001', 2, 0, [], null)['others'], 'name'));
    }

    public function testChangesAreStoredEncryptedAndTidiedAfterASave(): void
    {
        $f = $this->files->storeBytes($this->olive, null, 'Notes.txt', 'hello');
        $this->edit->open($this->olive, $f['id'], 'olive00000000001');
        $r = $this->edit->sync($this->olive, $f['id'], 'olive00000000001', 1, 0, [['seen' => 0, 'op' => ['t' => 'text', 'next' => 'secret plans']]], null);
        $this->assertStringNotContainsString('secret plans', json_encode($this->app->db->all('SELECT * FROM {file_edit_ops}')));
        $this->save($this->olive, $f['id'], 'secret plans', ['seq' => $r['ops'][0]['seq'], 'generation' => 1]);
        $this->app->db->run('UPDATE {file_edit_ops} SET created_at = ?', [gmdate('Y-m-d H:i:s', time() - 2 * 86400)]);
        $this->edit->cleanup();
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {file_edit_ops}'));
        $this->fails(fn () => $this->edit->sync($this->olive, $f['id'], 'bad', 1, 0, [], null), 422);
        $this->fails(fn () => $this->edit->open($this->sam, $f['id'], 'sam0000000000001'), 404);
    }

    public function testOpeningMidSessionGetsWhatUnsavedChangesWereMadeAgainst(): void
    {
        $f = $this->files->storeBytes($this->olive, null, 'Plan.txt', 'abc');
        $this->files->share($this->olive, $f['id'], $this->sam['id'], null, 'editor');
        $this->edit->open($this->olive, $f['id'], 'olive00000000001');
        $this->edit->open($this->sam, $f['id'], 'sam0000000000001');
        // Both type at once, neither having seen the other's change; then Olive's browser saves up to her own.
        $a = $this->edit->sync($this->olive, $f['id'], 'olive00000000001', 1, 0, [['seen' => 0, 'op' => ['t' => 'text', 'at' => 0, 'del' => 0, 'ins' => 'X']]], null);
        $this->edit->sync($this->sam, $f['id'], 'sam0000000000001', 1, 0, [['seen' => 0, 'op' => ['t' => 'text', 'at' => 3, 'del' => 0, 'ins' => 'Y']], ['seen' => 0, 'op' => ['t' => 'text', 'at' => 4, 'del' => 0, 'ins' => 'Z']]], null);
        $this->save($this->olive, $f['id'], 'Xabc', ['seq' => $a['ops'][0]['seq'], 'generation' => 1]);
        $k = $this->edit->open($this->sam, $f['id'], 'sam0000000000002');
        $this->assertSame($a['ops'][0]['seq'], $k['base_seq']);
        $this->assertSame(['Y', 'Z'], array_column(array_column($k['ops'], 'op'), 'ins'), "Sam's two, one after the other");
        $this->assertSame($k['ops'][0]['seq'] + 1, $k['ops'][1]['seq'], 'one batch is stored together');
        $this->assertSame(['X'], array_column(array_column($k['context'], 'op'), 'ins'), 'the saved change they were made without seeing');
    }

    public function testComments(): void
    {
        $f = $this->files->storeBytes($this->olive, null, 'Plan.docx', 'PK');
        $this->files->share($this->olive, $f['id'], $this->kim['id'], null, 'viewer');
        $c = $this->edit->comment($this->kim, $f['id'], 'block:b1', 'Should this be £12?', null);
        $this->assertSame(['Kim', 'block:b1', false], [$c[0]['by'], $c[0]['anchor'], $c[0]['resolved']]);
        $c = $this->edit->comment($this->olive, $f['id'], '', 'Yes, from March.', $c[0]['id']);
        $this->assertSame($c[0]['id'], $c[1]['parent_id']);
        $this->assertTrue($this->edit->resolve($this->olive, $c[0]['id'], true)[0]['resolved']);
        $this->fails(fn () => $this->edit->deleteComment($this->kim, $c[1]['id']), 403); // not hers, and she can only view
        $this->assertSame([], $this->edit->deleteComment($this->olive, $c[0]['id']), 'with its replies');
        $this->assertStringNotContainsString('£12', json_encode($this->app->db->all('SELECT * FROM {file_comments}')));
    }
}
