<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\App;
use Webmail\Config;
use Webmail\Crypto;
use Webmail\Db;
use Webmail\GhostParse;
use Webmail\Schema;

/**
 * Each test gets its own MySQL database (TEST_DB_DSN: mysql://user:pass@host:port) and a stand-in for the GhostParse
 * API that records requests and answers from $this->answers.
 */
abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    protected App $app;
    protected array $requests = [];
    /** @var array<string, callable> "METHOD /path" => fn(array $body): array [status, json] */
    protected array $answers = [];
    protected array $config;
    private string $dbName;
    private \PDO $admin;

    protected function setUp(): void
    {
        $url = parse_url(getenv('TEST_DB_DSN') ?: 'mysql://emailparser:devpass@127.0.0.1:3306');
        $this->admin = new \PDO(sprintf('mysql:host=%s;port=%d', $url['host'], $url['port'] ?? 3306), $url['user'], $url['pass'] ?? '');
        $this->dbName = 'wm_test_' . bin2hex(random_bytes(5));
        $this->admin->exec("CREATE DATABASE `{$this->dbName}` CHARACTER SET utf8mb4");
        $this->config = [
            'db' => ['host' => $url['host'], 'port' => $url['port'] ?? 3306, 'name' => $this->dbName, 'user' => $url['user'], 'pass' => $url['pass'] ?? '', 'prefix' => 'wm_'],
            'key' => base64_encode(Crypto::newKey()),
            'base_url' => 'https://mail.example.com/webmail',
            'ghostparse' => ['api_url' => 'https://api.ghostparse.test', 'api_key' => 'ek_live_test', 'webhook_secret' => 'whsec_' . base64_encode(random_bytes(24))],
        ];
        $config = new Config($this->config);
        $gp = new GhostParse('https://api.ghostparse.test', 'ek_live_test', function (string $method, string $url, array $headers, ?string $payload) {
            $path = parse_url($url, PHP_URL_PATH);
            $body = $payload === null ? null : json_decode($payload, true);
            $this->requests[] = ['method' => $method, 'path' => $path, 'body' => $body, 'headers' => $headers, 'raw' => $body === null ? $payload : null];
            $answer = $this->answers["$method $path"] ?? null;
            if (!$answer) {
                return [404, json_encode(['error' => 'not_found', 'message' => "No answer for $method $path"])];
            }
            [$status, $json] = $answer($body ?? [], $payload);
            return [$status, json_encode($json)];
        });
        $this->app = new App($config, new Db($this->config['db'], 'wm_'), $gp);
        App::set($this->app);
        Schema::migrate($this->app->db);
    }

    protected function tearDown(): void
    {
        App::set(null);
        $this->admin->exec("DROP DATABASE IF EXISTS `{$this->dbName}`");
    }

    /** An email.received event's data, as GhostParse delivers it. */
    protected function inbound(array $overrides = []): array
    {
        return array_replace([
            'id' => 'inb_' . bin2hex(random_bytes(6)),
            'message_id' => '<' . bin2hex(random_bytes(6)) . '@customer.example>',
            'envelope' => ['mail_from' => 'jane@customer.example', 'rcpt_to' => ['support@acme.test'], 'client_ip' => '198.51.100.7'],
            'from' => ['address' => 'jane@customer.example', 'name' => 'Jane Doe'],
            'to' => [['address' => 'support@acme.test', 'name' => 'Acme Support']],
            'cc' => [], 'reply_to' => [],
            'subject' => 'Where is my order #1042?',
            'date' => '2026-10-01T10:00:00.000Z',
            'thread_id' => 'thr_' . bin2hex(random_bytes(6)),
            'text' => "Hi, my parcel hasn't arrived yet.\n\nThanks, Jane",
            'reply_text' => "Hi, my parcel hasn't arrived yet.",
            'html' => '<p>Hi, my parcel hasn\'t arrived yet.</p><p>Thanks, Jane</p>',
            'headers' => ['subject' => 'Where is my order #1042?'],
            'attachments' => [],
            'authentication' => ['verdict' => 'pass'],
            'recipients' => [['address' => 'support@acme.test', 'base_address' => 'support@acme.test', 'tag' => null]],
            'spam' => ['score' => 1.2, 'action' => 'no action'],
            'size' => 2048,
            'received_at' => '2026-10-01T10:00:01.000Z',
        ], $overrides);
    }
}
