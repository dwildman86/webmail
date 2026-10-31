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

    public function testANewAddressCanBeMadeAtGhostParse(): void
    {
        $this->answers['GET /v1/domains'] = fn () => [200, ['domains' => [
            ['id' => 'dom_1', 'name' => 'acme.test', 'inbound_ready' => true, 'addresses' => []],
            ['id' => 'dom_2', 'name' => 'new.test', 'inbound_ready' => false, 'addresses' => []],
        ]]];
        $this->answers['POST /v1/domains/dom_1/addresses'] = fn ($b) => [201, ['id' => 'adr_1', 'address' => $b['local_part'] . '@acme.test']];
        $gp = $this->app->gp;
        $this->assertSame([['id' => 'dom_1', 'name' => 'acme.test', 'ready' => true], ['id' => 'dom_2', 'name' => 'new.test', 'ready' => false]], Installer::domains($gp));

        // The part before the @, or the whole address on that domain; receiving and sending.
        $this->assertSame('sales@acme.test', Installer::createAddress($gp, 'dom_1', ' Sales '));
        $this->assertSame(['local_part' => 'sales', 'can_receive' => true, 'can_send' => true], end($this->requests)['body']);
        $this->assertSame('hello@acme.test', Installer::createAddress($gp, 'dom_1', 'hello@ACME.test'));

        // Checked before GhostParse is asked.
        $before = count($this->requests);
        $this->fails(fn () => Installer::createAddress($gp, 'dom_9', 'sales'), '/Choose one of your domains/');
        $this->fails(fn () => Installer::createAddress($gp, 'dom_1', '  '), '/part before the @/');
        $this->fails(fn () => Installer::createAddress($gp, 'dom_1', 'sales@other.test'), "/can't be an address/");
        $this->fails(fn () => Installer::createAddress($gp, 'dom_1', '*'), "/can't be an address/");
        $this->fails(fn () => Installer::createAddress($gp, 'dom_1', 'a..b'), "/can't be an address/");
        $this->assertSame(0, count(array_filter(array_slice($this->requests, $before), fn ($r) => $r['method'] === 'POST')));

        // GhostParse's own refusal is passed on.
        $this->answers['POST /v1/domains/dom_1/addresses'] = fn () => [409, ['error' => 'address_exists', 'message' => 'sales@acme.test is already on the list']];
        $this->fails(fn () => Installer::createAddress($gp, 'dom_1', 'sales'), "/GhostParse didn't add sales@acme.test: sales@acme.test is already on the list/");
    }
}
