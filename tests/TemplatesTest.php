<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Templates;

final class TemplatesTest extends TestCase
{
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

    public function testPersonalAndSharedTemplates(): void
    {
        $auth = new Auth($this->app);
        $admin = ['id' => $auth->createUser('alex@acme.test', 'Alex', 'correct horse battery', 'admin'), 'role' => 'admin'];
        $kim = ['id' => $auth->createUser('kim@acme.test', 'Kim', 'correct horse battery', 'user'), 'role' => 'user'];
        $t = new Templates($this->app);
        $mine = $t->save($t->owner($kim, 'personal'), ['name' => 'Refund done', 'shortcut' => '/Refund', 'subject' => 'Your refund',
            'html' => '<p>Hi {first_name},</p><p>Your refund for ticket <b>{ticket_id}</b> is on its way.</p>']);
        $this->assertSame(['Refund done', 'refund', 'Your refund'], [$mine['name'], $mine['shortcut'], $mine['subject']]);
        $this->assertStringContainsString('{first_name}', $mine['html']);
        $this->assertStringNotContainsString('refund', (string) $this->app->db->value('SELECT body_enc FROM {templates}'), 'encrypted');

        $this->fails(fn () => $t->owner($kim, 'shared'), 403);
        $shared = $t->save($t->owner($admin, 'shared'), ['name' => 'Opening hours', 'html' => 'We are open 9-5.']);
        $this->assertSame([], $t->list($admin['id']));
        $this->assertSame([$shared['id']], array_column($t->list(Templates::SHARED), 'id'));
        $this->assertSame([$mine['id']], array_column($t->list($kim['id']), 'id'));

        // Shortcuts are unique per set; someone else's template can't be changed or deleted.
        $this->fails(fn () => $t->save($kim['id'], ['name' => 'Other', 'shortcut' => 'refund', 'html' => 'x']), 409, '/already/');
        $this->fails(fn () => $t->save($kim['id'], ['name' => 'Other', 'shortcut' => 'two words', 'html' => 'x']), 422);
        $this->fails(fn () => $t->save($kim['id'], ['name' => '', 'html' => 'x']), 422);
        $this->fails(fn () => $t->save($kim['id'], ['name' => 'Empty', 'html' => '<p> </p>']), 422);
        $this->fails(fn () => $t->save($admin['id'], ['name' => 'Mine now', 'html' => 'x'], $mine['id']), 404);
        $this->fails(fn () => $t->delete($admin['id'], $mine['id']), 404);
        $this->assertSame('Refund sent', $t->save($kim['id'], ['name' => 'Refund sent', 'shortcut' => 'refund', 'html' => 'Done'], $mine['id'])['name']);
        $t->delete($kim['id'], $mine['id']);
        $this->assertSame([], $t->list($kim['id']));
    }

    public function testOnlySimpleFormattingIsKept(): void
    {
        $this->assertSame('<p>Hi <b>there</b> <a href="https://acme.test/x">link</a> <a>bad</a></p>alert(1)<ul><li>one</li></ul>text',
            Templates::sanitize('<p onclick="x()" style="color:red">Hi <b class="y">there</b> <a href="https://acme.test/x" target="_blank">link</a> <a href="javascript:alert(1)">bad</a></p>'
                . '<script>alert(1)</script><font color=red>alert(1)</font><ul><li>one</li></ul><img src=x onerror=alert(1)><style>p{}</style><!-- c -->text'));
        $this->assertSame('Ünïcode {first_name} &amp; more', Templates::sanitize('Ünïcode {first_name} &amp; more'));
        $this->assertSame('<a href="mailto:a@b.test">mail</a>', Templates::sanitize('<a href="mailto:a@b.test">mail</a>'));
    }
}
