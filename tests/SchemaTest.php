<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Schema;

final class SchemaTest extends TestCase
{
    public function testTheTableListMatchesWhatTheMigrationsMake(): void
    {
        // The installer drops these after a failed install, so a retry starts clean.
        $made = array_column($this->app->db->all('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()'), 't');
        $prefix = $this->config['db']['prefix'];
        $this->assertEqualsCanonicalizing(array_map(fn ($t) => $prefix . $t, Schema::tables()), $made);
    }
}
