<?php
declare(strict_types=1);

namespace Webmail;

/** Settings written by the installer to config.php (outside the database, with the encryption key). */
final class Config
{
    public function __construct(private array $values)
    {
    }

    public static function path(): string
    {
        return getenv('WEBMAIL_CONFIG') ?: dirname(__DIR__) . '/config.php';
    }

    public static function installed(): bool
    {
        return is_file(self::path());
    }

    public static function load(): self
    {
        $values = require self::path();
        if (!is_array($values)) {
            throw new \RuntimeException('config.php is damaged');
        }
        return new self($values);
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->values[$key] ?? $default;
    }

    public function all(): array
    {
        return $this->values;
    }

    public function masterKey(): string
    {
        return sodium_base642bin($this->values['key'], SODIUM_BASE64_VARIANT_ORIGINAL);
    }

    /** config.php as PHP source: a file the web server runs, never shows. */
    public static function render(array $values): string
    {
        return "<?php\n// Written by the installer. Keep it private and back it up: without 'key', the stored mail can't be read.\nreturn "
            . var_export($values, true) . ";\n";
    }
}
