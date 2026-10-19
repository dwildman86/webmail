<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Field-level encryption for everything personal in the database: XChaCha20-Poly1305 (libsodium) with a random nonce
 * per value, and the column's name as associated data, so a value can't be moved to another column unnoticed.
 * Search uses blind indexes: keyed HMACs of each word, so the database can match words without holding them.
 *
 * Both keys are derived from one 32-byte master key kept in config.php, outside the database.
 */
final class Crypto
{
    private const PREFIX = 'x1.';
    private string $encKey;
    private string $indexKey;

    public function __construct(string $masterKey)
    {
        if (strlen($masterKey) !== SODIUM_CRYPTO_KDF_KEYBYTES) {
            throw new \InvalidArgumentException('The encryption key must be 32 bytes');
        }
        $this->encKey = sodium_crypto_kdf_derive_from_key(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES, 1, 'wmdata01', $masterKey);
        $this->indexKey = sodium_crypto_kdf_derive_from_key(32, 2, 'wmindex1', $masterKey);
    }

    public static function newKey(): string
    {
        return sodium_crypto_kdf_keygen();
    }

    /** Encrypt a value for a column ($context, e.g. "messages.subject"). null stays null. */
    public function encrypt(?string $plain, string $context): ?string
    {
        if ($plain === null) {
            return null;
        }
        $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $box = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plain, $context, $nonce, $this->encKey);
        return self::PREFIX . sodium_bin2base64($nonce . $box, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
    }

    /** Decrypt a value written by encrypt() for the same column. Throws if it was changed or belongs elsewhere. */
    public function decrypt(?string $stored, string $context): ?string
    {
        if ($stored === null) {
            return null;
        }
        if (!str_starts_with($stored, self::PREFIX)) {
            throw new \RuntimeException('Not an encrypted value');
        }
        $raw = sodium_base642bin(substr($stored, strlen(self::PREFIX)), SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        $n = SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES;
        $plain = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(substr($raw, $n), $context, substr($raw, 0, $n), $this->encKey);
        if ($plain === false) {
            throw new \RuntimeException("Can't decrypt $context: wrong key, or the value was changed");
        }
        return $plain;
    }

    /** JSON in, encrypted out (and back). */
    public function encryptJson(mixed $value, string $context): string
    {
        return $this->encrypt(json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), $context);
    }

    public function decryptJson(?string $stored, string $context): mixed
    {
        $json = $this->decrypt($stored, $context);
        return $json === null ? null : json_decode($json, true, 512, JSON_THROW_ON_ERROR);
    }

    /** A blind index: the same input always gives the same 16 bytes, and they reveal nothing without the key. */
    public function blindIndex(string $value, string $context): string
    {
        return substr(hash_hmac('sha256', $context . "\0" . $value, $this->indexKey, true), 0, 16);
    }

    /** The searchable words of a text: lower-case, 2+ letters or digits, at most $max of them. */
    public static function words(string $text, int $max = 2000): array
    {
        $text = mb_strtolower($text, 'UTF-8');
        preg_match_all('/[\p{L}\p{N}][\p{L}\p{N}._@+-]*[\p{L}\p{N}]/u', $text, $m);
        $words = [];
        foreach ($m[0] as $w) {
            $words[$w] = true;
            // Addresses and dotted names are also searchable by their parts: "jane", "example".
            foreach (preg_split('/[._@+-]+/u', $w) as $part) {
                if (mb_strlen($part) >= 2) {
                    $words[$part] = true;
                }
            }
            if (count($words) >= $max) {
                break;
            }
        }
        // Numeric words ("1042") are array keys PHP stores as ints: back to strings.
        return array_map('strval', array_slice(array_keys($words), 0, $max));
    }
}
