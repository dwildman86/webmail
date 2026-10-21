<?php
declare(strict_types=1);

namespace Webmail;

/**
 * QR codes for setting up an authenticator app, drawn as SVG on the server, so no library or outside service is
 * needed (and the secret never leaves this webmail). Byte mode, error correction level M, versions 1–10: up to 213
 * bytes, plenty for an otpauth:// address. Follows ISO/IEC 18004 the way Project Nayuki's reference encoder does.
 */
final class Qr
{
    /** Error correction codewords per block, and number of blocks, for level M, versions 1–10. */
    private const ECC_PER_BLOCK = [1 => 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
    private const BLOCKS = [1 => 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

    /** @var list<list<bool>> */
    private array $modules = [];
    /** @var list<list<bool>> */
    private array $isFunction = [];
    private int $size;

    private function __construct(private int $version)
    {
        $this->size = $version * 4 + 17;
    }

    /** An SVG data URL showing $text as a QR code. */
    public static function svgDataUrl(string $text, int $scale = 6): string
    {
        $m = self::matrix($text);
        $n = count($m);
        $quiet = 4;
        $path = '';
        foreach ($m as $y => $row) {
            foreach ($row as $x => $dark) {
                if ($dark) {
                    $path .= 'M' . ($x + $quiet) . ' ' . ($y + $quiet) . 'h1v1h-1z';
                }
            }
        }
        $w = $n + 2 * $quiet;
        $svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $w . ' ' . $w . '" width="' . ($w * $scale) . '" height="' . ($w * $scale)
            . '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="' . $path . '"/></svg>';
        return 'data:image/svg+xml;base64,' . base64_encode($svg);
    }

    /**
     * The modules (true = dark), rows first. $mask picks a mask pattern (0–7); by default the one the standard's
     * penalty rules prefer.
     *
     * @return list<list<bool>>
     */
    public static function matrix(string $text, ?int $mask = null, ?int $version = null): array
    {
        $fits = fn (int $v) => 4 + ($v < 10 ? 8 : 16) + 8 * strlen($text) <= self::dataCodewords($v) * 8;
        $v = $version ?? 1;
        while ($version === null && $v <= 10 && !$fits($v)) {
            $v++;
        }
        if ($v > 10 || !$fits($v)) {
            throw new \InvalidArgumentException('Too much text for a QR code here');
        }
        $qr = new self($v);
        $qr->build($text, $mask);
        return $qr->modules;
    }

    private function build(string $text, ?int $mask): void
    {
        $this->modules = array_fill(0, $this->size, array_fill(0, $this->size, false));
        $this->isFunction = $this->modules;
        $this->drawFunctionPatterns();
        $this->drawCodewords($this->addEccAndInterleave($this->dataCodewordsFor($text)));
        if ($mask === null) {
            $best = PHP_INT_MAX;
            for ($m = 0; $m < 8; $m++) {
                $this->applyMask($m);
                $this->drawFormatBits($m);
                $penalty = $this->penalty();
                if ($penalty < $best) {
                    $best = $penalty;
                    $mask = $m;
                }
                $this->applyMask($m); // masking twice undoes it
            }
        }
        $this->applyMask($mask);
        $this->drawFormatBits($mask);
    }

    private static function rawDataModules(int $ver): int
    {
        $result = (16 * $ver + 128) * $ver + 64;
        if ($ver >= 2) {
            $numAlign = intdiv($ver, 7) + 2;
            $result -= (25 * $numAlign - 10) * $numAlign - 55;
            if ($ver >= 7) {
                $result -= 36;
            }
        }
        return $result;
    }

    private static function dataCodewords(int $ver): int
    {
        return intdiv(self::rawDataModules($ver), 8) - self::ECC_PER_BLOCK[$ver] * self::BLOCKS[$ver];
    }

    /** Mode indicator, length, the bytes, terminator and padding. */
    private function dataCodewordsFor(string $text): array
    {
        $bits = [];
        $put = function (int $value, int $count) use (&$bits): void {
            for ($i = $count - 1; $i >= 0; $i--) {
                $bits[] = ($value >> $i) & 1;
            }
        };
        $put(0b0100, 4);
        $put(strlen($text), $this->version < 10 ? 8 : 16);
        foreach (str_split($text) as $ch) {
            $put(ord($ch), 8);
        }
        $capacity = self::dataCodewords($this->version) * 8;
        $put(0, min(4, $capacity - count($bits)));
        $put(0, (8 - count($bits) % 8) % 8);
        for ($pad = 0xEC; count($bits) < $capacity; $pad ^= 0xEC ^ 0x11) {
            $put($pad, 8);
        }
        $bytes = [];
        foreach (array_chunk($bits, 8) as $byte) {
            $bytes[] = array_reduce($byte, fn ($acc, $b) => ($acc << 1) | $b, 0);
        }
        return $bytes;
    }

    private function addEccAndInterleave(array $data): array
    {
        $numBlocks = self::BLOCKS[$this->version];
        $eccLen = self::ECC_PER_BLOCK[$this->version];
        $raw = intdiv(self::rawDataModules($this->version), 8);
        $numShort = $numBlocks - $raw % $numBlocks;
        $shortLen = intdiv($raw, $numBlocks);
        $divisor = self::rsDivisor($eccLen);
        $blocks = [];
        for ($i = 0, $k = 0; $i < $numBlocks; $i++) {
            $len = $shortLen - $eccLen + ($i < $numShort ? 0 : 1);
            $dat = array_slice($data, $k, $len);
            $k += $len;
            $ecc = self::rsRemainder($dat, $divisor);
            if ($i < $numShort) {
                $dat[] = 0;
            }
            $blocks[] = array_merge($dat, $ecc);
        }
        $result = [];
        for ($i = 0, $n = count($blocks[0]); $i < $n; $i++) {
            foreach ($blocks as $j => $block) {
                if ($i !== $shortLen - $eccLen || $j >= $numShort) {
                    $result[] = $block[$i];
                }
            }
        }
        return $result;
    }

    private static function rsDivisor(int $degree): array
    {
        $result = array_fill(0, $degree, 0);
        $result[$degree - 1] = 1;
        $root = 1;
        for ($i = 0; $i < $degree; $i++) {
            for ($j = 0; $j < $degree; $j++) {
                $result[$j] = self::gfMul($result[$j], $root);
                if ($j + 1 < $degree) {
                    $result[$j] ^= $result[$j + 1];
                }
            }
            $root = self::gfMul($root, 0x02);
        }
        return $result;
    }

    private static function rsRemainder(array $data, array $divisor): array
    {
        $result = array_fill(0, count($divisor), 0);
        foreach ($data as $b) {
            $factor = $b ^ array_shift($result);
            $result[] = 0;
            foreach ($divisor as $i => $coef) {
                $result[$i] ^= self::gfMul($coef, $factor);
            }
        }
        return $result;
    }

    private static function gfMul(int $x, int $y): int
    {
        $z = 0;
        for ($i = 7; $i >= 0; $i--) {
            $z = (($z << 1) ^ (($z >> 7) * 0x11D)) & 0xFF;
            $z ^= (($y >> $i) & 1) * $x;
        }
        return $z;
    }

    private function set(int $x, int $y, bool $dark): void
    {
        $this->modules[$y][$x] = $dark;
        $this->isFunction[$y][$x] = true;
    }

    private function drawFunctionPatterns(): void
    {
        for ($i = 0; $i < $this->size; $i++) {
            $this->set(6, $i, $i % 2 === 0);
            $this->set($i, 6, $i % 2 === 0);
        }
        foreach ([[3, 3], [$this->size - 4, 3], [3, $this->size - 4]] as [$cx, $cy]) {
            for ($dy = -4; $dy <= 4; $dy++) {
                for ($dx = -4; $dx <= 4; $dx++) {
                    $x = $cx + $dx;
                    $y = $cy + $dy;
                    if ($x >= 0 && $x < $this->size && $y >= 0 && $y < $this->size) {
                        $dist = max(abs($dx), abs($dy));
                        $this->set($x, $y, $dist !== 2 && $dist !== 4);
                    }
                }
            }
        }
        $pos = $this->alignmentPositions();
        $n = count($pos);
        for ($i = 0; $i < $n; $i++) {
            for ($j = 0; $j < $n; $j++) {
                if (($i === 0 && $j === 0) || ($i === 0 && $j === $n - 1) || ($i === $n - 1 && $j === 0)) {
                    continue; // these would sit on the finder patterns
                }
                for ($dy = -2; $dy <= 2; $dy++) {
                    for ($dx = -2; $dx <= 2; $dx++) {
                        $this->set($pos[$i] + $dx, $pos[$j] + $dy, max(abs($dx), abs($dy)) !== 1);
                    }
                }
            }
        }
        $this->drawFormatBits(0); // reserves the area; drawn for real once the mask is chosen
        if ($this->version >= 7) {
            $rem = $this->version;
            for ($i = 0; $i < 12; $i++) {
                $rem = ($rem << 1) ^ (($rem >> 11) * 0x1F25);
            }
            $bits = ($this->version << 12) | $rem;
            for ($i = 0; $i < 18; $i++) {
                $bit = (($bits >> $i) & 1) === 1;
                $a = $this->size - 11 + $i % 3;
                $b = intdiv($i, 3);
                $this->set($a, $b, $bit);
                $this->set($b, $a, $bit);
            }
        }
    }

    private function alignmentPositions(): array
    {
        if ($this->version === 1) {
            return [];
        }
        $num = intdiv($this->version, 7) + 2;
        $step = (int) (ceil(($this->version * 4 + 4) / ($num * 2 - 2)) * 2);
        $result = [6];
        for ($pos = $this->size - 7; count($result) < $num; $pos -= $step) {
            array_splice($result, 1, 0, [$pos]);
        }
        return $result;
    }

    private function drawFormatBits(int $mask): void
    {
        $data = (0b00 << 3) | $mask; // level M
        $rem = $data;
        for ($i = 0; $i < 10; $i++) {
            $rem = ($rem << 1) ^ (($rem >> 9) * 0x537);
        }
        $bits = (($data << 10) | $rem) ^ 0x5412;
        $bit = fn (int $i) => (($bits >> $i) & 1) === 1;
        for ($i = 0; $i <= 5; $i++) {
            $this->set(8, $i, $bit($i));
        }
        $this->set(8, 7, $bit(6));
        $this->set(8, 8, $bit(7));
        $this->set(7, 8, $bit(8));
        for ($i = 9; $i < 15; $i++) {
            $this->set(14 - $i, 8, $bit($i));
        }
        for ($i = 0; $i < 8; $i++) {
            $this->set($this->size - 1 - $i, 8, $bit($i));
        }
        for ($i = 8; $i < 15; $i++) {
            $this->set(8, $this->size - 15 + $i, $bit($i));
        }
        $this->set(8, $this->size - 8, true); // always dark
    }

    private function drawCodewords(array $data): void
    {
        $i = 0;
        $total = count($data) * 8;
        for ($right = $this->size - 1; $right >= 1; $right -= 2) {
            if ($right === 6) {
                $right = 5;
            }
            for ($vert = 0; $vert < $this->size; $vert++) {
                for ($j = 0; $j < 2; $j++) {
                    $x = $right - $j;
                    $upward = (($right + 1) & 2) === 0;
                    $y = $upward ? $this->size - 1 - $vert : $vert;
                    if (!$this->isFunction[$y][$x] && $i < $total) {
                        $this->modules[$y][$x] = (($data[$i >> 3] >> (7 - ($i & 7))) & 1) === 1;
                        $i++;
                    }
                }
            }
        }
    }

    private function applyMask(int $mask): void
    {
        for ($y = 0; $y < $this->size; $y++) {
            for ($x = 0; $x < $this->size; $x++) {
                $invert = match ($mask) {
                    0 => ($x + $y) % 2 === 0,
                    1 => $y % 2 === 0,
                    2 => $x % 3 === 0,
                    3 => ($x + $y) % 3 === 0,
                    4 => (intdiv($x, 3) + intdiv($y, 2)) % 2 === 0,
                    5 => $x * $y % 2 + $x * $y % 3 === 0,
                    6 => ($x * $y % 2 + $x * $y % 3) % 2 === 0,
                    default => (($x + $y) % 2 + $x * $y % 3) % 2 === 0,
                };
                if ($invert && !$this->isFunction[$y][$x]) {
                    $this->modules[$y][$x] = !$this->modules[$y][$x];
                }
            }
        }
    }

    /** The standard's four penalty rules: long runs, 2×2 blocks, finder look-alikes, and dark/light balance. */
    private function penalty(): int
    {
        $n = $this->size;
        $m = $this->modules;
        $score = 0;
        $lines = [];
        for ($i = 0; $i < $n; $i++) {
            $lines[] = $m[$i];
            $lines[] = array_column($m, $i);
        }
        foreach ($lines as $line) {
            $run = 1;
            for ($i = 1; $i <= $n; $i++) {
                if ($i < $n && $line[$i] === $line[$i - 1]) {
                    $run++;
                } else {
                    if ($run >= 5) {
                        $score += 3 + $run - 5;
                    }
                    $run = 1;
                }
            }
            $s = implode('', array_map(fn ($b) => $b ? '1' : '0', $line));
            $score += 40 * (substr_count($s, '10111010000') + substr_count($s, '00001011101'));
        }
        $dark = 0;
        for ($y = 0; $y < $n; $y++) {
            for ($x = 0; $x < $n; $x++) {
                $dark += $m[$y][$x] ? 1 : 0;
                if ($x + 1 < $n && $y + 1 < $n && $m[$y][$x] === $m[$y][$x + 1] && $m[$y][$x] === $m[$y + 1][$x] && $m[$y][$x] === $m[$y + 1][$x + 1]) {
                    $score += 3;
                }
            }
        }
        $score += 10 * intdiv(abs($dark * 20 - $n * $n * 10), $n * $n);
        return $score;
    }
}
