<?php
declare(strict_types=1);

namespace Webmail;

/** The app's shared pieces, built once per request from config.php. */
final class App
{
    public const VERSION = '1.7.3';

    private static ?self $instance = null;
    public readonly Db $db;
    public readonly Crypto $crypto;
    public readonly GhostParse $gp;

    public function __construct(public readonly Config $config, ?Db $db = null, ?GhostParse $gp = null)
    {
        $this->db = $db ?? new Db($config->get('db'), $config->get('db')['prefix'] ?? 'wm_');
        $this->crypto = new Crypto($config->masterKey());
        $this->gp = $gp ?? new GhostParse($config->get('ghostparse')['api_url'], $config->get('ghostparse')['api_key']);
    }

    public static function get(): self
    {
        return self::$instance ??= new self(Config::load());
    }

    public static function set(?self $app): void
    {
        self::$instance = $app;
    }

    /** The signing secrets webhooks are accepted with: the current one and, while rotating, the previous one. */
    public function webhookSecrets(): array
    {
        $g = $this->config->get('ghostparse');
        return array_values(array_filter([$g['webhook_secret'] ?? null, $g['previous_webhook_secret'] ?? null]));
    }

    /** The app's public address, e.g. https://example.com/webmail */
    public function baseUrl(): string
    {
        return rtrim((string) $this->config->get('base_url'), '/');
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }
}
