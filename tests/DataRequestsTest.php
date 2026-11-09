<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\AddressBook;
use Webmail\Auth;
use Webmail\DataRequests;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Team;

/** GDPR data requests: another system (or an administrator) finds everything about one person, and exports it. */
final class DataRequestsTest extends TestCase
{
    private Mailstore $store;
    private DataRequests $dr;
    private int $support;
    private int $sales;
    private array $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new Mailstore($this->app);
        $this->support = $this->store->createMailbox('support@acme.test');
        $this->sales = $this->store->createMailbox('sales@acme.test');
        $uid = (new Auth($this->app))->createUser('admin@acme.test', 'Ada Admin', 'correct horse battery', 'admin');
        $this->store->grant($uid, $this->support);
        $this->store->grant($uid, $this->sales);
        $this->admin = ['id' => $uid, 'email' => 'admin@acme.test', 'name' => 'Ada Admin', 'role' => 'admin'];
        $this->dr = new DataRequests($this->app);
    }

    private function receive(array $overrides = [], string $to = 'support@acme.test'): int
    {
        return $this->store->storeInbound($this->inbound($overrides + [
            'recipients' => [['address' => $to, 'base_address' => $to, 'tag' => null]],
            'envelope' => ['mail_from' => 'x@y.example', 'rcpt_to' => [$to], 'client_ip' => '198.51.100.7'],
        ]))[0]['id'];
    }

    private function other(array $overrides = [], string $to = 'support@acme.test'): int
    {
        return $this->receive($overrides + ['from' => ['address' => 'bob@elsewhere.example', 'name' => 'Bob Other'], 'subject' => 'Unrelated',
            'text' => 'Nothing to see here.', 'html' => null, 'attachments' => []], $to);
    }

    private function fails(callable $fn, int $status, string $pattern = '/./'): void
    {
        try {
            $fn();
        } catch (HttpError $e) {
            $this->assertSame($status, $e->status, $e->getMessage());
            $this->assertMatchesRegularExpression($pattern, $e->getMessage());
            return;
        }
        $this->fail("no error, expected $status");
    }

    /** @return array<string, string> the export's files */
    private function export(string $id, ?int $keyId = null): array
    {
        $out = fopen('php://temp', 'w+b');
        $info = $this->dr->export($id, $out, $keyId, 'test');
        rewind($out);
        $bytes = stream_get_contents($out);
        $this->assertSame($info['bytes'], strlen($bytes));
        $file = tempnam(sys_get_temp_dir(), 'dr');
        file_put_contents($file, $bytes);
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($file, \ZipArchive::CHECKCONS) === true, 'a valid ZIP');
        $files = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $files[$zip->getNameIndex($i)] = $zip->getFromIndex($i);
        }
        $zip->close();
        unlink($file);
        return $files;
    }

    public function testFindsTheAddressAndTheTermsWhereverTheyAre(): void
    {
        $from = $this->receive(['from' => ['address' => 'Jane@Customer.example', 'name' => 'Jane Doe']]);
        $cc = $this->other(['cc' => [['address' => 'jane@customer.example', 'name' => '']]], 'sales@acme.test');
        $inText = $this->other(['text' => 'Please call jane@customer.example back about her refund.']);
        $byName = $this->other(['text' => "Spoke to JANE   DOE on the phone today."]);
        $byPhone = $this->other(['subject' => 'Callback 07700 900123']);
        $inFileName = $this->other(['attachments' => [['filename' => 'jane@customer.example-invoice.pdf', 'content_type' => 'application/pdf', 'size' => 3, 'content' => base64_encode('PDF')]]]);
        // Far past what the search index holds: only the scan finds it.
        $deep = $this->other(['text' => str_repeat('lorem ipsum dolor sit amet ', 1500) . "\nForwarded from jane@customer.example"]);
        $other = $this->other();
        $notQuite = $this->other(['text' => 'jane.doe@customer.example is someone else', 'subject' => 'Jane alone']);
        // Every folder counts: Trash too.
        $this->store->update($this->admin['id'], [$inText], ['folder' => 'trash']);

        $r = $this->dr->create(['email' => ' JANE@customer.example ', 'terms' => ['Jane Doe', '07700 900123'], 'reference' => 'TICKET-77'], ['user' => $this->admin['id']]);
        $this->assertSame('ready', $r['status']);
        $this->assertSame('jane@customer.example', $r['email']);
        $this->assertSame(['scanned' => 9, 'total' => 9], $r['progress']);
        $r = $this->dr->get($r['id']);
        $found = array_column($r['messages'], 'matched_on', 'id');
        ksort($found);
        $this->assertSame([
            $from => ['from', 'term:Jane Doe'], $cc => ['cc'], $inText => ['text'], $byName => ['term:Jane Doe'], $byPhone => ['term:07700 900123'],
            $inFileName => ['attachment_name'], $deep => ['text'],
        ], $found);
        $this->assertArrayNotHasKey($other, $found);
        $this->assertArrayNotHasKey($notQuite, $found);
        $this->assertSame(7, $r['matches']);
        $this->assertSame('TICKET-77', $r['reference']);
        $this->assertSame(['user' => 'admin@acme.test'], $r['requested_by']);
        $this->assertSame('trash', array_column($r['messages'], 'folder', 'id')[$inText]);
    }

    public function testNarrowsToMailboxesAndDates(): void
    {
        $jane = ['from' => ['address' => 'jane@customer.example', 'name' => 'Jane']];
        $old = $this->receive($jane + ['date' => '2024-03-01T10:00:00Z']);
        $new = $this->receive($jane + ['date' => '2026-03-01T10:00:00Z']);
        $sales = $this->receive($jane + ['date' => '2026-03-02T10:00:00Z'], 'sales@acme.test');
        $r = $this->dr->get($this->dr->create(['email' => 'jane@customer.example', 'mailboxes' => ['support@acme.test'], 'since' => '2025-01-01'], ['user' => $this->admin['id']])['id']);
        $this->assertSame([$new], array_column($r['messages'], 'id'));
        $this->assertSame(['support@acme.test'], $r['mailboxes']);
        $r = $this->dr->get($this->dr->create(['email' => 'jane@customer.example', 'until' => '2026-03-01T23:00:00Z'], ['user' => $this->admin['id']])['id']);
        $this->assertEqualsCanonicalizing([$old, $new], array_column($r['messages'], 'id'));
        $this->assertSame('all', $r['mailboxes']);
        unset($sales);

        $this->fails(fn () => $this->dr->create(['email' => 'not an address'], ['user' => 1]), 422, '/email/');
        $this->fails(fn () => $this->dr->create(['email' => 'a@b.example', 'mailboxes' => ['nobody@acme.test']], ['user' => 1]), 422, '/no mailbox/');
        $this->fails(fn () => $this->dr->create(['email' => 'a@b.example', 'terms' => ['ab']], ['user' => 1]), 422, '/too short/');
        $this->fails(fn () => $this->dr->create(['email' => 'a@b.example', 'since' => 'whenever'], ['user' => 1]), 422, '/date/');
    }

    public function testABigMailboxIsSearchedInSteps(): void
    {
        $match = [];
        for ($i = 0; $i < 7; $i++) {
            $id = $i % 3 === 0 ? $this->receive(['from' => ['address' => 'jane@customer.example', 'name' => 'Jane']]) : $this->other();
            if ($i % 3 === 0) {
                $match[] = $id;
            }
        }
        $this->dr->scanSeconds = 0; // one batch per call
        $this->dr->batch = 3;
        $r = $this->dr->create(['email' => 'jane@customer.example'], ['user' => $this->admin['id']]);
        $this->assertSame('searching', $r['status']);
        $this->assertSame(['scanned' => 3, 'total' => 7], $r['progress']);
        $this->fails(fn () => $this->export($r['id']), 409, '/Still searching/');
        $r = $this->dr->get($r['id']);
        $this->assertSame(['searching', 6], [$r['status'], $r['progress']['scanned']]);
        $this->assertArrayNotHasKey('messages', $r);
        // A message deleted while it searches isn't in the results.
        $this->app->db->run('DELETE FROM {messages} WHERE id = ?', [$match[2]]);
        $r = $this->dr->get($r['id']);
        $r = $r['status'] === 'ready' ? $r : $this->dr->get($r['id']);
        $this->assertSame('ready', $r['status']);
        $this->assertSame([$match[1], $match[0]], array_column($r['messages'], 'id'));
    }

    public function testTheExport(): void
    {
        $book = new AddressBook($this->app);
        $book->save(AddressBook::SHARED, ['email' => 'jane@customer.example', 'name' => 'Jane Doe', 'phone' => '07700 900123', 'notes' => 'Prefers email']);
        $book->save($this->admin['id'], ['email' => 'bob@elsewhere.example', 'name' => 'Bob']);
        $a = $this->receive(['from' => ['address' => 'jane@customer.example', 'name' => 'Jane Doe'], 'subject' => 'Refund: order #1042',
            'attachments' => [['filename' => 'receipt.pdf', 'content_type' => 'application/pdf', 'size' => 9, 'content' => base64_encode('%PDF-1.4 x')],
                ['filename' => 'big.zip', 'content_type' => 'application/zip', 'size' => 9, 'storage' => ['url' => 'https://files.acme.test/big.zip']]]]);
        $this->receive(['from' => ['address' => 'jane@customer.example', 'name' => 'Jane Doe'], 'subject' => 'Refund: order #1042', 'text' => 'Second one']);
        $this->other();
        (new Team($this->app))->addNote($this->admin, $a, 'Refund approved by finance.');
        $id = $this->dr->create(['email' => 'jane@customer.example', 'reference' => 'TICKET-77'], ['user' => $this->admin['id']])['id'];

        $files = $this->export($id);
        $names = array_keys($files);
        sort($names);
        $this->assertSame(['README.txt', 'contacts.json', 'messages.csv',
            'messages/0001 2026-10-01 Refund order 1042/message.html', 'messages/0001 2026-10-01 Refund order 1042/message.txt',
            'messages/0002 2026-10-01 Refund order 1042/attachments/receipt.pdf',
            'messages/0002 2026-10-01 Refund order 1042/message.html', 'messages/0002 2026-10-01 Refund order 1042/message.txt',
            'request.json', 'team-notes.json'], $names);
        $this->assertSame('%PDF-1.4 x', $files['messages/0002 2026-10-01 Refund order 1042/attachments/receipt.pdf']);
        $txt = $files['messages/0002 2026-10-01 Refund order 1042/message.txt'];
        $this->assertStringContainsString("From:     Jane Doe <jane@customer.example>", $txt);
        $this->assertStringContainsString('Matched:  from', $txt);
        $this->assertStringContainsString("my parcel hasn't arrived", $txt);
        $csv = array_map('str_getcsv', explode("\n", trim(substr($files['messages.csv'], 3))));
        $this->assertSame(['#', 'date', 'mailbox', 'folder', 'from', 'to', 'cc', 'subject', 'matched_on', 'attachments', 'path'], $csv[0]);
        $this->assertCount(3, $csv);
        $this->assertSame('receipt.pdf; big.zip (stored elsewhere: https://files.acme.test/big.zip)', $csv[2][9]);
        $contacts = json_decode($files['contacts.json'], true);
        $this->assertSame([['address_book' => 'shared', 'email' => 'jane@customer.example', 'name' => 'Jane Doe', 'phone' => '07700 900123']],
            array_map(fn ($e) => array_intersect_key($e, array_flip(['address_book', 'email', 'name', 'phone'])), $contacts['address_book']));
        $this->assertSame('Refund approved by finance.', json_decode($files['team-notes.json'], true)[0]['note']);
        $this->assertStringContainsString('article 15(4)', $files['README.txt']);
        $this->assertStringContainsString('TICKET-77', $files['README.txt']);
        $this->assertSame(2, json_decode($files['request.json'], true)['matches']);
        $this->assertSame(1, $this->dr->get($id)['downloads']);

        // Without attachments, they're listed instead.
        $id = $this->dr->create(['email' => 'jane@customer.example', 'include_attachments' => false], ['user' => $this->admin['id']])['id'];
        $files = $this->export($id);
        $this->assertCount(0, array_filter(array_keys($files), fn ($n) => str_contains($n, '/attachments/')));
        $this->assertStringContainsString('receipt.pdf (not included)', $files['messages.csv']);
    }

    public function testResultsAreRemovedAfterThirtyDaysOrWhenDiscarded(): void
    {
        $this->receive(['from' => ['address' => 'jane@customer.example', 'name' => 'Jane']]);
        $r = $this->dr->create(['email' => 'jane@customer.example'], ['user' => $this->admin['id']]);
        $this->assertEqualsWithDelta(time() + 30 * 86400, strtotime($r['expires_at']), 5);
        $this->app->db->run('UPDATE {data_requests} SET expires_at = ? WHERE public_id = ?', [gmdate('Y-m-d H:i:s', time() - 1), $r['id']]);
        $gone = $this->dr->get($r['id']);
        $this->assertSame(['expired', null], [$gone['status'], $gone['matches']]);
        $this->assertNull($this->app->db->value('SELECT matches_enc FROM {data_requests} WHERE public_id = ?', [$r['id']]));
        $this->assertSame('jane@customer.example', $gone['email'], 'the record of the request stays');
        $this->fails(fn () => $this->export($r['id']), 410, '/removed/');

        $r = $this->dr->create(['email' => 'jane@customer.example'], ['user' => $this->admin['id']]);
        $this->assertSame('expired', $this->dr->discard($r['id'])['status']);
        $this->fails(fn () => $this->export($r['id']), 410);
    }

    public function testKeysForOtherSystems(): void
    {
        $k = $this->dr->createKey($this->admin['id'], 'Our CRM');
        $this->assertMatchesRegularExpression('/^wmk_[A-Za-z0-9_-]{43}$/', $k['key']);
        $this->assertSame('Our CRM', $this->dr->authenticate($k['key'], '203.0.113.9')['name']);
        $this->assertNotNull($this->dr->keys()[0]['last_used_at']);
        $this->assertStringNotContainsString(substr($k['key'], 4), print_r($this->app->db->all('SELECT * FROM {api_keys}'), true), 'only an HMAC of the key is kept');
        $this->fails(fn () => $this->dr->authenticate('wmk_wrong', '203.0.113.9'), 401);
        $this->fails(fn () => $this->dr->authenticate(null, '203.0.113.9'), 401);

        // Each key sees only its own requests.
        $other = $this->dr->createKey($this->admin['id'], 'Help desk', ['198.51.100.20']);
        $mine = $this->dr->create(['email' => 'jane@customer.example'], ['key' => $k['id']]);
        $this->assertSame(['key' => 'Our CRM'], $mine['requested_by']);
        $this->fails(fn () => $this->dr->get($mine['id'], $other['id']), 404);
        $this->assertCount(1, $this->dr->list($k['id']));
        $this->assertCount(0, $this->dr->list($other['id']));
        $this->assertCount(1, $this->dr->list(), 'an administrator sees them all');

        // A key can be held to IP addresses, and revoked.
        $this->fails(fn () => $this->dr->authenticate($other['key'], '203.0.113.9'), 403, '/203\.0\.113\.9/');
        $this->assertSame('Help desk', $this->dr->authenticate($other['key'], '198.51.100.20')['name']);
        $this->fails(fn () => $this->dr->createKey($this->admin['id'], 'x', ['not-an-ip']), 422);
        $this->dr->revokeKey($k['id']);
        $this->fails(fn () => $this->dr->authenticate($k['key'], '203.0.113.9'), 401);
        $this->assertSame(['Help desk'], array_column($this->dr->keys(), 'name'));
    }

    public function testAKeyCantPileUpSearches(): void
    {
        $k = $this->dr->createKey($this->admin['id'], 'CRM');
        for ($i = 0; $i < 3; $i++) {
            $this->other();
        }
        $this->dr->scanSeconds = 0;
        $this->dr->batch = 1;
        for ($i = 0; $i < DataRequests::MAX_SEARCHING; $i++) {
            $this->dr->create(['email' => "p$i@customer.example"], ['key' => $k['id']]);
        }
        $this->fails(fn () => $this->dr->create(['email' => 'more@customer.example'], ['key' => $k['id']]), 429);
    }
}
