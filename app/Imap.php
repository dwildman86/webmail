<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Just enough IMAP (RFC 3501) to copy a mailbox: sign in, list folders, and fetch messages by UID. Plain PHP over a
 * TLS socket, because the imap extension is missing on many hosts (and gone from PHP 8.4). Read-only: it uses
 * EXAMINE and BODY.PEEK, so the old mailbox is left exactly as it was (nothing marked read or moved).
 */
final class Imap
{
    /** @var resource|null */
    private $socket = null;
    private int $tag = 0;
    public array $capabilities = [];

    /**
     * @param string $security "ssl" (port 993), "starttls" (port 143), or "none" (tests only)
     */
    public function __construct(private string $host, private int $port, private string $security = 'ssl', private int $timeout = 20)
    {
    }

    public function connect(): void
    {
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $this->host, 'SNI_enabled' => true]]);
        $scheme = $this->security === 'ssl' ? 'ssl' : 'tcp';
        $sock = @stream_socket_client("$scheme://{$this->host}:{$this->port}", $errno, $errstr, $this->timeout, STREAM_CLIENT_CONNECT, $ctx);
        if (!$sock) {
            $why = $errstr ?: 'no answer';
            if (stripos($why, 'certificate') !== false || stripos($why, 'SSL') !== false) {
                throw new ImapError("The server's security certificate isn't valid for {$this->host}. Check the server name (your provider's help pages give it).");
            }
            throw new ImapError("Couldn't connect to {$this->host} on port {$this->port}: $why.");
        }
        stream_set_timeout($sock, $this->timeout);
        $this->socket = $sock;
        $greeting = $this->line();
        if (!preg_match('/^\* (OK|PREAUTH)/i', $greeting)) {
            throw new ImapError("{$this->host} didn't answer like a mail server (IMAP).");
        }
        if ($this->security === 'starttls') {
            $this->command('STARTTLS');
            stream_context_set_option($sock, 'ssl', 'peer_name', $this->host);
            stream_context_set_option($sock, 'ssl', 'verify_peer', true);
            if (!@stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new ImapError("Couldn't start a secure connection with {$this->host}.");
            }
        }
        $this->capabilities = [];
        foreach ($this->command('CAPABILITY') as $l) {
            if (preg_match('/^\* CAPABILITY (.+)$/i', $l['text'], $m)) {
                $this->capabilities = array_map('strtoupper', preg_split('/\s+/', trim($m[1])));
            }
        }
    }

    public function login(string $username, string $password): void
    {
        try {
            if (in_array('AUTH=PLAIN', $this->capabilities, true)) {
                $this->command('AUTHENTICATE PLAIN ' . base64_encode("\0$username\0$password"));
            } else {
                $this->command('LOGIN ' . self::astring($username) . ' ' . self::astring($password));
            }
        } catch (ImapError $e) {
            throw new ImapError('The server didn\'t accept that email address and password. Gmail, Yahoo and iCloud need an app password (made in your account\'s security settings), not your normal one.'
                . ($e->getMessage() ? ' It said: ' . $e->getMessage() : ''));
        }
    }

    /** Sign in with an OAuth access token (Gmail, Microsoft 365): SASL XOAUTH2. */
    public function loginXoauth2(string $username, string $accessToken): void
    {
        try {
            $this->command('AUTHENTICATE XOAUTH2 ' . base64_encode("user=$username\x01auth=Bearer $accessToken\x01\x01"));
        } catch (ImapError $e) {
            throw new ImapError('The mail server didn\'t accept the sign-in. Sign in again' . ($e->getMessage() ? " (it said: {$e->getMessage()})." : '.'));
        }
    }

    /** @return array<int, array{name: string, raw: string, attrs: string[], delimiter: string}> */
    public function folders(): array
    {
        $out = [];
        foreach ($this->command('LIST "" "*"') as $l) {
            if (!preg_match('/^\* LIST \(([^)]*)\) (NIL|"(?:[^"\\\\]|\\\\.)*")(?: (.+))?$/i', $l['text'], $m)) {
                continue;
            }
            $raw = $l['literal'] ?? self::unquote(trim($m[3] ?? ''));
            $attrs = array_filter(preg_split('/\s+/', strtolower($m[1])));
            if (in_array('\\noselect', $attrs, true) || in_array('\\nonexistent', $attrs, true)) {
                continue;
            }
            $out[] = ['name' => self::decodeName($raw), 'raw' => $raw, 'attrs' => array_values($attrs), 'delimiter' => $m[2] === 'NIL' ? '' : self::unquote($m[2])];
        }
        return $out;
    }

    /** Open a folder read-only. @return array{exists: int, uidvalidity: int, uidnext: int} */
    public function examine(string $raw): array
    {
        $info = ['exists' => 0, 'uidvalidity' => 0, 'uidnext' => 0];
        foreach ($this->command('EXAMINE ' . self::astring($raw)) as $l) {
            if (preg_match('/^\* (\d+) EXISTS/i', $l['text'], $m)) {
                $info['exists'] = (int) $m[1];
            } elseif (preg_match('/UIDVALIDITY (\d+)/i', $l['text'], $m)) {
                $info['uidvalidity'] = (int) $m[1];
            } elseif (preg_match('/UIDNEXT (\d+)/i', $l['text'], $m)) {
                $info['uidnext'] = (int) $m[1];
            }
        }
        return $info;
    }

    /** UIDs above $after in the open folder, oldest first. @return int[] */
    public function uidsAfter(int $after): array
    {
        $uids = [];
        foreach ($this->command('UID SEARCH UID ' . ($after + 1) . ':*') as $l) {
            if (preg_match('/^\* SEARCH ?(.*)$/i', $l['text'], $m)) {
                foreach (preg_split('/\s+/', trim($m[1])) as $u) {
                    if ($u !== '' && (int) $u > $after) {
                        $uids[] = (int) $u;
                    }
                }
            }
        }
        sort($uids);
        return array_values(array_unique($uids));
    }

    /** Sizes of messages by UID, to skip ones too large before downloading them. @return array<int, int> */
    public function sizes(array $uids): array
    {
        $out = [];
        if (!$uids) {
            return $out;
        }
        foreach ($this->command('UID FETCH ' . implode(',', $uids) . ' (UID RFC822.SIZE)') as $l) {
            if (preg_match('/UID (\d+)/i', $l['text'], $u) && preg_match('/RFC822\.SIZE (\d+)/i', $l['text'], $s)) {
                $out[(int) $u[1]] = (int) $s[1];
            }
        }
        return $out;
    }

    /**
     * The messages, read without marking them read. @return array<int, array{uid: int, flags: string[], date: ?string, raw: string}>
     */
    public function fetch(array $uids): array
    {
        $out = [];
        if (!$uids) {
            return $out;
        }
        foreach ($this->command('UID FETCH ' . implode(',', $uids) . ' (UID FLAGS INTERNALDATE BODY.PEEK[])') as $l) {
            if (!preg_match('/^\* \d+ FETCH/i', $l['text']) || !isset($l['literal'])) {
                continue;
            }
            $head = $l['text'] . ' ' . ($l['after'] ?? '');
            if (!preg_match('/UID (\d+)/i', $head, $u)) {
                continue;
            }
            preg_match('/FLAGS \(([^)]*)\)/i', $head, $f);
            preg_match('/INTERNALDATE "([^"]+)"/i', $head, $d);
            $out[(int) $u[1]] = ['uid' => (int) $u[1], 'flags' => array_filter(preg_split('/\s+/', strtolower($f[1] ?? ''))), 'date' => $d[1] ?? null, 'raw' => $l['literal']];
        }
        return $out;
    }

    public function logout(): void
    {
        if ($this->socket) {
            try {
                $this->command('LOGOUT');
            } catch (ImapError) {
            }
            fclose($this->socket);
            $this->socket = null;
        }
    }

    public function __destruct()
    {
        if ($this->socket) {
            @fclose($this->socket);
        }
    }

    // ------------------------------------------------------------------------------------------------ protocol

    private function line(): string
    {
        $line = fgets($this->socket);
        if ($line === false) {
            $meta = stream_get_meta_data($this->socket);
            throw new ImapError($meta['timed_out'] ? "{$this->host} stopped answering." : "{$this->host} closed the connection.");
        }
        return $line;
    }

    private function read(int $n): string
    {
        $data = '';
        while (strlen($data) < $n) {
            $chunk = fread($this->socket, min(65536, $n - strlen($data)));
            if ($chunk === false || $chunk === '') {
                $meta = stream_get_meta_data($this->socket);
                if ($meta['timed_out'] || feof($this->socket)) {
                    throw new ImapError("{$this->host} stopped sending in the middle of a message.");
                }
                continue;
            }
            $data .= $chunk;
        }
        return $data;
    }

    /**
     * Send a command and read until its tagged reply. Each untagged line comes back as text; a literal ({n}) in it as
     * 'literal', with the rest of that line after the literal as 'after'.
     * @return array<int, array{text: string, literal?: string, after?: string}>
     */
    private function command(string $command): array
    {
        $tag = 'A' . (++$this->tag);
        if (@fwrite($this->socket, "$tag $command\r\n") === false) {
            throw new ImapError("Lost the connection to {$this->host}.");
        }
        $lines = [];
        while (true) {
            $line = $this->line();
            if (str_starts_with($line, "$tag ")) {
                if (!preg_match('/^' . $tag . ' OK\b/i', $line)) {
                    throw new ImapError(trim(preg_replace('/^' . $tag . ' (NO|BAD)\s*(\[[^\]]*\]\s*)?/i', '', $line)));
                }
                return $lines;
            }
            if (str_starts_with($line, '+')) {
                // We send no literals, so this is a failed sign-in's details (XOAUTH2): an empty line ends it with NO.
                fwrite($this->socket, "\r\n");
                continue;
            }
            $entry = ['text' => rtrim($line, "\r\n")];
            // A literal: {n} at the end of the line, then n bytes, then the rest of the response.
            if (preg_match('/\{(\d+)\}$/', $entry['text'], $m)) {
                $entry['text'] = rtrim(preg_replace('/\{\d+\}$/', '', $entry['text']));
                $entry['literal'] = $this->read((int) $m[1]);
                $entry['after'] = rtrim($this->line(), "\r\n");
                // Rare: another literal after the first (we fetch one body per message, so this only skips it).
                while (preg_match('/\{(\d+)\}$/', $entry['after'], $m2)) {
                    $this->read((int) $m2[1]);
                    $entry['after'] = rtrim($this->line(), "\r\n");
                }
            }
            $lines[] = $entry;
        }
    }

    /** A string for a command: quoted, or a literal-free form for anything quoting can't carry. */
    private static function astring(string $s): string
    {
        if (preg_match('/[\r\n\x00]/', $s)) {
            throw new ImapError('That contains characters a mail server can\'t take.');
        }
        return '"' . addcslashes($s, '"\\') . '"';
    }

    private static function unquote(string $s): string
    {
        return preg_match('/^"(.*)"$/s', $s, $m) ? stripcslashes($m[1]) : $s;
    }

    /** Folder names are in IMAP's modified UTF-7 ("Entw&APw-rfe" is "Entwürfe"). */
    public static function decodeName(string $raw): string
    {
        return function_exists('mb_convert_encoding') ? (string) @mb_convert_encoding($raw, 'UTF-8', 'UTF7-IMAP') : $raw;
    }
}
