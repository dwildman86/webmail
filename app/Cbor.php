<?php
declare(strict_types=1);

namespace Webmail;

/** Just enough CBOR (RFC 8949) to read WebAuthn answers: integers, strings, arrays, maps and simple values. */
final class Cbor
{
    /** Decode from $offset. With $partial, stop after one value (the bytes after it are left alone). */
    public static function decode(string $data, int &$offset = 0, bool $partial = false): mixed
    {
        $value = self::item($data, $offset, 0);
        if (!$partial && $offset !== strlen($data)) {
            throw new HttpError(422, 'Unexpected data after the passkey answer', 'invalid_passkey');
        }
        return $value;
    }

    private static function item(string $d, int &$o, int $depth): mixed
    {
        if ($depth > 16 || $o >= strlen($d)) {
            throw new HttpError(422, 'The passkey answer was cut short', 'invalid_passkey');
        }
        $b = ord($d[$o++]);
        $major = $b >> 5;
        $info = $b & 0x1f;
        $n = match (true) {
            $info < 24 => $info,
            $info === 24 => ord(self::take($d, $o, 1)),
            $info === 25 => unpack('n', self::take($d, $o, 2))[1],
            $info === 26 => unpack('N', self::take($d, $o, 4))[1],
            $info === 27 => unpack('J', self::take($d, $o, 8))[1],
            default => throw new HttpError(422, 'Indefinite-length CBOR isn\'t supported', 'invalid_passkey'),
        };
        switch ($major) {
            case 0:
                return $n;
            case 1:
                return -1 - $n;
            case 2:
            case 3:
                return self::take($d, $o, $n);
            case 4:
                $out = [];
                for ($i = 0; $i < $n; $i++) {
                    $out[] = self::item($d, $o, $depth + 1);
                }
                return $out;
            case 5:
                $out = [];
                for ($i = 0; $i < $n; $i++) {
                    $k = self::item($d, $o, $depth + 1);
                    $out[is_int($k) || is_string($k) ? $k : (string) json_encode($k)] = self::item($d, $o, $depth + 1);
                }
                return $out;
            case 6:
                return self::item($d, $o, $depth + 1); // a tag: the tagged value is what matters
            default:
                return match ($info) { 20 => false, 21 => true, 22, 23 => null, default => $n };
        }
    }

    private static function take(string $d, int &$o, int $n): string
    {
        if ($n < 0 || $o + $n > strlen($d)) {
            throw new HttpError(422, 'The passkey answer was cut short', 'invalid_passkey');
        }
        $s = substr($d, $o, $n);
        $o += $n;
        return $s;
    }
}
