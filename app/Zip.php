<?php
declare(strict_types=1);

namespace Webmail;

/**
 * A ZIP file written to a stream, one file at a time, without PHP's zip extension (shared hosting often lacks it).
 * Files are deflated where zlib is available (it nearly always is), else stored. Names are UTF-8.
 * Not ZIP64: one archive is limited to 4 GB and 65,535 files, which a data request export stays well within.
 */
final class Zip
{
    /** @var resource */
    private $out;
    private int $offset = 0;
    /** @var string[] central directory entries */
    private array $central = [];
    private array $names = [];

    /** @param resource $out where the archive is written */
    public function __construct($out)
    {
        $this->out = $out;
    }

    public function add(string $name, string $data, ?int $time = null): void
    {
        $name = $this->unique(self::safeName($name));
        if (count($this->central) >= 65535 || $this->offset + strlen($data) > 0xFFFFFFFF - 1024) {
            throw new \RuntimeException('The export is too large for one ZIP file');
        }
        $crc = (int) hexdec(hash('crc32b', $data));
        $method = 0;
        $stored = $data;
        if (function_exists('gzdeflate') && strlen($data) > 64) {
            $deflated = gzdeflate($data, 6);
            if ($deflated !== false && strlen($deflated) < strlen($data)) {
                [$method, $stored] = [8, $deflated];
            }
        }
        [$dosTime, $dosDate] = self::dosTime($time ?? time());
        $common = pack('vvvvvVVVvv', 20, 0x0800, $method, $dosTime, $dosDate, $crc, strlen($stored), strlen($data), strlen($name), 0);
        $at = $this->offset;
        $this->write("PK\x03\x04" . $common . $name);
        $this->write($stored);
        $this->central[] = "PK\x01\x02" . pack('v', 20) . $common . pack('vvvVV', 0, 0, 0, 0, $at) . $name;
    }

    /** Finish the archive (the central directory). Returns the archive's size in bytes. */
    public function finish(): int
    {
        $start = $this->offset;
        $dir = implode('', $this->central);
        $this->write($dir);
        $this->write("PK\x05\x06" . pack('vvvvVVv', 0, 0, count($this->central), count($this->central), strlen($dir), $start, 0));
        return $this->offset;
    }

    private function write(string $bytes): void
    {
        fwrite($this->out, $bytes);
        $this->offset += strlen($bytes);
    }

    /** A path inside the archive: no leading slash, no "..", no characters Windows can't unzip. */
    public static function safeName(string $name): string
    {
        $parts = [];
        foreach (explode('/', str_replace('\\', '/', $name)) as $p) {
            $p = trim(preg_replace('/[\x00-\x1f<>:"|?*]+/u', '_', $p) ?? '', " .");
            if ($p !== '' && $p !== '..') {
                $parts[] = mb_substr($p, 0, 120);
            }
        }
        return $parts ? implode('/', $parts) : 'file';
    }

    /** Two attachments called report.pdf in one folder: the second becomes "report (2).pdf". */
    private function unique(string $name): string
    {
        $try = $name;
        for ($n = 2; isset($this->names[mb_strtolower($try)]); $n++) {
            $dot = strrpos($name, '.');
            $slash = strrpos($name, '/');
            $try = $dot !== false && ($slash === false || $dot > $slash) ? substr($name, 0, $dot) . " ($n)" . substr($name, $dot) : "$name ($n)";
        }
        $this->names[mb_strtolower($try)] = true;
        return $try;
    }

    private static function dosTime(int $t): array
    {
        $d = getdate(max($t, 315532800)); // ZIP dates start in 1980
        return [($d['hours'] << 11) | ($d['minutes'] << 5) | intdiv($d['seconds'], 2), (($d['year'] - 1980) << 9) | ($d['mon'] << 5) | $d['mday']];
    }
}
