<?php
declare(strict_types=1);

namespace Webmail;

/**
 * The customer panel beside an email: who the conversation is with, every conversation with them in the mailboxes you
 * can read (with where each is up to), how many there have been, their address book entry, and the fields GhostParse's
 * parsers pulled out of their email (an order number, a customer id, a plan…), newest first.
 *
 * People are found by a blind index of their address (message_parties), so nothing is decrypted to look them up.
 */
final class Customers
{
    private const MAX_MESSAGES = 2000;
    private const MAX_FIELDS = 40;

    public function __construct(private App $app)
    {
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    public function forMessage(array $user, int $messageId): array
    {
        $db = $this->app->db;
        $row = $db->one('SELECT m.* FROM {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id WHERE um.user_id = ? AND m.id = ?', [$user['id'], $messageId]);
        if (!$row) {
            throw new HttpError(404, 'Message not found', 'not_found');
        }
        $who = $this->customerOf($row);
        if (!$who) {
            return ['customer' => null];
        }
        $store = new Mailstore($this->app);
        $mailboxes = array_map('intval', array_column($db->all('SELECT mailbox_id FROM {user_mailboxes} WHERE user_id = ?', [$user['id']]), 'mailbox_id'));
        $marks = implode(',', array_fill(0, count($mailboxes), '?'));
        $rows = $db->all("SELECT m.id, m.mailbox_id, m.thread_key, m.folder, m.sent_at, m.is_read, m.subject_enc, m.extracted_enc FROM {message_parties} p
            JOIN {messages} m ON m.id = p.message_id WHERE p.address_bidx = ? AND m.mailbox_id IN ($marks) AND m.folder NOT IN ('drafts', 'spam')
            ORDER BY m.sent_at DESC, m.id DESC LIMIT " . self::MAX_MESSAGES, array_merge([$store->partyIndex($who['address'])], $mailboxes));
        $c = $this->c();
        $addresses = [];
        foreach ($db->all("SELECT id, address_enc FROM {mailboxes} WHERE id IN ($marks)", $mailboxes) as $m) {
            $addresses[(int) $m['id']] = (string) $c->decrypt($m['address_enc'], 'mailboxes.address');
        }
        $currentKey = $row['mailbox_id'] . "\0" . ($row['thread_key'] ?? 'm' . $row['id']);

        // Conversations (a mailbox's thread), newest first, and the fields from their email.
        $threads = [];
        $fields = [];
        foreach ($rows as $r) {
            $key = $r['mailbox_id'] . "\0" . ($r['thread_key'] ?? 'm' . $r['id']);
            if (!isset($threads[$key])) {
                $threads[$key] = ['message_id' => (int) $r['id'], 'mailbox' => $addresses[(int) $r['mailbox_id']] ?? '', 'mailbox_id' => (int) $r['mailbox_id'],
                    'thread_key' => $r['thread_key'], 'subject' => (string) $c->decrypt($r['subject_enc'], 'messages.subject'), 'last_at' => self::iso($r['sent_at']),
                    'first_at' => self::iso($r['sent_at']), 'messages' => 0, 'unread' => false, 'folder' => $r['folder'], 'current' => $key === $currentKey];
            }
            $t = &$threads[$key];
            $t['messages']++;
            $t['first_at'] = self::iso($r['sent_at']);
            $t['unread'] = $t['unread'] || !$r['is_read'];
            unset($t);
            if ($r['extracted_enc'] !== null && count($fields) < self::MAX_FIELDS) {
                $x = $c->decryptJson($r['extracted_enc'], 'messages.extracted') ?? [];
                foreach (self::flatten($x) as $name => $value) {
                    // The newest value of each field (rows come newest first).
                    $fields[$name] ??= ['name' => $name, 'label' => self::label($name), 'value' => $value, 'at' => self::iso($r['sent_at']),
                        'parser' => (string) ($x['parser'] ?? ''), 'message_id' => (int) $r['id'], 'this_conversation' => $key === $currentKey];
                }
            }
        }
        // Where each conversation is up to (shared mailboxes), and who has it.
        $states = [];
        foreach ($threads as $t) {
            if ($t['thread_key'] !== null) {
                $states[] = [$t['mailbox_id'], $t['thread_key']];
            }
        }
        $byKey = [];
        foreach (array_chunk($states, 200) as $chunk) {
            $where = implode(' OR ', array_fill(0, count($chunk), '(s.mailbox_id = ? AND s.thread_key = ?)'));
            foreach ($db->all("SELECT s.mailbox_id, s.thread_key, s.status, u.name_enc, u.email_enc FROM {thread_state} s LEFT JOIN {users} u ON u.id = s.assignee_id WHERE $where",
                array_merge(...$chunk)) as $s) {
                $byKey[$s['mailbox_id'] . "\0" . $s['thread_key']] = ['status' => $s['status'],
                    'assignee' => $s['name_enc'] !== null || $s['email_enc'] !== null ? (string) ($c->decrypt($s['name_enc'], 'users.name') ?: $c->decrypt($s['email_enc'], 'users.email')) : null];
            }
        }
        $open = $resolved = 0;
        foreach ($threads as $key => &$t) {
            $state = $byKey[$key] ?? null;
            $t['status'] = $state['status'] ?? null;
            $t['assignee'] = $state['assignee'] ?? null;
            if ($t['status'] === 'resolved') {
                $resolved++;
            } elseif ($t['status'] !== null) {
                $open++;
            }
            unset($t['thread_key']);
        }
        unset($t);
        $list = array_values($threads);
        $contact = $this->contact((int) $user['id'], $who['address']);
        return ['customer' => [
            'address' => $who['address'], 'name' => $contact['name'] ?? '' ?: $who['name'], 'contact' => $contact,
            'stats' => ['conversations' => count($list), 'messages' => count($rows), 'open' => $open, 'resolved' => $resolved,
                'first_at' => $list ? end($list)['first_at'] : null, 'last_at' => $list[0]['last_at'] ?? null, 'more' => count($rows) >= self::MAX_MESSAGES],
            'conversations' => array_slice($list, 0, 50),
            'fields' => array_values($fields),
        ]];
    }

    /**
     * Who a conversation is with: the latest person to write in from outside (not one of this webmail's mailboxes),
     * or, for email you sent, the first person it went to.
     */
    private function customerOf(array $row): ?array
    {
        $db = $this->app->db;
        $c = $this->c();
        $thread = $row['thread_key'] !== null
            ? $db->all('SELECT folder, from_enc, to_enc FROM {messages} WHERE mailbox_id = ? AND thread_key = ? ORDER BY sent_at DESC, id DESC LIMIT 50', [$row['mailbox_id'], $row['thread_key']])
            : [$row];
        $own = array_flip(array_column($db->all('SELECT address_bidx FROM {mailboxes}'), 'address_bidx'));
        $store = new Mailstore($this->app);
        $ours = fn (string $a) => isset($own[$store->addressIndex($a)]);
        foreach ($thread as $m) {
            if (in_array($m['folder'], ['sent', 'drafts'], true)) {
                continue;
            }
            $from = $c->decryptJson($m['from_enc'], 'messages.from') ?? [];
            $a = mb_strtolower(trim((string) ($from['address'] ?? '')));
            if ($a !== '' && !$ours($a)) {
                return ['address' => $a, 'name' => (string) ($from['name'] ?? '')];
            }
        }
        foreach ($thread as $m) {
            $to = $c->decryptJson($m['to_enc'], 'messages.to') ?? [];
            foreach (array_merge($to['to'] ?? [], $to['cc'] ?? []) as $p) {
                $a = mb_strtolower(trim((string) ($p['address'] ?? '')));
                if ($a !== '' && !$ours($a)) {
                    return ['address' => $a, 'name' => (string) ($p['name'] ?? '')];
                }
            }
        }
        return null;
    }

    /** Their entry in your contacts, else the shared address book. */
    private function contact(int $userId, string $address): ?array
    {
        $c = $this->c();
        $rows = $this->app->db->all('SELECT owner_id, name_enc, phone_enc, company_enc, notes_enc FROM {address_book} WHERE email_bidx = ? AND owner_id IN (?, ?) ORDER BY owner_id DESC',
            [$c->blindIndex($address, 'book.email'), $userId, AddressBook::SHARED]);
        if (!$rows) {
            return null;
        }
        $r = $rows[0];
        return ['book' => (int) $r['owner_id'] === AddressBook::SHARED ? 'shared' : 'personal', 'name' => (string) ($c->decrypt($r['name_enc'], 'book.name') ?? ''),
            'phone' => (string) ($c->decrypt($r['phone_enc'], 'book.phone') ?? ''), 'company' => (string) ($c->decrypt($r['company_enc'], 'book.company') ?? ''),
            'notes' => (string) ($c->decrypt($r['notes_enc'], 'book.notes') ?? '')];
    }

    /**
     * A parser's result as name => text: its fields (rules and AI parsers), or its JSON answer (schema parsers), with
     * nested values as "billing.city" and lists joined. Empty values are left out.
     */
    public static function flatten(array $x): array
    {
        $out = [];
        $walk = function ($v, string $name) use (&$walk, &$out) {
            if ($v === null || $v === '' || $v === []) {
                return;
            }
            if (is_array($v) && !array_is_list($v)) {
                foreach ($v as $k => $sub) {
                    $walk($sub, $name === '' ? (string) $k : "$name.$k");
                }
                return;
            }
            if (is_array($v)) {
                $scalars = array_filter($v, fn ($i) => is_scalar($i));
                $v = count($scalars) === count($v) ? implode(', ', array_map('strval', $v)) : json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            } elseif (is_bool($v)) {
                $v = $v ? 'Yes' : 'No';
            }
            if ($name !== '') {
                $out[$name] = mb_substr((string) $v, 0, 500);
            }
        };
        foreach ((array) ($x['fields'] ?? []) as $k => $v) {
            $walk($v, (string) $k);
        }
        if (isset($x['data']) && is_array($x['data'])) {
            $walk($x['data'], '');
        }
        return $out;
    }

    /** order_number → "Order number", billing.city → "Billing city". */
    private static function label(string $name): string
    {
        $t = trim(preg_replace('/[_.\-]+/', ' ', $name) ?? $name);
        return mb_strtoupper(mb_substr($t, 0, 1)) . mb_substr($t, 1);
    }

    private static function iso(?string $dt): ?string
    {
        return $dt ? gmdate('c', strtotime($dt . ' UTC')) : null;
    }
}
