<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\App;
use Webmail\HttpError;
use Webmail\Updater;

final class UpdaterTest extends TestCase
{
    private string $root;
    private array $web = [];
    /** The release key these tests sign with, in place of GhostParse's. */
    private static string $secret = '';
    private static string $public = '';

    public static function setUpBeforeClass(): void
    {
        $pair = sodium_crypto_sign_keypair();
        self::$secret = sodium_crypto_sign_secretkey($pair);
        self::$public = base64_encode(sodium_crypto_sign_publickey($pair));
    }

    protected function setUp(): void
    {
        parent::setUp();
        // A webmail install to update: its code, its settings and something stored.
        $this->root = sys_get_temp_dir() . '/wm-update-' . bin2hex(random_bytes(4));
        foreach (['app/App.php' => "<?php const VERSION = '" . App::VERSION . "';", 'index.php' => 'old index', 'api.php' => 'old api', 'assets/app.js' => 'old js',
            'assets/same.css' => 'same', 'config.php' => 'SECRET SETTINGS', 'storage/imports/upload.part' => 'MAIL', 'storage/index.html' => 'guard'] as $f => $c) {
            @mkdir(dirname("$this->root/$f"), 0755, true);
            file_put_contents("$this->root/$f", $c);
        }
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
        parent::tearDown();
    }

    private function release(array $files, string $version = '9.9.9', ?string $signature = null): string
    {
        $zipFile = tempnam(sys_get_temp_dir(), 'wmzip');
        $zip = new \ZipArchive();
        $zip->open($zipFile, \ZipArchive::OVERWRITE);
        foreach ($files as $name => $content) {
            $zip->addFromString($name, $content);
        }
        $zip->close();
        $bytes = file_get_contents($zipFile);
        unlink($zipFile);
        $api = rtrim($this->config['ghostparse']['api_url'], '/');
        $this->web = [
            "$api/downloads/webmail-latest.json" => [200, json_encode(['version' => $version, 'url' => "https://gp.example/downloads/webmail-$version.zip",
                'sha256' => hash('sha256', $bytes), 'size' => strlen($bytes), 'notes' => '- Faster search',
                'signature' => $signature ?? base64_encode(sodium_crypto_sign_detached(Updater::signed($version, hash('sha256', $bytes)), self::$secret))]) ?: ''],
            "https://gp.example/downloads/webmail-$version.zip" => [200, $bytes],
        ];
        return $bytes;
    }

    private function updater(): Updater
    {
        return new Updater($this->app, $this->root, fn (string $url) => $this->web[$url] ?? [404, ''], [self::$public]);
    }

    private function goodFiles(string $version = '9.9.9'): array
    {
        return ['webmail/app/App.php' => "<?php const VERSION = '$version';", 'webmail/index.php' => 'new index', 'webmail/api.php' => 'new api',
            'webmail/assets/app.js' => 'new js', 'webmail/assets/same.css' => 'same', 'webmail/assets/new.svg' => 'new icon',
            'webmail/storage/index.html' => 'new guard', 'webmail/config.php' => 'NOT YOURS'];
    }

    public function testAnAdministratorSeesTheNewReleaseAndInstallsItKeepingSettingsAndStoredFiles(): void
    {
        $this->release($this->goodFiles());
        $u = $this->updater()->check();
        $this->assertSame(['current' => App::VERSION, 'latest' => '9.9.9', 'available' => true, 'notes' => '- Faster search', 'can_update' => true, 'blockers' => []],
            array_diff_key($u, ['checked_at' => 1]));
        $this->web = [];
        $this->assertTrue($this->updater()->check()['available'], 'checked twice a day, not on every visit');

        $this->release($this->goodFiles());
        $this->assertSame(['from' => App::VERSION, 'version' => '9.9.9'], $this->updater()->install());
        $this->assertSame("<?php const VERSION = '9.9.9';", file_get_contents("$this->root/app/App.php"));
        $this->assertSame('new js', file_get_contents("$this->root/assets/app.js"));
        $this->assertSame('new icon', file_get_contents("$this->root/assets/new.svg"));
        $this->assertSame('SECRET SETTINGS', file_get_contents("$this->root/config.php"), 'the settings are never replaced');
        $this->assertSame('MAIL', file_get_contents("$this->root/storage/imports/upload.part"));
        $this->assertSame('guard', file_get_contents("$this->root/storage/index.html"), 'storage keeps what it has');
        $backup = "$this->root/storage/updates/backup-" . App::VERSION;
        $this->assertSame('old js', file_get_contents("$backup/assets/app.js"), 'the old files are kept');
        $this->assertFileDoesNotExist("$backup/assets/same.css", 'unchanged files are left alone');
        $this->assertSame([], glob("$this->root/storage/updates/*.zip"), 'the download is cleaned up');
        $this->assertSame([], glob("$this->root/*/*.update-*") ?: [], 'no half-written files');
    }

    public function testADownloadThatDoesntMatchItsChecksumChangesNothing(): void
    {
        $this->release($this->goodFiles());
        $zipUrl = 'https://gp.example/downloads/webmail-9.9.9.zip';
        $this->web[$zipUrl][1] .= 'tampered';
        try {
            $this->updater()->install();
            $this->fail('installed a tampered download');
        } catch (HttpError $e) {
            $this->assertSame('checksum', $e->errorCode);
        }
        $this->assertSame('old js', file_get_contents("$this->root/assets/app.js"));
    }

    public function testOnlyAReleaseSignedWithTheReleaseKeyIsInstalled(): void
    {
        $other = sodium_crypto_sign_secretkey(sodium_crypto_sign_keypair());
        $bytes = $this->release($this->goodFiles());
        $sha = hash('sha256', $bytes);
        foreach ([
            'unsigned' => '',
            'not base64' => '!!!',
            'signed with another key' => base64_encode(sodium_crypto_sign_detached(Updater::signed('9.9.9', $sha), $other)),
            // A real signature, but for an older release: the version can't be swapped.
            'signed for another version' => base64_encode(sodium_crypto_sign_detached(Updater::signed('9.9.8', $sha), self::$secret)),
            'signed for another zip' => base64_encode(sodium_crypto_sign_detached(Updater::signed('9.9.9', hash('sha256', 'x')), self::$secret)),
        ] as $case => $signature) {
            $this->release($this->goodFiles(), '9.9.9', $signature);
            $check = $this->updater()->check(true);
            $this->assertFalse($check['available'], "$case: offered");
            $this->assertStringContainsString("isn't signed by GhostParse", $check['error'] ?? '', $case);
            try {
                $this->updater()->install();
                $this->fail("installed a release $case");
            } catch (HttpError $e) {
                $this->assertSame('signature', $e->errorCode, $case);
            }
            $this->assertSame('old js', file_get_contents("$this->root/assets/app.js"), $case);
        }
        // GhostParse's own key is built in.
        $this->assertNotEmpty(Updater::RELEASE_KEYS);
        foreach (Updater::RELEASE_KEYS as $key) {
            $this->assertSame(SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES, strlen((string) base64_decode($key, true)));
        }
    }

    public function testAZipThatReachesOutsideTheFolderOrIsntTheWebmailIsRefused(): void
    {
        foreach ([['webmail/../evil.php' => 'x'] + $this->goodFiles(), ['other/app/App.php' => 'x'], ['webmail/index.php' => 'x', 'webmail/api.php' => 'x', 'webmail/app/App.php' => "<?php const VERSION = '1.0.0';"]] as $files) {
            $this->release($files);
            try {
                $this->updater()->install();
                $this->fail('installed ' . implode(', ', array_keys($files)));
            } catch (HttpError $e) {
                $this->assertSame('bad_zip', $e->errorCode);
            }
            $this->assertFileDoesNotExist(dirname($this->root) . '/evil.php');
            $this->assertSame('old index', file_get_contents("$this->root/index.php"));
        }
    }

    public function testIfACopyFailsPartWayTheOldFilesArePutBack(): void
    {
        // A folder where a file has to go: that write fails, after index.php was already replaced.
        mkdir("$this->root/assets/blocked.js");
        $this->release(['webmail/app/App.php' => "<?php const VERSION = '9.9.9';", 'webmail/api.php' => 'new api', 'webmail/index.php' => 'new index',
            'webmail/assets/blocked.js' => 'x', 'webmail/assets/zz.js' => 'later']);
        try {
            $this->updater()->install();
            $this->fail('reported success');
        } catch (HttpError $e) {
            $this->assertStringContainsString('put back as it was', $e->getMessage());
        }
        $this->assertSame('old index', file_get_contents("$this->root/index.php"));
        $this->assertSame("<?php const VERSION = '" . App::VERSION . "';", file_get_contents("$this->root/app/App.php"));
        $this->assertFileDoesNotExist("$this->root/assets/zz.js");
    }

    public function testNothingToDoWhenUpToDateAndANewerOneIsNeverOlder(): void
    {
        $this->release($this->goodFiles(App::VERSION), App::VERSION);
        $this->assertFalse($this->updater()->check(true)['available']);
        $this->expectExceptionMessage('already up to date');
        $this->updater()->install();
    }
}
