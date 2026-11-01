<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Mailstore;
use Webmail\Rules;

final class RulesTest extends TestCase
{
    private Mailstore $store;
    private Rules $rules;
    private int $support;
    private int $other;
    private array $alex;
    private array $kim;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new Mailstore($this->app);
        $this->rules = new Rules($this->app);
        $this->support = $this->store->createMailbox('support@acme.test');
        $this->other = $this->store->createMailbox('sales@acme.test');
        $auth = new Auth($this->app);
        $this->alex = ['id' => $auth->createUser('alex@acme.test', 'Alex Morgan', 'correct horse battery', 'user'), 'name' => 'Alex Morgan', 'email' => 'alex@acme.test', 'role' => 'user'];
        $this->kim = ['id' => $auth->createUser('kim@acme.test', 'Kim Lee', 'correct horse battery', 'user'), 'name' => 'Kim Lee', 'email' => 'kim@acme.test', 'role' => 'user'];
        $this->store->grant($this->alex['id'], $this->support);
        $this->store->grant($this->kim['id'], $this->other);
    }

    private function receive(array $overrides = []): int
    {
        return $this->store->storeInbound($this->inbound($overrides))[0]['id'];
    }

    private function row(int $id): array
    {
        return $this->app->db->one('SELECT folder, is_read, is_starred FROM {messages} WHERE id = ?', [$id]);
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

    public function testTheExampleRuleFilesInvoicesIntoAccountingTaggedBilling(): void
    {
        $accounting = $this->rules->saveLabel($this->alex, $this->support, 'Accounting');
        $billing = $this->rules->saveLabel($this->alex, $this->support, 'Billing');
        $this->rules->saveRule($this->alex, $this->support, ['name' => 'Invoices', 'match' => 'any',
            'conditions' => [['field' => 'from', 'op' => 'ends_with', 'value' => '@Example.com'], ['field' => 'subject', 'op' => 'contains', 'value' => 'invoice']],
            'actions' => ['move' => 'label', 'move_label' => $accounting['id'], 'tags' => [$billing['id']]]]);

        $byDomain = $this->receive(['from' => ['address' => 'billing@example.com', 'name' => 'Example Ltd'], 'subject' => 'Your statement']);
        $bySubject = $this->receive(['subject' => 'INVOICE 2026-114 attached']);
        $neither = $this->receive(['subject' => 'Where is my order?']);

        foreach ([$byDomain, $bySubject] as $id) {
            $this->assertSame('archive', $this->row($id)['folder'], 'out of the inbox');
            $this->assertSame(['Accounting', 'Billing'], array_column($this->rules->labelsOf([$id])[$id], 'name'));
        }
        $this->assertSame('inbox', $this->row($neither)['folder']);
        $this->assertSame([], $this->rules->labelsOf([$neither]));

        // The label shows them like a folder; the inbox doesn't.
        $inLabel = $this->store->list($this->alex['id'], $this->support, 'label', 1, '', false, '', $accounting['id']);
        $this->assertEqualsCanonicalizing([$byDomain, $bySubject], array_column($inLabel['messages'], 'id'));
        $this->assertSame([$neither], array_column($this->store->list($this->alex['id'], $this->support, 'inbox')['messages'], 'id'));
        // And the folder list counts them as unread under the label.
        $box = $this->store->mailboxesFor($this->alex['id'])[0];
        $this->assertSame(1, $box['unread']['inbox']);
        $this->assertSame([['id' => $accounting['id'], 'name' => 'Accounting', 'unread' => 2], ['id' => $billing['id'], 'name' => 'Billing', 'unread' => 2]], $box['labels']);
        $this->assertStringNotContainsString('Accounting', (string) $this->app->db->value('SELECT name_enc FROM {labels} LIMIT 1'), 'encrypted');
        $this->assertStringNotContainsString('invoice', (string) $this->app->db->value('SELECT rule_enc FROM {rules} LIMIT 1'), 'encrypted');
    }

    public function testAllConditionsMustMatchUnlessAnyIsChosen(): void
    {
        $rule = ['match' => 'all', 'conditions' => [['field' => 'from', 'op' => 'contains', 'value' => 'jane'], ['field' => 'subject', 'op' => 'not_contains', 'value' => 'urgent']]];
        $email = ['from' => ['address' => 'jane@customer.example', 'name' => 'Jane Doe'], 'subject' => 'Order', 'to' => [], 'text' => ''];
        $this->assertTrue(Rules::matches($rule, $email));
        $this->assertFalse(Rules::matches($rule, ['subject' => 'URGENT: order'] + $email));
        $this->assertTrue(Rules::matches(['match' => 'any'] + $rule, ['subject' => 'URGENT: order'] + $email));
        // A name counts as well as an address; recipients include Cc; "is" is the whole value.
        $this->assertTrue(Rules::matches(['conditions' => [['field' => 'from', 'op' => 'is', 'value' => 'jane doe']]], $email));
        $this->assertFalse(Rules::matches(['conditions' => [['field' => 'from', 'op' => 'is', 'value' => 'jane']]], $email));
        $this->assertTrue(Rules::matches(['conditions' => [['field' => 'to', 'op' => 'starts_with', 'value' => 'accounts@']]],
            ['to' => [['address' => 'support@acme.test']], 'cc' => [['address' => 'accounts@acme.test']]] + $email));
        $this->assertTrue(Rules::matches(['conditions' => [['field' => 'body', 'op' => 'contains', 'value' => 'refund']]], ['text' => '', 'html' => '<p>A <b>refund</b> please</p>'] + $email));
        $this->assertFalse(Rules::matches(['conditions' => []], $email), 'a rule without conditions matches nothing');
    }

    public function testEveryMatchingRuleTagsButTheFirstMoveWinsAndRulesCanMarkReadAndStar(): void
    {
        $vip = $this->rules->saveLabel($this->alex, $this->support, 'VIP');
        $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'from', 'op' => 'contains', 'value' => 'jane']], 'actions' => ['tags' => [$vip['id']], 'star' => true]]);
        $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'order']], 'actions' => ['move' => 'trash', 'read' => true]]);
        $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'order']], 'actions' => ['move' => 'spam']]);
        $id = $this->receive();
        $this->assertSame(['folder' => 'trash', 'is_read' => 1, 'is_starred' => 1], $this->row($id));
        $this->assertSame(['VIP'], array_column($this->rules->labelsOf([$id])[$id], 'name'));
    }

    public function testRulesLeaveSpamAlone(): void
    {
        $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'order']], 'actions' => ['move' => 'archive']]);
        $spam = $this->receive(['spam' => ['score' => 15, 'action' => 'reject']]);
        $this->assertSame('spam', $this->row($spam)['folder']);
    }

    public function testDisabledRulesDoNothingAndRulesBelongToTheirMailbox(): void
    {
        $r = $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'order']], 'actions' => ['move' => 'archive'], 'enabled' => false]);
        $this->assertFalse($r['enabled']);
        $this->assertSame('inbox', $this->row($this->receive())['folder']);
        // sales@ (Kim's) isn't affected by support@'s rules, and Kim can't see or change them.
        $this->rules->saveRule($this->alex, $this->support, ['id' => null, 'conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'order']], 'actions' => ['move' => 'archive']]);
        $sales = $this->store->storeInbound($this->inbound(['recipients' => [['address' => 'sales@acme.test', 'base_address' => 'sales@acme.test']], 'envelope' => ['rcpt_to' => ['sales@acme.test']]]))[0]['id'];
        $this->assertSame('inbox', $this->row($sales)['folder']);
        $this->fails(fn () => $this->rules->saveRule($this->kim, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'x']], 'actions' => ['read' => true]]), 404);
        $this->fails(fn () => $this->rules->saveRule($this->kim, 0, ['conditions' => []], $r['id']), 404);
        $this->fails(fn () => $this->rules->saveLabel($this->kim, $this->support, 'Mine'), 404);
    }

    public function testRulesAreChecked(): void
    {
        $ok = [['field' => 'subject', 'op' => 'contains', 'value' => 'x']];
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => [], 'actions' => ['read' => true]]), 422, '/at least one condition/');
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => ' ']], 'actions' => ['read' => true]]), 422, '/Fill in/');
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'headers', 'op' => 'contains', 'value' => 'x']], 'actions' => ['read' => true]]), 422);
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => $ok, 'actions' => []]), 422, '/what the rule does/');
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => $ok, 'actions' => ['move' => 'drafts']]), 422);
        // Labels from another mailbox can't be used.
        $theirs = $this->rules->saveLabel($this->kim, $this->other, 'Theirs');
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => $ok, 'actions' => ['move' => 'label', 'move_label' => $theirs['id']]]), 422);
        $this->fails(fn () => $this->rules->saveRule($this->alex, $this->support, ['conditions' => $ok, 'actions' => ['tags' => [$theirs['id']]]]), 422);
    }

    public function testApplyingARuleToTheInboxNow(): void
    {
        $old = $this->receive(['subject' => 'Invoice 1']);
        $other = $this->receive(['subject' => 'Hello']);
        $label = $this->rules->saveLabel($this->alex, $this->support, 'Accounting');
        $saved = $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'invoice']],
            'actions' => ['move' => 'label', 'move_label' => $label['id']], 'apply_now' => true]);
        $this->assertSame(1, $saved['applied']);
        $this->assertSame('archive', $this->row($old)['folder']);
        $this->assertSame('inbox', $this->row($other)['folder']);
    }

    public function testLabelsByHandAndDeletingALabelUpdatesRules(): void
    {
        $a = $this->rules->saveLabel($this->alex, $this->support, 'Accounting');
        $this->fails(fn () => $this->rules->saveLabel($this->alex, $this->support, ' accounting '), 409);
        $this->fails(fn () => $this->rules->saveLabel($this->alex, $this->support, ''), 422);
        $this->assertSame('Accounts', $this->rules->saveLabel($this->alex, 0, 'Accounts', $a['id'])['name'], 'renamed');
        $b = $this->rules->saveLabel($this->alex, $this->support, 'Billing');
        $id = $this->receive();
        $this->assertSame(1, $this->rules->label($this->alex, [$id], [$a['id'], $b['id']], []));
        $this->assertSame('inbox', $this->row($id)['folder'], 'tagging leaves it where it is');
        $this->assertSame(1, $this->rules->label($this->alex, [$id], [], [$b['id']], true));
        $this->assertSame('archive', $this->row($id)['folder'], 'moving takes it out of the inbox');
        $this->assertSame(['Accounts'], array_column($this->store->get($this->alex['id'], $id)['message']['labels'], 'name'));
        $this->fails(fn () => $this->rules->label($this->kim, [$id], [$a['id']], []), 404);

        $rule = $this->rules->saveRule($this->alex, $this->support, ['conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => 'x']],
            'actions' => ['move' => 'label', 'move_label' => $a['id'], 'tags' => [$a['id'], $b['id']]]]);
        $this->rules->deleteLabel($this->alex, $a['id']);
        $after = $this->rules->rules($this->support)[0];
        $this->assertSame($rule['id'], $after['id']);
        $this->assertSame(['move' => 'archive', 'tags' => [$b['id']], 'read' => false, 'star' => false], $after['actions']);
        $this->assertSame([], $this->rules->labelsOf([$id]), 'gone from the email too');
        $this->assertSame('archive', $this->row($id)['folder']);
    }

    public function testOrder(): void
    {
        $mk = fn ($v) => $this->rules->saveRule($this->alex, $this->support, ['name' => $v, 'conditions' => [['field' => 'subject', 'op' => 'contains', 'value' => $v]], 'actions' => ['read' => true]])['id'];
        [$one, $two, $three] = [$mk('one'), $mk('two'), $mk('three')];
        $this->rules->order($this->alex, $this->support, [$three, $one, $two]);
        $this->assertSame(['three', 'one', 'two'], array_column($this->rules->rules($this->support), 'name'));
    }
}
