<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Files on this server's disk, in storage/files (which the web server is told never to serve: storage/.htaccess).
 * Only ciphertext, under random names, two directory levels deep so no folder gets huge.
 */
final class LocalStore implements FileStore
{
    public function __construct(private ?string $root = null)
    {
        $this->root ??= dirname(__DIR__) . '/storage/files';
    }

    public function name(): string
    {
        return 'local';
    }

    private function path(string $key): string
    {
        if (!preg_match('/^[a-z0-9]{20,80}$/', $key)) {
            throw new \InvalidArgumentException('Bad object name');
        }
        return $this->root . '/' . substr($key, 0, 2) . '/' . substr($key, 2, 2) . '/' . $key;
    }

    public function begin(string $key): array
    {
        $path = $this->path($key);
        if (!is_dir(dirname($path)) && !@mkdir(dirname($path), 0700, true) && !is_dir(dirname($path))) {
            throw new HttpError(500, "Files can't be saved: the storage folder isn't writable. Ask your administrator.", 'storage_unwritable');
        }
        if (@file_put_contents("$path.part", '') === false) {
            throw new HttpError(500, "Files can't be saved: the storage folder isn't writable. Ask your administrator.", 'storage_unwritable');
        }
        return ['bytes' => 0];
    }

    public function append(string $key, array $state, string $bytes, int $part): array
    {
        $path = $this->path($key) . '.part';
        clearstatcache(true, $path);
        if (!is_file($path) || filesize($path) !== (int) $state['bytes']) {
            throw new \RuntimeException('The upload in progress is out of step');
        }
        if (@file_put_contents($path, $bytes, FILE_APPEND | LOCK_EX) !== strlen($bytes)) {
            throw new HttpError(507, "The file couldn't be saved: the server's disk may be full.", 'storage_full');
        }
        return ['bytes' => (int) $state['bytes'] + strlen($bytes)];
    }

    public function complete(string $key, array $state): void
    {
        $path = $this->path($key);
        if (!@rename("$path.part", $path)) {
            throw new \RuntimeException("The upload couldn't be finished");
        }
    }

    public function abort(string $key, array $state): void
    {
        @unlink($this->path($key) . '.part');
    }

    public function read(string $key, int $offset, int $length): string
    {
        $f = @fopen($this->path($key), 'rb');
        if (!$f) {
            throw new \RuntimeException('A stored file is missing');
        }
        fseek($f, $offset);
        $out = '';
        while (strlen($out) < $length && !feof($f)) {
            $out .= (string) fread($f, $length - strlen($out));
        }
        fclose($f);
        return $out;
    }

    public function delete(string $key): void
    {
        @unlink($this->path($key));
        @unlink($this->path($key) . '.part');
    }

    public function size(string $key): ?int
    {
        $path = $this->path($key);
        clearstatcache(true, $path);
        return is_file($path) ? (int) filesize($path) : null;
    }
}
