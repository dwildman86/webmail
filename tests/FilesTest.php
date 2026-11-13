<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\FileCrypto;
use Webmail\FileLinks;
use Webmail\Files;
use Webmail\HttpError;
use Webmail\LocalStore;
use Webmail\Mailstore;
use Webmail\S3Store;
use Webmail\Vault;

final class FilesTest extends TestCase
{
    private Files $files;
    private array $olive;
    private array $sam;
    private array $kim;
    private string $root;
    private bool $plan = true;
    /** The fake bucket: object key → bytes; multipart uploads in progress. */
    private array $bucket = [];
    private array $multipart = [];
    private int $s3Requests = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->answers['GET /v1/me'] = fn () => [200, ['account' => ['id' => 'acc'], 'features' => ['files' => $this->plan]]];
        $this->root = sys_get_temp_dir() . '/wmfiles-' . bin2hex(random_bytes(4));
        Files::$stores = ['local' => new LocalStore($this->root), 's3' => $this->fakeS3()];
        $auth = new Auth($this->app);
        $mk = fn ($email, $name, $role = 'user') => ['id' => $auth->createUser($email, $name, 'correct horse battery', $role), 'role' => $role, 'name' => $name, 'email' => $email];
        $this->olive = $mk('olive@acme.test', 'Olive', 'admin');
        $this->sam = $mk('sam@acme.test', 'Sam');
        $this->kim = $mk('kim@acme.test', 'Kim');
        $this->files = new Files($this->app);
    }

    protected function tearDown(): void
    {
        Files::$stores = [];
        exec('rm -rf ' . escapeshellarg($this->root));
        parent::tearDown();
    }

    private function fakeS3(): S3Store
    {
        return new S3Store(['endpoint' => 'https://s3.test', 'region' => 'eu-west-2', 'bucket' => 'files', 'access_key' => 'AK', 'secret_key' => 'SK', 'path_style' => true],
            function (string $method, string $url, array $headers, string $body) {
                $this->s3Requests++;
                TestCase::assertStringStartsWith('AWS4-HMAC-SHA256 Credential=AK/', $headers['authorization']);
                TestCase::assertSame(hash('sha256', $body), $headers['x-amz-content-sha256']);
                $u = parse_url($url);
                parse_str($u['query'] ?? '', $q);
                $key = substr($u['path'], strlen('/files/'));
                if ($method === 'POST' && array_key_exists('uploads', $q)) {
                    $id = bin2hex(random_bytes(6));
                    $this->multipart[$id] = [];
                    return [200, [], "<InitiateMultipartUploadResult><UploadId>$id</UploadId></InitiateMultipartUploadResult>"];
                }
                if ($method === 'PUT' && isset($q['partNumber'])) {
                    $this->multipart[$q['uploadId']][(int) $q['partNumber']] = $body;
                    return [200, ['etag' => '"' . md5($body) . '"'], ''];
                }
                if ($method === 'POST' && isset($q['uploadId'])) {
                    ksort($this->multipart[$q['uploadId']]);
                    $this->bucket[$key] = implode('', $this->multipart[$q['uploadId']]);
                    unset($this->multipart[$q['uploadId']]);
                    return [200, [], '<CompleteMultipartUploadResult/>'];
                }
                if ($method === 'DELETE') {
                    unset($this->bucket[$key], $this->multipart[$q['uploadId'] ?? '']);
                    return [204, [], ''];
                }
                if (!isset($this->bucket[$key])) {
                    return [404, [], '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>'];
                }
                if ($method === 'HEAD') {
                    return [200, ['content-length' => (string) strlen($this->bucket[$key])], ''];
                }
                preg_match('/bytes=(\d+)-(\d+)/', $headers['range'] ?? '', $m);
                return [206, [], $m ? substr($this->bucket[$key], (int) $m[1], (int) $m[2] - (int) $m[1] + 1) : $this->bucket[$key]];
            });
    }

    private function upload(array $user, ?int $parent, string $name, string $bytes, ?int $nodeId = null, bool $vault = false): array
    {
        $start = $this->files->startUpload($user, $parent, $name, strlen($bytes), $nodeId, $vault);
        if (!empty($start['done'])) {
            return $start['file'];
        }
        foreach (str_split($bytes, Files::UPLOAD_PIECE) as $i => $piece) {
            $r = $this->files->appendUpload($user, $start['upload'], $i * Files::UPLOAD_PIECE, $piece);
        }
        return $r['file'];
    }

    private function read(int $id, ?int $start = null, ?int $end = null): string
    {
        $node = $this->files->node($id);
        $v = $this->files->currentVersion($node);
        $buf = '';
        $this->files->readRange($v, $start ?? 0, $end ?? (int) $v['size'] - 1, function ($s) use (&$buf) {
            $buf .= $s;
        });
        return $buf;
    }

    private function fails(callable $fn, int $status, string $contains = ''): void
    {
        try {
            $fn();
            $this->fail("Expected HTTP $status");
        } catch (HttpError $e) {
            $this->assertSame($status, $e->status, $e->getMessage());
            $contains && $this->assertStringContainsString($contains, $e->getMessage());
        }
    }

    public function testEncryptedChunksCantBeAlteredMovedOrCutShort(): void
    {
        $key = FileCrypto::newKey();
        $plain = random_bytes(FileCrypto::CHUNK * 2 + 100);
        $sealed = FileCrypto::sealRun($key, 'obj1', 0, $plain, true);
        $this->assertSame(FileCrypto::storedSize(strlen($plain)), strlen($sealed));
        $chunk = FileCrypto::CHUNK + FileCrypto::TAG;
        $this->assertSame(substr($plain, FileCrypto::CHUNK, FileCrypto::CHUNK), FileCrypto::openChunk($key, 'obj1', 1, substr($sealed, $chunk, $chunk), false));
        foreach ([
            'another file' => fn () => FileCrypto::openChunk($key, 'obj2', 1, substr($sealed, $chunk, $chunk), false),
            'moved' => fn () => FileCrypto::openChunk($key, 'obj1', 0, substr($sealed, $chunk, $chunk), false),
            'cut short (a middle chunk passed off as the last)' => fn () => FileCrypto::openChunk($key, 'obj1', 1, substr($sealed, $chunk, $chunk), true),
            'altered' => fn () => FileCrypto::openChunk($key, 'obj1', 0, substr_replace($sealed, chr(ord($sealed[5]) ^ 1), 5, 1), false),
        ] as $what => $try) {
            try {
                $try();
                $this->fail("Opened when $what");
            } catch (\RuntimeException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testUploadsInPiecesStoredEncryptedAndReadBackByRange(): void
    {
        $bytes = random_bytes(Files::UPLOAD_PIECE + 200_000); // two pieces, the second short
        $f = $this->upload($this->olive, null, 'Big report.bin', $bytes);
        $this->assertSame(['file', 'Big report.bin', strlen($bytes)], [$f['kind'], $f['name'], $f['size']]);
        $this->assertSame($bytes, $this->read($f['id']));
        // Across chunk boundaries.
        $this->assertSame(substr($bytes, 65530, 20), $this->read($f['id'], 65530, 65549));
        $this->assertSame(substr($bytes, -10), $this->read($f['id'], strlen($bytes) - 10));
        // On disk: ciphertext only, under a random name, with nothing of the file name.
        $v = $this->app->db->one('SELECT * FROM {file_versions} WHERE node_id = ?', [$f['id']]);
        $disk = file_get_contents($this->root . '/' . substr($v['object_key'], 0, 2) . '/' . substr($v['object_key'], 2, 2) . '/' . $v['object_key']);
        $this->assertSame(FileCrypto::storedSize(strlen($bytes)), strlen($disk));
        $this->assertStringNotContainsString(substr($bytes, 1000, 64), $disk);
        $this->assertStringNotContainsString('Big report', json_encode($this->app->db->all('SELECT * FROM {file_nodes}')));
        // Empty files, and a retried piece answered with where to carry on.
        $this->assertSame(0, $this->upload($this->olive, null, 'empty.txt', '')['size']);
        $start = $this->files->startUpload($this->olive, null, 'x.bin', 10);
        $this->assertSame(['received' => 0, 'done' => false], $this->files->appendUpload($this->olive, $start['upload'], 5, '12345'));
        $this->fails(fn () => $this->files->appendUpload($this->olive, $start['upload'], 0, '12345678901'), 422, "doesn't fit");
        $this->fails(fn () => $this->files->appendUpload($this->sam, $start['upload'], 0, '1234567890'), 404);
    }

    public function testFoldersNamesTypesQuotaAndRules(): void
    {
        $docs = $this->files->createFolder($this->olive, null, 'Docs');
        $this->fails(fn () => $this->files->createFolder($this->olive, null, 'docs'), 409, 'already');
        $this->fails(fn () => $this->files->createFolder($this->olive, null, '..'), 422);
        $this->assertSame('a b', Files::cleanName("a/\x00b"));
        $a = $this->upload($this->olive, $docs['id'], 'notes.txt', 'hello');
        $b = $this->upload($this->olive, $docs['id'], 'notes.txt', 'again');
        $this->assertSame(['notes.txt', 'notes (2).txt'], [$a['name'], $b['name']]);
        $this->assertSame('text/plain', $a['mime'], 'from the contents');
        $this->assertSame('%PDF', substr($this->read($this->upload($this->olive, null, 'x.pdf', "%PDF-1.4\n%fake")['id']), 0, 4));
        $this->assertSame(['Docs', 'x.pdf'], array_column($this->files->list($this->olive, [])['items'], 'name'), 'folders first');
        $this->assertSame(['notes (2).txt', 'notes.txt'], array_column($this->files->list($this->olive, ['folder' => $docs['id']])['items'], 'name'));
        $this->assertSame(['notes (2).txt', 'notes.txt'], array_column($this->files->list($this->olive, ['view' => 'search', 'q' => 'NOTES'])['items'], 'name'));

        $this->files->saveSettings(['quota_user_mb' => 1, 'max_file_mb' => 1, 'blocked' => '.exe, BAT']);
        $this->fails(fn () => $this->files->startUpload($this->olive, null, 'big.bin', 2 * 1024 * 1024), 413, 'bigger than');
        $this->fails(fn () => $this->files->startUpload($this->olive, null, 'tool.exe', 10), 422, '.exe');
        $this->upload($this->olive, null, 'most.bin', str_repeat('x', 1024 * 1024 - 200));
        $this->fails(fn () => $this->files->startUpload($this->olive, null, 'more.bin', 1000), 507, 'room');

        // No GhostParse plan: what's stored can be read and deleted, nothing added.
        $this->plan = false;
        $this->files->allowed(true);
        $this->fails(fn () => $this->files->createFolder($this->olive, null, 'New'), 402, 'GhostParse plan');
        $this->assertSame('hello', $this->read($a['id']));
        $this->files->trash($this->olive, $a['id']);
        $this->assertFalse($this->files->list($this->olive, [])['allowed']);
    }

    public function testSharingWithPeopleAndMailboxTeamsInheritedDownFolders(): void
    {
        $team = $this->files->createFolder($this->olive, null, 'Team');
        $inner = $this->files->createFolder($this->olive, $team['id'], 'Inner');
        $f = $this->upload($this->olive, $inner['id'], 'plan.txt', 'the plan');
        $this->fails(fn () => $this->files->need($this->sam, $f['id']), 404);

        $this->files->share($this->olive, $team['id'], $this->sam['id'], null, 'viewer');
        $this->assertSame('viewer', $this->files->need($this->sam, $f['id'])['role'], 'inherited from the folder above');
        $this->assertSame(['Team'], array_column($this->files->list($this->sam, ['view' => 'shared'])['items'], 'name'));
        $this->fails(fn () => $this->files->rename($this->sam, $f['id'], 'mine.txt'), 403, 'view, not to change');
        $this->fails(fn () => $this->upload($this->sam, $inner['id'], 'x.txt', 'x'), 403);

        // Everyone who reads support@ can edit, and what they add is Olive's (her quota).
        $support = (new Mailstore($this->app))->createMailbox('support@acme.test');
        (new Mailstore($this->app))->grant($this->kim['id'], $support);
        $this->files->share($this->olive, $team['id'], null, $support, 'editor');
        $added = $this->upload($this->kim, $inner['id'], 'from kim.txt', 'hi');
        $this->assertSame($this->olive['id'], $this->files->node($added['id'])['owner_id']);
        $this->files->rename($this->kim, $f['id'], 'plan v2.txt');
        $this->fails(fn () => $this->files->move($this->kim, $f['id'], null), 403, 'owner');
        $this->fails(fn () => $this->files->move($this->olive, $team['id'], $inner['id']), 422, 'inside itself');
        // Kim deletes: it's in Olive's bin, not Kim's; only Olive can restore it.
        $this->files->trash($this->kim, $f['id']);
        $this->assertSame([], $this->files->list($this->kim, ['view' => 'trash'])['items']);
        $this->assertSame(['plan v2.txt'], array_column($this->files->list($this->olive, ['view' => 'trash'])['items'], 'name'));
        $this->fails(fn () => $this->files->restore($this->kim, $f['id']), 403, 'owner');
        $this->files->restore($this->olive, $f['id']);

        $shares = $this->files->shares($this->olive, $team['id'])['people'];
        $this->assertSame(['Sam', 'Everyone with support@acme.test'], array_column($shares, 'label'));
        $this->files->unshare($this->sam, $shares[0]['id']); // people can remove themselves
        $this->fails(fn () => $this->files->need($this->sam, $team['id']), 404);
    }

    public function testBinVersionsAndDeletingForGood(): void
    {
        $folder = $this->files->createFolder($this->olive, null, 'Old');
        $f = $this->upload($this->olive, $folder['id'], 'a.txt', 'one');
        $this->upload($this->olive, null, 'ignored', 'x', $f['id']);
        $this->upload($this->olive, null, 'ignored', 'three', $f['id']);
        $this->assertSame('three', $this->read($f['id']));
        $versions = $this->files->versions($this->olive, $f['id']);
        $this->assertSame([5, 1, 3], array_column($versions, 'size'));
        $this->files->restoreVersion($this->olive, $f['id'], $versions[2]['id']);
        $this->assertSame('one', $this->read($f['id']));
        $this->files->saveSettings(['versions' => 2]);
        $this->upload($this->olive, null, 'ignored', 'four', $f['id']);
        $this->assertCount(2, $this->files->versions($this->olive, $f['id']), 'older versions pruned');

        $this->files->trash($this->olive, $folder['id']);
        $this->fails(fn () => $this->files->need($this->olive, $f['id']), 404, 'bin');
        $this->assertSame([], $this->files->list($this->olive, [])['items']);
        $objects = array_column($this->app->db->all('SELECT object_key FROM {file_versions}'), 'object_key');
        $this->files->deleteForever($this->olive, $folder['id']);
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {file_nodes}'));
        foreach ($objects as $o) {
            $this->assertNull((new LocalStore($this->root))->size($o), 'deleted from the disk too');
        }
        $this->assertSame(0, $this->files->usage($this->olive['id'])['used']);
    }

    public function testS3StoreAndMovingFilesBetweenStores(): void
    {
        $local = $this->upload($this->olive, null, 'before.bin', $before = random_bytes(Files::UPLOAD_PIECE + 5));
        $this->files->saveSettings(['s3' => ['endpoint' => 'https://s3.test', 'region' => 'eu-west-2', 'bucket' => 'files', 'access_key' => 'AK', 'secret_key' => 'SK', 'path_style' => true]]);
        $this->assertTrue($this->files->publicSettings()['s3']['secret_set']);
        $this->assertArrayNotHasKey('secret_enc', $this->files->publicSettings()['s3']);
        $this->files->saveSettings(['store' => 's3']); // tested first
        $s3 = $this->upload($this->olive, null, 'after.bin', $after = random_bytes(100_000));
        $this->assertSame($after, $this->read($s3['id']));
        $this->assertCount(1, $this->bucket);
        $this->assertStringNotContainsString(substr($after, 0, 32), implode('', $this->bucket));
        $this->assertSame(['local' => 1, 's3' => 1], array_map(fn ($c) => $c['files'], $this->files->storeStatus()['stored']));

        $this->files->setMoving(true);
        $this->assertTrue($this->files->moveDue());
        $this->assertSame(['moved' => 1, 'left' => 0], $this->files->moveStep());
        $this->assertSame($before, $this->read($local['id']), 'still opens, now from the bucket');
        $this->assertFalse($this->files->moveDue());
        $this->assertCount(2, $this->bucket);
    }

    public function testShareLinksOffUntilTurnedOnWithPasswordExpiryAndLimit(): void
    {
        $links = new FileLinks($this->app);
        $f = $this->upload($this->olive, null, 'brochure.pdf', '%PDF-1.4 brochure');
        $this->fails(fn () => $links->create($this->olive, $f['id'], 'view', null, null, null), 403, 'turned off');
        $this->files->saveSettings(['links' => true, 'links_max_days' => 7, 'links_password' => true]);
        $this->fails(fn () => $links->create($this->olive, $f['id'], 'view', null, null, null), 422, 'password');
        $this->fails(fn () => $links->create($this->olive, $f['id'], 'view', 'secret!', 30, null), 422, 'up to 7 days');
        $l = $links->create($this->olive, $f['id'], 'view', 'secret!', null, 2);
        $this->assertSame([true, 2], [$l['password'], $l['max_downloads']]);
        $token = substr($l['url'], strpos($l['url'], 't=') + 2);
        $this->assertSame(43, strlen($token), '256 bits');
        $this->assertStringNotContainsString($token, json_encode($this->app->db->all('SELECT * FROM {file_links}')), 'only its hash and an encrypted copy are kept');

        [$link, $node] = $links->resolve($token);
        $this->assertSame($f['id'], (int) $node['id']);
        $this->assertFalse($links->unlocked($link));
        $this->assertFalse(@$links->unlock($link, 'wrong'));
        $this->assertTrue(@$links->unlock($link, 'secret!'));
        $links->counted($link);
        $links->counted($link);
        $this->fails(fn () => $links->resolve($token), 410, 'as many times');
        $this->fails(fn () => $links->resolve(str_repeat('A', 43)), 404);

        $l2 = $links->create($this->olive, $f['id'], 'view', 'another', 1, null);
        $t2 = substr($l2['url'], strpos($l2['url'], 't=') + 2);
        $this->app->db->run('UPDATE {file_links} SET expires_at = ? WHERE id = ?', [gmdate('Y-m-d H:i:s', time() - 60), $l2['id']]);
        $this->fails(fn () => $links->resolve($t2), 410, 'expired');
        // Turned off by an administrator: every link stops at once.
        $l3 = $links->create($this->olive, $f['id'], 'view', 'third!', null, null);
        $this->files->saveSettings(['links' => false]);
        $this->fails(fn () => $links->resolve(substr($l3['url'], strpos($l3['url'], 't=') + 2)), 404);
        $this->files->saveSettings(['links' => true]);
        $this->assertSame(3, $links->revokeEverything(), 'used up and expired ones too');
    }

    public function testFileRequestsTakeFilesButNotRiskyOnes(): void
    {
        $links = new FileLinks($this->app);
        $this->files->saveSettings(['links' => true]);
        $inbox = $this->files->createFolder($this->olive, null, 'Customer uploads');
        $f = $this->upload($this->olive, null, 'single.txt', 'x');
        $this->fails(fn () => $links->create($this->olive, $f['id'], 'request', null, null, null), 422, 'folder');
        $l = $links->create($this->olive, $inbox['id'], 'request', null, null, null);
        [$link] = $links->resolve(substr($l['url'], strpos($l['url'], 't=') + 2));
        $this->fails(fn () => $this->files->startUpload(null, null, 'invoice.exe', 10, null, false, $link), 422, '.exe');
        $start = $this->files->startUpload(null, null, 'photo.jpg', 4, null, false, $link);
        $r = $this->files->appendUpload(null, $start['upload'], 0, "\xFF\xD8\xFF\xE0", $link);
        $this->assertTrue($r['done']);
        $this->assertSame(['photo.jpg'], array_column($this->files->list($this->olive, ['folder' => $inbox['id']])['items'], 'name'));
        $this->assertSame('Someone with a link', $this->files->versions($this->olive, $r['file']['id'])[0]['by']);
    }

    public function testTheVaultIsOnlyItsOwnersAndNeverShared(): void
    {
        $vault = new Vault($this->app);
        $wrapped = json_encode(['salt' => 'x', 'iv' => 'y', 'ct' => 'z']);
        $this->fails(fn () => $vault->setup($this->olive, [['method' => 'passphrase', 'wrapped' => $wrapped]]), 422, 'recovery key');
        $vault->setup($this->olive, [['method' => 'passphrase', 'wrapped' => $wrapped], ['method' => 'recovery', 'wrapped' => $wrapped]]);
        $this->assertCount(2, $vault->keys($this->olive));
        $this->assertSame([], $vault->keys($this->sam));
        $this->fails(fn () => $vault->remove($this->olive, $vault->keys($this->olive)[0]['id']), 422, 'at least one');

        $box = $this->files->createFolder($this->olive, null, 'ciphertext-name', true);
        $file = $this->upload($this->olive, $box['id'], 'ct', 'opaque-bytes', null, true);
        $this->assertSame([], $this->files->list($this->olive, [])['items'], 'not among ordinary files');
        $this->assertSame([$box['id']], array_column($this->files->list($this->olive, ['view' => 'vault'])['items'], 'id'));
        $this->fails(fn () => $this->files->share($this->olive, $box['id'], $this->sam['id'], null, 'viewer'), 422, 'only you');
        $this->files->saveSettings(['links' => true]);
        $this->fails(fn () => (new FileLinks($this->app))->create($this->olive, $file['id'], 'view', null, null, null), 422, 'only you');
        $this->fails(fn () => $this->upload($this->olive, $box['id'], 'plain', 'x'), 422, 'vault');
        $this->fails(fn () => $this->files->need($this->kim, $file['id']), 404);
        $vault->reset($this->olive);
        $this->assertSame(0, (int) $this->app->db->value('SELECT COUNT(*) FROM {file_nodes}'));
        $this->assertFalse($vault->status($this->olive)['set_up']);
    }

    public function testHousekeeping(): void
    {
        $f = $this->upload($this->olive, null, 'old.txt', 'x');
        $this->files->trash($this->olive, $f['id']);
        $this->app->db->run('UPDATE {file_nodes} SET trashed_at = ?', [gmdate('Y-m-d H:i:s', time() - 31 * 86400)]);
        $start = $this->files->startUpload($this->olive, null, 'abandoned.bin', Files::UPLOAD_PIECE + 1);
        $this->app->db->run('UPDATE {file_uploads} SET created_at = ?', [gmdate('Y-m-d H:i:s', time() - 2 * 86400)]);
        $this->assertTrue($this->files->cleanupDue());
        $this->files->cleanup();
        $this->assertSame([0, 0], [(int) $this->app->db->value('SELECT COUNT(*) FROM {file_nodes}'), (int) $this->app->db->value('SELECT COUNT(*) FROM {file_uploads}')]);
        $this->assertNotEmpty($start['upload']);
    }
}
