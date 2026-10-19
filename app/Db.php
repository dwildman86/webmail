<?php
declare(strict_types=1);

namespace Webmail;

use PDO;

/** PDO for MySQL/MariaDB, with the table prefix applied to {table} placeholders. */
final class Db
{
    public readonly PDO $pdo;

    public function __construct(array $c, public readonly string $prefix = 'wm_')
    {
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], (int) ($c['port'] ?? 3306), $c['name']);
        $this->pdo = new PDO($dsn, $c['user'], $c['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        $this->pdo->exec("SET time_zone = '+00:00'");
    }

    private function sql(string $sql): string
    {
        return preg_replace_callback('/\{(\w+)\}/', fn ($m) => '`' . $this->prefix . $m[1] . '`', $sql);
    }

    /** Run a statement with ? or :name parameters, binding ints, nulls and booleans as their own types. */
    public function run(string $sql, array $params = []): \PDOStatement
    {
        $st = $this->pdo->prepare($this->sql($sql));
        $n = 1;
        foreach ($params as $k => $v) {
            $type = match (true) {
                is_int($v) => PDO::PARAM_INT,
                is_bool($v) => PDO::PARAM_BOOL,
                $v === null => PDO::PARAM_NULL,
                default => PDO::PARAM_STR,
            };
            $st->bindValue(is_int($k) ? $n++ : ':' . $k, $v, $type);
        }
        $st->execute();
        return $st;
    }

    public function one(string $sql, array $params = []): ?array
    {
        $row = $this->run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    public function value(string $sql, array $params = []): mixed
    {
        $v = $this->run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public function insert(string $sql, array $params = []): int
    {
        $this->run($sql, $params);
        return (int) $this->pdo->lastInsertId();
    }

    public function tx(callable $fn): mixed
    {
        $this->pdo->beginTransaction();
        try {
            $out = $fn($this);
            $this->pdo->commit();
            return $out;
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }
}
