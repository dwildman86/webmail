<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\InstallError;
use Webmail\Installer;

final class InstallerTest extends TestCase
{
    private function fails(callable $fn, string $pattern): void
    {
        try {
            $fn();
            $this->fail("no error, expected $pattern");
        } catch (InstallError $e) {
            $this->assertMatchesRegularExpression($pattern, $e->getMessage());
        }
    }

    public function testTheAdministratorIsChecked(): void
    {
        $ok = Installer::checkAdmin(['email' => ' olive@acme.test ', 'password' => 'correct horse', 'base_url' => 'https://acme.test/mail/']);
        $this->assertSame(['name' => 'olive', 'email' => 'olive@acme.test', 'password' => 'correct horse', 'app_name' => 'Webmail', 'base_url' => 'https://acme.test/mail'], $ok);
        $this->fails(fn () => Installer::checkAdmin(['email' => 'nope', 'password' => 'correct horse', 'base_url' => 'https://a.test']), '/valid email/');
        $this->fails(fn () => Installer::checkAdmin(['email' => 'o@a.test', 'password' => 'short', 'base_url' => 'https://a.test']), '/10 characters/');
        $this->fails(fn () => Installer::checkAdmin(['email' => 'o@a.test', 'password' => 'correct horse', 'base_url' => 'mail']), '/address this webmail is at/');
    }

    public function testADatabaseWithWebmailTablesIsRefused(): void
    {
        // The test database already has the tables (setUp migrates it).
        $this->fails(fn () => Installer::checkDatabase($this->config['db']), '/already has webmail tables with the prefix wm_/');
        $other = Installer::checkDatabase(['prefix' => 'mail2-'] + $this->config['db']);
        $this->assertSame('mail2', $other['prefix'], 'prefix tidied');
        $this->fails(fn () => Installer::checkDatabase(['name' => ''] + $this->config['db']), '/database name and user/');
        $this->fails(fn () => Installer::checkDatabase(['pass' => 'wrong-password'] + $this->config['db']), "/^Can't connect to the database: /");
    }

    public function testTheGhostParseSecretIsCheckedBeforeCallingIt(): void
    {
        $this->fails(fn () => Installer::checkGhostParse(['api_url' => 'ghostparse.com', 'api_key' => 'x', 'webhook_secret' => 'x']), '/GhostParse address/');
        $this->fails(fn () => Installer::checkGhostParse(['api_url' => 'https://gp.test', 'api_key' => 'x', 'webhook_secret' => 'secret']), '/starts with whsec_/');
    }

    public function testTheCommandLineInstallerOnlyRunsFromTheCommandLine(): void
    {
        $this->assertStringContainsString("if (PHP_SAPI !== 'cli') {\n    http_response_code(404);", file_get_contents(dirname(__DIR__) . '/install-cli.php'));
        $this->assertStringContainsString('install-cli\.php', file_get_contents(dirname(__DIR__) . '/.htaccess'));
    }
}
