<?php
declare(strict_types=1);

namespace Webmail\Tests;

use Webmail\Importer;

/** Where the usual providers' folders go, by their special-use flags or names. */
final class ImportFoldersTest extends \PHPUnit\Framework\TestCase
{
    public function testTheUsualFoldersMapToOurs(): void
    {
        $cases = [
            // Gmail
            ['INBOX', [], 'inbox'], ['[Gmail]/Sent Mail', ['\\sent'], 'sent'], ['[Gmail]/All Mail', ['\\all'], null], ['[Gmail]/Starred', ['\\flagged'], null],
            ['[Gmail]/Spam', ['\\junk'], null], ['[Gmail]/Bin', ['\\trash'], null], ['Receipts', [], 'archive'],
            // Outlook / Microsoft 365, without flags
            ['Sent Items', [], 'sent'], ['Deleted Items', [], null], ['Junk Email', [], null], ['Archive', [], 'archive'],
            // cPanel / Dovecot (INBOX.)
            ['INBOX.Sent', [], 'sent'], ['INBOX.Drafts', [], 'drafts'], ['INBOX.Trash', [], null], ['INBOX.spam', [], null],
            // Apple, and other languages
            ['Sent Messages', [], 'sent'], ['Deleted Messages', [], null], ['Gesendet', [], 'sent'], ['Papierkorb', [], null],
            // The customer's own folders keep their mail, even when named like these
            ['Clients/Sent', [], 'archive'], ['Projects/Trash talk', [], 'archive'],
        ];
        foreach ($cases as [$name, $attrs, $expected]) {
            $this->assertSame($expected, Importer::suggestTarget(['raw' => $name, 'name' => $name, 'attrs' => $attrs]), $name);
        }
    }

    public function testMboxFoldersAndFlagsComeFromTheirHeaders(): void
    {
        $this->assertSame(['sent', true, true], Importer::mboxFolder("X-Gmail-Labels: Sent,Starred,Opened\nSubject: x\n\nbody", 'inbox'));
        $this->assertSame(['inbox', false, false], Importer::mboxFolder("X-Gmail-Labels: \"Inbox\",Unread,\"Category Promotions\"\n\nbody", 'archive'));
        $this->assertSame(['archive', false, true], Importer::mboxFolder("X-Mozilla-Status: 0004\nSubject: x\n\nbody", 'archive'));
        $this->assertSame(['inbox', true, false], Importer::mboxFolder("Status: RO\n\nbody", 'inbox'));
        $this->assertSame(['inbox', false, false], Importer::mboxFolder("Status: O\n\nbody", 'inbox'));
    }
}
