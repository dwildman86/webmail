<?php
// A stand-in IMAP server for tests: php fake-imap.php <port> <mailbox.json> <log file>. It speaks just the commands
// the importer uses, serves the folders and messages in mailbox.json, and logs every command it gets.
declare(strict_types=1);

[$self, $port, $file, $logFile] = $argv;
$server = stream_socket_server("tcp://127.0.0.1:$port", $errno, $errstr);
if (!$server) {
    fwrite(STDERR, "listen failed: $errstr\n");
    exit(1);
}
fwrite(STDOUT, "ready\n");
$quote = fn (string $s) => '"' . addcslashes($s, '"\\') . '"';
while ($c = @stream_socket_accept($server, -1)) {
    $box = json_decode(file_get_contents($file), true);
    $selected = null;
    $authed = false;
    $out = fn (string $s) => fwrite($c, $s . "\r\n");
    $out('* OK fake IMAP ready');
    while (($line = fgets($c)) !== false) {
        $line = rtrim($line, "\r\n");
        file_put_contents($logFile, preg_replace('/^(\S+ (LOGIN|AUTHENTICATE PLAIN)) .*/i', '$1 ***', $line) . "\n", FILE_APPEND);
        [$tag, $rest] = explode(' ', $line, 2) + [1 => ''];
        $cmd = strtoupper(strtok($rest, ' '));
        if ($cmd === 'UID') {
            $cmd = 'UID ' . strtoupper(strtok(' '));
        }
        $ok = fn (string $what = 'done') => $out("$tag OK $what");
        switch ($cmd) {
            case 'CAPABILITY':
                $out('* CAPABILITY IMAP4rev1 AUTH=PLAIN');
                $ok();
                break;
            case 'AUTHENTICATE':
                [, , $b64] = explode(' ', $rest) + [2 => ''];
                [, $u, $p] = explode("\0", base64_decode($b64)) + [1 => '', 2 => ''];
                ($authed = ($u === $box['user'] && $p === $box['pass'])) ? $ok() : $out("$tag NO [AUTHENTICATIONFAILED] Invalid credentials");
                break;
            case 'LIST':
                foreach ($box['folders'] as $f) {
                    $out('* LIST (' . implode(' ', $f['attrs'] ?? []) . ') "/" ' . $quote($f['raw']));
                }
                $ok();
                break;
            case 'EXAMINE':
                $name = stripcslashes(trim(substr($rest, 8), '"'));
                $selected = null;
                foreach ($box['folders'] as $f) {
                    if ($f['raw'] === $name) {
                        $selected = $f;
                    }
                }
                if (!$selected) {
                    $out("$tag NO no such folder");
                    break;
                }
                $out('* ' . count($selected['messages'] ?? []) . ' EXISTS');
                $out('* OK [UIDVALIDITY ' . ($selected['uidvalidity'] ?? 1) . '] UIDs valid');
                $ok('[READ-ONLY] EXAMINE completed');
                break;
            case 'UID SEARCH':
                preg_match('/UID (\d+):\*/', $rest, $m);
                $uids = array_filter(array_column($selected['messages'] ?? [], 'uid'), fn ($u) => $u >= (int) $m[1]);
                $last = max(array_column($selected['messages'] ?? [], 'uid') ?: [0]);
                if (!$uids && $last) {
                    $uids = [$last]; // as real servers do: n:* always includes the last message
                }
                $out('* SEARCH ' . implode(' ', $uids));
                $ok();
                break;
            case 'UID FETCH':
                preg_match('/UID FETCH ([\d,]+) \((.*)\)$/i', $rest, $m);
                $want = array_map('intval', explode(',', $m[1]));
                $n = 0;
                foreach ($selected['messages'] as $msg) {
                    $n++;
                    if (!in_array($msg['uid'], $want, true)) {
                        continue;
                    }
                    $raw = isset($msg['raw_file']) ? file_get_contents(dirname($file) . '/' . $msg['raw_file']) : $msg['raw'];
                    if (stripos($m[2], 'BODY.PEEK[]') !== false) {
                        $out("* $n FETCH (UID {$msg['uid']} FLAGS (" . implode(' ', $msg['flags'] ?? []) . ') INTERNALDATE "' . ($msg['date'] ?? '01-Jan-2020 10:00:00 +0000') . '" BODY[] {' . strlen($raw) . '}');
                        fwrite($c, $raw);
                        $out(')');
                    } else {
                        $out("* $n FETCH (UID {$msg['uid']} RFC822.SIZE " . strlen($raw) . ')');
                    }
                }
                $ok();
                break;
            case 'LOGOUT':
                $out('* BYE');
                $ok();
                fclose($c);
                continue 3;
            default:
                $out("$tag BAD unknown command");
        }
    }
}
