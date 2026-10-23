<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Address books: a personal one for each person, and one shared by everyone (administrators look after it). Every
 * field is encrypted; the email address also has a keyed hash so a book never holds the same address twice.
 *
 * Imports vCard (.vcf, from iPhone, Google, Outlook…) and CSV (Google and Outlook exports, or any file with a header
 * row); exports vCard.
 */
final class AddressBook
{
    public const SHARED = 0;
    private const MAX_PER_BOOK = 10000;
    private const FIELDS = ['name' => 200, 'phone' => 60, 'company' => 200, 'notes' => 2000];

    /** Whether the last save() added a contact (rather than changing one). */
    public bool $added = false;

    public function __construct(private App $app)
    {
    }

    /** The book a request means: the person's own, or the shared one. */
    public static function owner(array $user, string $book): int
    {
        return $book === 'shared' ? self::SHARED : (int) $user['id'];
    }

    /** Everyone reads the shared book; only administrators change it. Personal books are only ever their owner's. */
    public static function checkCanEdit(array $user, int $owner): void
    {
        if ($owner === self::SHARED && $user['role'] !== 'admin') {
            throw new HttpError(403, 'Only an administrator can change the shared address book', 'forbidden');
        }
    }

    /** One book's contacts, sorted by name. */
    public function list(int $owner): array
    {
        $c = $this->app->crypto;
        $out = [];
        foreach ($this->app->db->all('SELECT id, email_enc, name_enc, phone_enc, company_enc, notes_enc, updated_at FROM {address_book} WHERE owner_id = ?', [$owner]) as $r) {
            $out[] = ['id' => (int) $r['id'], 'book' => $owner === self::SHARED ? 'shared' : 'personal',
                'email' => $c->decrypt($r['email_enc'], 'book.email'), 'name' => $c->decrypt($r['name_enc'], 'book.name') ?? '',
                'phone' => $c->decrypt($r['phone_enc'], 'book.phone') ?? '', 'company' => $c->decrypt($r['company_enc'], 'book.company') ?? '',
                'notes' => $c->decrypt($r['notes_enc'], 'book.notes') ?? '', 'updated_at' => $r['updated_at'] . 'Z'];
        }
        usort($out, fn ($a, $b) => strcasecmp($a['name'] ?: $a['email'], $b['name'] ?: $b['email']));
        return $out;
    }

    /**
     * Add a contact, or change one ($id). Returns its id. With $merge, an address already in the book is updated
     * instead of refused (for imports): its empty fields are filled in, nothing is overwritten.
     */
    public function save(int $owner, array $in, ?int $id = null, bool $merge = false): int
    {
        $email = mb_strtolower(trim((string) ($in['email'] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new HttpError(422, 'Enter a valid email address', 'invalid_email');
        }
        $fields = [];
        foreach (self::FIELDS as $f => $max) {
            $fields[$f] = mb_substr(trim(str_replace("\0", '', (string) ($in[$f] ?? ''))), 0, $max);
        }
        $c = $this->app->crypto;
        $db = $this->app->db;
        $bidx = $c->blindIndex($email, 'book.email');
        $existing = $db->one('SELECT id, name_enc, phone_enc, company_enc, notes_enc FROM {address_book} WHERE owner_id = ? AND email_bidx = ?', [$owner, $bidx]);
        if ($existing && (int) $existing['id'] !== $id) {
            if (!$merge) {
                throw new HttpError(409, "$email is already in this address book", 'duplicate');
            }
            foreach (self::FIELDS as $f => $_) {
                $old = $c->decrypt($existing[$f . '_enc'], 'book.' . $f) ?? '';
                $fields[$f] = $old !== '' ? $old : $fields[$f];
            }
            $id = (int) $existing['id'];
        }
        $enc = fn (string $f) => $fields[$f] === '' ? null : $c->encrypt($fields[$f], 'book.' . $f);
        $this->added = $id === null;
        if ($id !== null) {
            $n = $db->run('UPDATE {address_book} SET email_bidx = ?, email_enc = ?, name_enc = ?, phone_enc = ?, company_enc = ?, notes_enc = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
                [$bidx, $c->encrypt($email, 'book.email'), $enc('name'), $enc('phone'), $enc('company'), $enc('notes'), App::now(), $id, $owner])->rowCount();
            if ($n === 0 && !$db->value('SELECT id FROM {address_book} WHERE id = ? AND owner_id = ?', [$id, $owner])) {
                throw new HttpError(404, 'Contact not found', 'not_found');
            }
            return $id;
        }
        if ((int) $db->value('SELECT COUNT(*) FROM {address_book} WHERE owner_id = ?', [$owner]) >= self::MAX_PER_BOOK) {
            throw new HttpError(422, 'This address book is full (' . self::MAX_PER_BOOK . ' contacts)', 'book_full');
        }
        return $db->insert('INSERT INTO {address_book} (owner_id, email_bidx, email_enc, name_enc, phone_enc, company_enc, notes_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$owner, $bidx, $c->encrypt($email, 'book.email'), $enc('name'), $enc('phone'), $enc('company'), $enc('notes'), App::now(), App::now()]);
    }

    public function delete(int $owner, array $ids): int
    {
        $ids = array_values(array_filter(array_map('intval', $ids)));
        if (!$ids) {
            return 0;
        }
        return $this->app->db->run('DELETE FROM {address_book} WHERE owner_id = ? AND id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')',
            array_merge([$owner], $ids))->rowCount();
    }

    /**
     * For writing an email: the person's own contacts, then the shared book, then addresses they've written to. One
     * entry per address, best first.
     */
    public function suggestions(int $userId): array
    {
        $out = [];
        foreach ([[$userId, 'personal'], [self::SHARED, 'shared']] as [$owner, $source]) {
            foreach ($this->list($owner) as $c) {
                $out[$c['email']] ??= ['email' => $c['email'], 'name' => $c['name'], 'source' => $source];
            }
        }
        foreach ((new Mailstore($this->app))->contacts($userId) as $email) {
            $out[mb_strtolower($email)] ??= ['email' => mb_strtolower($email), 'name' => '', 'source' => 'recent'];
        }
        return array_values($out);
    }

    // -------------------------------------------------------------------------------------------- import

    /** Add contacts from a vCard or CSV file. Addresses already in the book are filled in, never overwritten. */
    public function import(int $owner, string $text, string $filename = ''): array
    {
        if (strlen($text) > 5 * 1024 * 1024) {
            throw new HttpError(422, 'That file is too big (5 MB at most)', 'too_big');
        }
        $text = self::utf8($text);
        $isVcard = stripos($text, 'BEGIN:VCARD') !== false || str_ends_with(strtolower($filename), '.vcf');
        $people = $isVcard ? self::parseVcard($text) : self::parseCsv($text);
        $added = $updated = $skipped = 0;
        foreach ($people as $p) {
            if (!filter_var(mb_strtolower(trim($p['email'] ?? '')), FILTER_VALIDATE_EMAIL)) {
                $skipped++;
                continue;
            }
            try {
                $this->save($owner, $p, null, true);
            } catch (HttpError $e) {
                if ($e->errorCode === 'book_full') {
                    throw $e;
                }
                $skipped++;
                continue;
            }
            $this->added ? $added++ : $updated++;
        }
        if (!$people) {
            throw new HttpError(422, $isVcard ? 'No contacts found in that vCard file' : 'No contacts found. A CSV file needs a header row with an email column.', 'nothing_found');
        }
        return ['added' => $added, 'updated' => $updated, 'skipped' => $skipped];
    }

    private static function utf8(string $text): string
    {
        $text = preg_replace('/^\xEF\xBB\xBF/', '', $text); // byte order mark
        if (str_starts_with($text, "\xFF\xFE") || str_starts_with($text, "\xFE\xFF")) {
            $text = mb_convert_encoding($text, 'UTF-8', 'UTF-16'); // Outlook's CSV
        }
        return mb_check_encoding($text, 'UTF-8') ? $text : mb_convert_encoding($text, 'UTF-8', 'Windows-1252');
    }

    /** vCard 2.1, 3.0 and 4.0: FN/N, EMAIL, TEL, ORG and NOTE. A card with several addresses gives one contact each. */
    public static function parseVcard(string $text): array
    {
        $text = preg_replace("/\r\n|\r/", "\n", $text);
        $text = preg_replace("/=\n/", '', $text);        // quoted-printable soft breaks (vCard 2.1)
        $text = preg_replace("/\n[ \t]/", '', $text);   // folded lines
        $out = [];
        $card = null;
        foreach (explode("\n", $text) as $line) {
            if (!str_contains($line, ':')) {
                continue;
            }
            [$head, $value] = explode(':', $line, 2);
            $parts = explode(';', $head);
            $prop = strtoupper(preg_replace('/^[^.]+\./', '', $parts[0])); // "item1.EMAIL" → EMAIL
            $params = strtoupper(implode(';', array_slice($parts, 1)));
            if (str_contains($params, 'QUOTED-PRINTABLE')) {
                $value = quoted_printable_decode($value);
            }
            if ($prop === 'BEGIN' && strtoupper(trim($value)) === 'VCARD') {
                $card = ['emails' => [], 'name' => '', 'n' => '', 'phone' => '', 'company' => '', 'notes' => ''];
                continue;
            }
            if ($card === null) {
                continue;
            }
            $unescape = fn (string $v) => trim(str_replace(['\\n', '\\N', '\\,', '\\;', '\\:', '\\\\'], ["\n", "\n", ',', ';', ':', '\\'], $v));
            switch ($prop) {
                case 'FN':
                    $card['name'] = $unescape($value);
                    break;
                case 'N':
                    $n = array_map($unescape, explode(';', $value));
                    $card['n'] = trim(implode(' ', array_filter([$n[3] ?? '', $n[1] ?? '', $n[2] ?? '', $n[0] ?? '', $n[4] ?? ''])));
                    break;
                case 'EMAIL':
                    $email = preg_replace('/^mailto:/i', '', $unescape($value));
                    if ($email !== '') {
                        // The preferred address first.
                        str_contains($params, 'PREF') ? array_unshift($card['emails'], $email) : $card['emails'][] = $email;
                    }
                    break;
                case 'TEL':
                    $card['phone'] = $card['phone'] ?: preg_replace('/^tel:/i', '', $unescape($value));
                    break;
                case 'ORG':
                    $card['company'] = trim(implode(', ', array_filter(array_map($unescape, explode(';', $value)))));
                    break;
                case 'NOTE':
                    $card['notes'] = $unescape($value);
                    break;
                case 'END':
                    foreach (array_unique($card['emails']) as $email) {
                        $out[] = ['email' => $email, 'name' => $card['name'] ?: $card['n'], 'phone' => $card['phone'], 'company' => $card['company'], 'notes' => $card['notes']];
                    }
                    $card = null;
                    break;
            }
        }
        return $out;
    }

    /** CSV with a header row: Google Contacts, Outlook and Apple exports, or simple name/email files. */
    public static function parseCsv(string $text): array
    {
        $text = preg_replace("/\r\n|\r/", "\n", trim($text));
        $first = strtok($text, "\n") ?: '';
        $sep = substr_count($first, ';') > substr_count($first, ',') ? ';' : (substr_count($first, "\t") > substr_count($first, ',') ? "\t" : ',');
        $fh = fopen('php://memory', 'r+');
        fwrite($fh, $text);
        rewind($fh);
        $header = fgetcsv($fh, 0, $sep, '"', '');
        if (!$header) {
            return [];
        }
        $cols = array_map(fn ($h) => strtolower(trim((string) $h)), $header);
        $find = function (array $patterns) use ($cols): array {
            $hits = [];
            foreach ($cols as $i => $col) {
                foreach ($patterns as $p) {
                    if (preg_match($p, $col)) {
                        $hits[] = $i;
                        break;
                    }
                }
            }
            return $hits;
        };
        $emailCols = $find(['/^e-?mail( address)?$/', '/^e-?mail ?\d* - value$/', '/^e-?mail ?\d* address$/', '/^(primary|home|work|other) ?e-?mail/', '/^email/']);
        if (!$emailCols) {
            return [];
        }
        $nameCol = $find(['/^(full |display )?name$/', '/^display name$/'])[0] ?? null;
        $firstCol = $find(['/^(first|given) name$/'])[0] ?? null;
        $middleCol = $find(['/^(middle|additional) name$/'])[0] ?? null;
        $lastCol = $find(['/^(last|family) name$/', '/^surname$/'])[0] ?? null;
        $phoneCol = $find(['/^(mobile|business|home)? ?phone$/', '/^phone ?\d* - value$/', '/^(mobile|telephone|tel)$/', '/phone/'])[0] ?? null;
        $companyCol = $find(['/^(company|organi[sz]ation)( name)?$/', '/^organi[sz]ation ?\d* - name$/', '/^organi[sz]ation/'])[0] ?? null;
        $notesCol = $find(['/^notes?$/'])[0] ?? null;
        $out = [];
        while (($row = fgetcsv($fh, 0, $sep, '"', '')) !== false) {
            $get = fn (?int $i) => $i === null ? '' : trim((string) ($row[$i] ?? ''));
            $name = $get($nameCol) ?: trim(implode(' ', array_filter([$get($firstCol), $get($middleCol), $get($lastCol)])));
            $emails = [];
            foreach ($emailCols as $i) {
                // Google puts several addresses in one cell, separated by " ::: ".
                foreach (preg_split('/\s*:::\s*|\s*;\s*/', $get($i)) as $e) {
                    if ($e !== '') {
                        $emails[] = $e;
                    }
                }
            }
            foreach (array_unique($emails) as $email) {
                $out[] = ['email' => $email, 'name' => $name, 'phone' => $get($phoneCol), 'company' => $get($companyCol), 'notes' => $get($notesCol)];
            }
        }
        fclose($fh);
        return $out;
    }

    // -------------------------------------------------------------------------------------------- export

    /** The book as vCard 3.0, which iPhone, Android, Google, Outlook and Thunderbird all import. */
    public function exportVcard(int $owner): string
    {
        $esc = fn (string $v) => str_replace(['\\', "\n", ',', ';'], ['\\\\', '\\n', '\\,', '\\;'], $v);
        $fold = function (string $line): string {
            $out = '';
            while (strlen($line) > 75) {
                $cut = 75;
                while ($cut > 1 && (ord($line[$cut]) & 0xC0) === 0x80) {
                    $cut--; // don't split a UTF-8 character
                }
                $out .= substr($line, 0, $cut) . "\r\n ";
                $line = substr($line, $cut);
            }
            return $out . $line . "\r\n";
        };
        $vcf = '';
        foreach ($this->list($owner) as $c) {
            $name = $c['name'] ?: $c['email'];
            $vcf .= "BEGIN:VCARD\r\nVERSION:3.0\r\n" . $fold('FN:' . $esc($name)) . $fold('N:' . $esc($name) . ';;;;')
                . $fold('EMAIL;TYPE=INTERNET:' . $esc($c['email']))
                . ($c['phone'] !== '' ? $fold('TEL:' . $esc($c['phone'])) : '')
                . ($c['company'] !== '' ? $fold('ORG:' . $esc($c['company'])) : '')
                . ($c['notes'] !== '' ? $fold('NOTE:' . $esc($c['notes'])) : '')
                . "END:VCARD\r\n";
        }
        return $vcf;
    }
}
