<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Where encrypted file bodies are kept: this server's disk, or an S3-compatible bucket. Objects are written in
 * parts (an upload arrives in pieces, over several requests), then completed; read back by byte range.
 * $state is the store's own bookkeeping for an upload in progress (S3's upload ID and parts), kept by the caller.
 */
interface FileStore
{
    public function name(): string;

    public function begin(string $key): array;

    /** Add part $part (1, 2, …) of the object. Returns the new state. */
    public function append(string $key, array $state, string $bytes, int $part): array;

    public function complete(string $key, array $state): void;

    public function abort(string $key, array $state): void;

    public function read(string $key, int $offset, int $length): string;

    public function delete(string $key): void;

    /** The stored object's size, or null when it isn't there. */
    public function size(string $key): ?int;
}
