<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\AddressBook;
use Webmail\Auth;
use Webmail\HttpError;
use Webmail\Mailstore;

final class AddressBookTest extends TestCase
{
    private function people(): array
    {
        $auth = new Auth($this->app);
        $admin = ['id' => $auth->createUser('alex@acme.test', 'Alex', 'correct horse battery', 'admin'), 'role' => 'admin'];
        $user = ['id' => $auth->createUser('kim@acme.test', 'Kim', 'correct horse battery'), 'role' => 'user'];
        return [$admin, $user];
    }

    public function testPersonalBooksArePrivateAndTheSharedOneIsForEveryone(): void
    {
        [$admin, $kim] = $this->people();
        $book = new AddressBook($this->app);
        $book->save($kim['id'], ['name' => 'Priya Shah', 'email' => 'Priya@Fastmail.test', 'phone' => '+44 7700 900123', 'company' => 'Shah & Co', 'notes' => 'Prefers email']);
        $this->assertSame([], $book->list($admin['id']), "nobody else sees Kim's contacts");
        $this->assertSame('priya@fastmail.test', $book->list($kim['id'])[0]['email'], 'addresses are stored lower-case');
        $this->assertSame('personal', $book->list($kim['id'])[0]['book']);

        // A personal contact can only be changed or deleted in its own book.
        $id = $book->list($kim['id'])[0]['id'];
        try {
            $book->save($admin['id'], ['email' => 'x@y.test'], $id);
            $this->fail('changed someone else\'s contact');
        } catch (HttpError $e) {
            $this->assertSame(404, $e->status);
        }
        $this->assertSame(0, $book->delete($admin['id'], [$id]));
        $this->assertCount(1, $book->list($kim['id']));

        // The shared book: administrators change it, everyone reads it.
        AddressBook::checkCanEdit($admin, AddressBook::SHARED);
        try {
            AddressBook::checkCanEdit($kim, AddressBook::SHARED);
            $this->fail('a user changed the shared book');
        } catch (HttpError $e) {
            $this->assertSame(403, $e->status);
        }
        AddressBook::checkCanEdit($kim, $kim['id']);
        $this->assertSame(AddressBook::SHARED, AddressBook::owner($kim, 'shared'));
        $this->assertSame($kim['id'], AddressBook::owner($kim, 'personal'));
        $this->assertSame($kim['id'], AddressBook::owner($kim, 'anything else'), 'never someone else\'s book');
        $book->save(AddressBook::SHARED, ['name' => 'Harbour Café', 'email' => 'tom@harbourcafe.test']);
        $this->assertSame('shared', $book->list(AddressBook::SHARED)[0]['book']);

        // Duplicates are refused in one book but fine across books.
        try {
            $book->save($kim['id'], ['email' => 'PRIYA@fastmail.test']);
            $this->fail('duplicate');
        } catch (HttpError $e) {
            $this->assertSame('duplicate', $e->errorCode);
        }
        $book->save($admin['id'], ['email' => 'priya@fastmail.test']);
        $this->expectException(HttpError::class);
        $book->save($kim['id'], ['email' => 'not an address']);
    }

    public function testEveryFieldIsEncrypted(): void
    {
        [, $kim] = $this->people();
        (new AddressBook($this->app))->save($kim['id'], ['name' => 'Priya Shah', 'email' => 'priya@fastmail.test', 'phone' => '07700900123', 'company' => 'Shah Consulting', 'notes' => 'Allergic to hazelnuts']);
        $row = implode('|', $this->app->db->one('SELECT * FROM {address_book}'));
        foreach (['Priya', 'fastmail', '07700900123', 'Shah', 'hazelnuts'] as $plain) {
            $this->assertStringNotContainsString($plain, $row);
        }
    }

    public function testSuggestionsComeFromBothBooksThenRecentAddresses(): void
    {
        [$admin, $kim] = $this->people();
        $book = new AddressBook($this->app);
        $book->save($kim['id'], ['name' => 'Priya (mine)', 'email' => 'priya@fastmail.test']);
        $book->save(AddressBook::SHARED, ['name' => 'Priya (shared)', 'email' => 'priya@fastmail.test']);
        $book->save(AddressBook::SHARED, ['name' => 'Tom Ellis', 'email' => 'tom@harbourcafe.test']);
        $mb = (new Mailstore($this->app))->createMailbox('support@acme.test');
        (new Mailstore($this->app))->grant($kim['id'], $mb);
        $this->answers['POST /v1/emails'] = fn () => [200, ['id' => 'out_1', 'message_id' => '<1@acme.test>']];
        (new Mailstore($this->app))->send(['id' => $kim['id'], 'name' => 'Kim'], $mb, ['to' => 'new.person@example.test, tom@harbourcafe.test', 'subject' => 'Hi', 'text' => 'Hello']);

        $s = $book->suggestions($kim['id']);
        $this->assertSame([['priya@fastmail.test', 'Priya (mine)', 'personal'], ['tom@harbourcafe.test', 'Tom Ellis', 'shared'], ['new.person@example.test', '', 'recent']],
            array_map(fn ($c) => [$c['email'], $c['name'], $c['source']], $s), 'own name wins, one entry per address');
        $this->assertCount(2, $book->suggestions($admin['id']), "Kim's personal contacts and recent addresses stay Kim's");
    }

    public function testImportsVcardsFromPhonesAndMailApps(): void
    {
        [, $kim] = $this->people();
        $vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Shah;Priya;;Dr.;\r\nFN:Dr. Priya Shah\r\nORG:Shah Consulting;Research\r\n"
            . "EMAIL;TYPE=INTERNET,HOME:priya@home.test\r\nitem1.EMAIL;TYPE=INTERNET,pref:priya@work.test\r\nTEL;TYPE=CELL:+44 7700 900123\r\n"
            . "NOTE:Met at the trade show\\, 2025.\\nLikes oat milk.\r\nEND:VCARD\r\n"
            // vCard 4.0 with a folded line and no FN
            . "BEGIN:VCARD\r\nVERSION:4.0\r\nN:Ellis;Tom;;;\r\nEMAIL:tom@harbour\r\n cafe.test\r\nEND:VCARD\r\n"
            // vCard 2.1 with quoted-printable
            . "BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Mar=C3=ADa Garc=C3=ADa\r\nEMAIL;INTERNET:maria@outlook.test\r\nEND:VCARD\r\n"
            . "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Email\r\nTEL:123\r\nEND:VCARD\r\n";
        $book = new AddressBook($this->app);
        $this->assertSame(['added' => 4, 'updated' => 0, 'skipped' => 0], $book->import($kim['id'], $vcf, 'contacts.vcf'));
        $all = array_column($book->list($kim['id']), null, 'email');
        $this->assertSame('Dr. Priya Shah', $all['priya@work.test']['name']);
        $this->assertSame('Shah Consulting, Research', $all['priya@work.test']['company']);
        $this->assertSame("Met at the trade show, 2025.\nLikes oat milk.", $all['priya@home.test']['notes']);
        $this->assertSame('+44 7700 900123', $all['priya@home.test']['phone']);
        $this->assertSame('Tom Ellis', $all['tom@harbourcafe.test']['name'], 'name from N when there is no FN; folded line joined');
        $this->assertSame('María García', $all['maria@outlook.test']['name']);
        $this->assertSame(0, AddressBook::parseVcard("BEGIN:VCARD\nFN:Pref first\nEMAIL:a@x.test\nEMAIL;PREF=1:b@x.test\nEND:VCARD")[0]['email'] === 'b@x.test' ? 0 : 1, 'preferred address first');

        // Importing again fills gaps but never overwrites what's there.
        $book->save($kim['id'], ['email' => 'maria@outlook.test', 'name' => 'Maria (edited)'], $all['maria@outlook.test']['id']);
        $again = "BEGIN:VCARD\nFN:Someone Else\nEMAIL:maria@outlook.test\nTEL:+34 600 000 000\nEND:VCARD\n";
        $this->assertSame(['added' => 0, 'updated' => 1, 'skipped' => 0], $book->import($kim['id'], $again, 'x.vcf'));
        $maria = array_column($book->list($kim['id']), null, 'email')['maria@outlook.test'];
        $this->assertSame(['Maria (edited)', '+34 600 000 000'], [$maria['name'], $maria['phone']]);
    }

    public function testImportsCsvFromGoogleAndOutlook(): void
    {
        [, $kim] = $this->people();
        $book = new AddressBook($this->app);
        $google = "\xEF\xBB\xBFName,Given Name,Family Name,Organization 1 - Name,Phone 1 - Value,E-mail 1 - Type,E-mail 1 - Value,E-mail 2 - Value,Notes\n"
            . "Priya Shah,Priya,Shah,Shah Consulting,+44 7700 900123,* Work,priya@work.test ::: priya@home.test,priya@other.test,\"Met at the show, 2025\"\n"
            . ",Tom,Ellis,,,,tom@harbourcafe.test,,\n"
            . "No Address,,,,,,,,\n";
        $this->assertSame(['added' => 4, 'updated' => 0, 'skipped' => 0], $book->import($kim['id'], $google, 'contacts.csv'));
        $all = array_column($book->list($kim['id']), null, 'email');
        $this->assertSame(['Priya Shah', 'Shah Consulting', 'Met at the show, 2025'], [$all['priya@home.test']['name'], $all['priya@home.test']['company'], $all['priya@other.test']['notes']]);
        $this->assertSame('Tom Ellis', $all['tom@harbourcafe.test']['name']);

        $outlook = "First Name;Middle Name;Last Name;Company;E-mail Address;Mobile Phone\nMaría;;García;;MARIA@OUTLOOK.TEST;600 000 000\nBad;;Row;;not-an-email;\n";
        $this->assertSame(['added' => 1, 'updated' => 0, 'skipped' => 1], $book->import($kim['id'], mb_convert_encoding($outlook, 'Windows-1252', 'UTF-8'), 'outlook.csv'));
        $this->assertSame('María García', array_column($book->list($kim['id']), null, 'email')['maria@outlook.test']['name'], 'Windows-1252 files read correctly');

        try {
            $book->import($kim['id'], "Name,Phone\nPriya,123\n", 'x.csv');
            $this->fail('no email column');
        } catch (HttpError $e) {
            $this->assertSame('nothing_found', $e->errorCode);
        }
    }

    public function testExportRoundTrips(): void
    {
        [, $kim] = $this->people();
        $book = new AddressBook($this->app);
        $book->save($kim['id'], ['name' => 'Priya Shah; PhD', 'email' => 'priya@work.test', 'phone' => '+44 7700 900123', 'company' => 'Shah, Consulting',
            'notes' => "Line one\nLine two " . str_repeat('é', 60)]);
        $book->save($kim['id'], ['email' => 'nobody@x.test']);
        $vcf = $book->exportVcard($kim['id']);
        $this->assertSame(2, substr_count($vcf, "BEGIN:VCARD\r\nVERSION:3.0\r\n"));
        foreach (explode("\r\n", $vcf) as $line) {
            $this->assertLessThanOrEqual(76, strlen($line), 'lines folded at 75 octets');
            $this->assertTrue(mb_check_encoding($line, 'UTF-8'), 'never splits a character');
        }
        $back = array_column(AddressBook::parseVcard($vcf), null, 'email');
        $this->assertSame(['Priya Shah; PhD', '+44 7700 900123', 'Shah, Consulting', "Line one\nLine two " . str_repeat('é', 60)],
            [$back['priya@work.test']['name'], $back['priya@work.test']['phone'], $back['priya@work.test']['company'], $back['priya@work.test']['notes']]);
        $this->assertSame('nobody@x.test', $back['nobody@x.test']['name'], 'a contact without a name is named by its address');
    }
}
