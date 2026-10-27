<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Sessions;

final class SessionsTest extends TestCase
{
    public function testSessionsAreKeptEncryptedInTheDatabaseUntilTheyIdleOut(): void
    {
        $s = new Sessions($this->app, 30 * 86400);
        $id = bin2hex(random_bytes(16));
        $this->assertFalse($s->validateId($id), 'an id this webmail never issued is refused');
        $this->assertSame('', $s->read($id));

        $s->write($id, 'uid|i:7;csrf|s:4:"abcd";');
        $this->assertTrue($s->validateId($id));
        $this->assertSame('uid|i:7;csrf|s:4:"abcd";', $s->read($id));
        $row = $this->app->db->one('SELECT * FROM {sessions}');
        $this->assertSame(hash('sha256', $id), $row['id_hash'], 'only a hash of the id: a copy of the database can\'t sign anyone in');
        $this->assertStringNotContainsString('csrf', $row['data_enc'], 'the contents are encrypted');

        // A month without use: gone.
        $this->app->db->run('UPDATE {sessions} SET updated_at = ?', [time() - 31 * 86400]);
        $this->assertSame('', $s->read($id));
        $this->assertFalse($s->validateId($id));
        $this->assertSame(1, $s->gc(0));

        // Using it keeps it going; signing out removes it.
        $s->write($id, 'x');
        $this->app->db->run('UPDATE {sessions} SET updated_at = ?', [time() - 29 * 86400]);
        $s->updateTimestamp($id, 'x');
        $this->assertSame('x', $s->read($id));
        $s->destroy($id);
        $this->assertFalse($s->validateId($id));
    }
}
