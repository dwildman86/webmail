<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\AddressBook;
use Webmail\Auth;
use Webmail\Customers;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Team;

final class CustomersTest extends TestCase
{
    private Mailstore $store;
    private int $support;
    private int $sales;
    private array $alex;
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new Mailstore($this->app);
        $this->support = $this->store->createMailbox('support@acme.test');
        $this->sales = $this->store->createMailbox('sales@acme.test');
        $auth = new Auth($this->app);
        $this->alex = ['id' => $auth->createUser('alex@acme.test', 'Alex', 'correct horse battery', 'admin'), 'role' => 'admin', 'name' => 'Alex', 'email' => 'alex@acme.test'];
        $this->kim = ['id' => $auth->createUser('kim@acme.test', 'Kim', 'correct horse battery'), 'role' => 'user', 'name' => 'Kim', 'email' => 'kim@acme.test'];
        $this->store->grant($this->alex['id'], $this->support);
        $this->store->grant($this->alex['id'], $this->sales);
        $this->store->grant($this->kim['id'], $this->sales);
    }

    private function from(string $address, string $subject, string $thread, string $date, ?array $extracted = null, string $to = 'support@acme.test'): int
    {
        return $this->store->storeInbound($this->inbound([
            'from' => ['address' => $address, 'name' => 'Jane Doe'], 'subject' => $subject, 'thread_id' => $thread, 'date' => $date,
            'to' => [['address' => $to, 'name' => null]], 'recipients' => [['address' => $to, 'base_address' => $to, 'tag' => null]],
            'envelope' => ['mail_from' => $address, 'rcpt_to' => [$to], 'client_ip' => '198.51.100.7'], 'extracted' => $extracted,
        ]))[0]['id'];
    }

    public function testEverythingAboutTheCustomer(): void
    {
        $order = ['parser_id' => 'p1', 'parser' => 'Orders', 'method' => 'rules', 'error' => null, 'fields' => ['order_number' => '1042', 'plan' => 'Pro', 'phone' => null]];
        $a = $this->from('Jane@Customer.example', 'Where is order #1042?', 'thr_a', '2026-09-01T10:00:00Z', $order);
        $this->from('jane@customer.example', 'Re: Where is order #1042?', 'thr_a', '2026-09-02T10:00:00Z');
        // Later, a schema parser on another address, and a newer plan.
        $newer = ['parser_id' => 'p2', 'parser' => 'Upgrades', 'method' => 'schema', 'error' => null, 'fields' => [],
            'data' => ['plan' => 'Business', 'billing' => ['city' => 'Leeds', 'vat' => null], 'tags' => ['vip', 'annual'], 'renews' => true]];
        $b = $this->from('jane@customer.example', 'Upgrading', 'thr_b', '2026-10-05T09:00:00Z', $newer, 'sales@acme.test');
        // Someone else entirely.
        $this->from('bob@elsewhere.example', 'Hello', 'thr_c', '2026-10-06T09:00:00Z');
        // Alex replied to Jane from support (sent): her conversation, and the reply is found by its recipient.
        $this->store->storeImported($this->support, ['from' => ['address' => 'support@acme.test'], 'to' => [['address' => 'jane@customer.example']], 'subject' => 'Re: Where is order #1042?',
            'thread_id' => 'thr_a', 'date' => '2026-09-01T11:00:00Z', 'text' => 'On its way'], 'sent', true, false, 'sent-1');
        (new Team($this->app))->assign($this->alex, $a, ['status' => 'resolved']);
        (new AddressBook($this->app))->save(AddressBook::SHARED, ['email' => 'jane@customer.example', 'name' => 'Jane Doe', 'company' => 'Customer Ltd', 'phone' => '07700 900123']);

        $c = (new Customers($this->app))->forMessage($this->alex, $a)['customer'];
        $this->assertSame(['jane@customer.example', 'Jane Doe', 'Customer Ltd', 'shared'], [$c['address'], $c['name'], $c['contact']['company'], $c['contact']['book']]);
        $this->assertSame(['conversations' => 2, 'messages' => 4, 'open' => 0, 'resolved' => 1], array_intersect_key($c['stats'], array_flip(['conversations', 'messages', 'open', 'resolved'])));
        $this->assertSame('2026-09-01T10:00:00+00:00', $c['stats']['first_at']);
        $this->assertSame([['Upgrading', 'sales@acme.test', false, null, 1], ['Re: Where is order #1042?', 'support@acme.test', true, 'resolved', 3]],
            array_map(fn ($t) => [$t['subject'], $t['mailbox'], $t['current'], $t['status'], $t['messages']], $c['conversations']));
        // The newest value of each field first: the plan from October, the order number from September.
        $fields = array_column($c['fields'], null, 'name');
        $this->assertSame(['Business', 'Upgrades', false], [$fields['plan']['value'], $fields['plan']['parser'], $fields['plan']['this_conversation']]);
        $this->assertSame(['1042', 'Order number', true], [$fields['order_number']['value'], $fields['order_number']['label'], $fields['order_number']['this_conversation']]);
        $this->assertSame(['Leeds', 'Billing city'], [$fields['billing.city']['value'], $fields['billing.city']['label']]);
        $this->assertSame(['vip, annual', 'Yes'], [$fields['tags']['value'], $fields['renews']['value']]);
        $this->assertArrayNotHasKey('phone', $fields, 'empty fields are left out');
        $this->assertArrayNotHasKey('billing.vat', $fields);
        // Kim only reads sales@: she sees that conversation, not support's.
        $k = (new Customers($this->app))->forMessage($this->kim, $b)['customer'];
        $this->assertSame([1, ['Upgrading']], [$k['stats']['conversations'], array_column($k['conversations'], 'subject')]);
        $this->assertArrayNotHasKey('order_number', array_column($k['fields'], null, 'name'));
        try {
            (new Customers($this->app))->forMessage($this->kim, $a);
            $this->fail('Kim can read support@');
        } catch (HttpError $e) {
            $this->assertSame(404, $e->status);
        }
        // Nothing about the customer is stored in the clear.
        $this->assertStringNotContainsString('1042', json_encode($this->app->db->all('SELECT extracted_enc FROM {messages}')));
    }

    public function testEmailFromBeforeTheUpdateIsIndexed(): void
    {
        $a = $this->from('jane@customer.example', 'Old email', 'thr_old', '2025-01-01T10:00:00Z');
        // As if stored by 1.13.0: no people indexed yet.
        $this->app->db->run('DELETE FROM {message_parties}');
        $this->app->db->run('UPDATE {messages} SET parties_indexed = 0');
        $this->assertSame(0, (new Customers($this->app))->forMessage($this->alex, $a)['customer']['stats']['conversations']);
        $this->assertSame(1, $this->store->indexOldParties());
        $this->assertSame(0, $this->store->indexOldParties(), 'done');
        $this->assertSame(1, (new Customers($this->app))->forMessage($this->alex, $a)['customer']['stats']['conversations']);
        // Our own addresses aren't customers.
        $this->assertSame(1, (int) $this->app->db->value('SELECT COUNT(*) FROM {message_parties}'));
    }
}
