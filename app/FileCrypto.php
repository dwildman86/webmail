<?php
declare(strict_types=1);

namespace Webmail;

/**
 * How Files are encrypted at rest. Each stored file (each version) has its own random key, kept wrapped by the
 * webmail's master key in the database: the disk or S3 bucket only ever holds ciphertext, under a random name.
 *
 * The file is cut into 64 KB chunks, each sealed with XChaCha20-Poly1305. A chunk's nonce is the file's random
 * 16-byte prefix and the chunk's number; its additional data binds it to the file (its object name), its number and
 * whether it's the last. So a chunk can't be altered, moved, swapped between files, or the file cut short, without
 * decryption failing, and any range of the file can be read without decrypting the rest (videos seek, PDFs open).
 */
final class FileCrypto
{
    public const CHUNK = 65536;
    public const TAG = SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_ABYTES;

    /** A new file key: ['k' => 32 bytes, 'n' => 16-byte nonce prefix]. */
    public static function newKey(): array
    {
        return ['k' => random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES), 'n' => random_bytes(16)];
    }

    public static function wrap(Crypto $c, array $key): string
    {
        return $c->encryptJson(['v' => 1, 'k' => base64_encode($key['k']), 'n' => base64_encode($key['n']), 'c' => self::CHUNK], 'files.key');
    }

    public static function unwrap(Crypto $c, string $wrapped): array
    {
        $j = $c->decryptJson($wrapped, 'files.key');
        if (!is_array($j) || ($j['c'] ?? 0) !== self::CHUNK) {
            throw new \RuntimeException("A file's key couldn't be read");
        }
        return ['k' => base64_decode($j['k']), 'n' => base64_decode($j['n'])];
    }

    /** How many chunks a file of this size has (an empty file is one empty chunk). */
    public static function chunks(int $size): int
    {
        return max(1, intdiv($size + self::CHUNK - 1, self::CHUNK));
    }

    /** Its size once encrypted. */
    public static function storedSize(int $size): int
    {
        return $size + self::chunks($size) * self::TAG;
    }

    public static function sealChunk(array $key, string $object, int $index, string $plain, bool $last): string
    {
        return sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plain, self::aad($object, $index, $last), self::nonce($key, $index), $key['k']);
    }

    public static function openChunk(array $key, string $object, int $index, string $sealed, bool $last): string
    {
        $plain = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt($sealed, self::aad($object, $index, $last), self::nonce($key, $index), $key['k']);
        if ($plain === false) {
            throw new \RuntimeException('A stored file failed its integrity check');
        }
        return $plain;
    }

    /**
     * Seal a run of plaintext starting at chunk $first. Its length is a whole number of chunks, unless it ends the
     * file ($endsFile), where the last chunk may be short (or the only, empty chunk of an empty file).
     */
    public static function sealRun(array $key, string $object, int $first, string $plain, bool $endsFile): string
    {
        $out = '';
        $pieces = $plain === '' ? [''] : str_split($plain, self::CHUNK);
        if (!$endsFile && strlen((string) end($pieces)) !== self::CHUNK) {
            throw new \InvalidArgumentException('Only the end of a file may be a partial chunk');
        }
        foreach ($pieces as $i => $piece) {
            $out .= self::sealChunk($key, $object, $first + $i, $piece, $endsFile && $i === count($pieces) - 1);
        }
        return $out;
    }

    private static function nonce(array $key, int $index): string
    {
        return $key['n'] . pack('J', $index);
    }

    private static function aad(string $object, int $index, bool $last): string
    {
        return "wmfile1|$object|$index|" . ($last ? '1' : '0');
    }
}
