<?php
declare(strict_types=1);

namespace Webmail;

/**
 * A mailbox's signature lives on its GhostParse address: the From name, a position and free text, plus the domain's
 * disclaimer. GhostParse adds them to everything sent from the address (here, the API, WordPress, Shopify), so they
 * read the same wherever the email comes from. This reads and saves them through the GhostParse API.
 *
 * Mailboxes from before 1.5.0 kept a signature here; it moves to GhostParse the first time it's needed (unless the
 * address already has one there, which then wins).
 */
final class Signatures
{
    public const MAX_NAME = 100;
    public const MAX_POSITION = 100;
    public const MAX_SIGNATURE = 2000;
    public const MAX_DISCLAIMER = 4000;

    public function __construct(private App $app)
    {
    }

    /** The GhostParse domain and address for a mailbox's address. */
    private function locate(string $address): array
    {
        $domainName = mb_strtolower((string) substr(strrchr($address, '@') ?: '', 1));
        try {
            foreach ($this->app->gp->domainsNamed($domainName) as $d) {
                foreach ($d['addresses'] ?? [] as $a) {
                    if (mb_strtolower((string) $a['address']) === mb_strtolower($address)) {
                        return [$d, $a];
                    }
                }
            }
        } catch (GhostParseError $e) {
            throw new HttpError(502, "Couldn't reach GhostParse for the signature: {$e->getMessage()}", 'ghostparse_error');
        }
        throw new HttpError(404, "$address isn't on your GhostParse account any more, so its signature can't be read.", 'unknown_address');
    }

    private static function clean(mixed $value, int $max): ?string
    {
        $s = trim(preg_replace('/[^\P{C}\n\t]/u', '', str_replace("\r\n", "\n", (string) $value)) ?? '');
        return $s === '' ? null : mb_substr($s, 0, $max);
    }

    /** A pre-1.5.0 signature kept here: move it to GhostParse. Returns true when none is left here. */
    public function migrate(array $mailbox): bool
    {
        if (($mailbox['signature'] ?? '') === '') {
            return true;
        }
        [$d, $a] = $this->locate($mailbox['address']);
        if (empty($a['signature']) && empty($a['position'])) {
            try {
                $this->app->gp->updateAddress($d['id'], $a['id'], ['signature' => self::clean($mailbox['signature'], self::MAX_SIGNATURE)]
                    + (empty($a['display_name']) && $mailbox['display_name'] !== '' ? ['display_name' => self::clean($mailbox['display_name'], self::MAX_NAME)] : []));
            } catch (GhostParseError $e) {
                return false;
            }
        }
        (new Mailstore($this->app))->updateMailbox((int) $mailbox['id'], ['signature' => '']);
        return true;
    }

    public function get(array $mailbox, bool $admin): array
    {
        $this->migrate($mailbox);
        [$d, $a] = $this->locate($mailbox['address']);
        return [
            'mailbox_id' => (int) $mailbox['id'],
            'address' => $mailbox['address'],
            'display_name' => (string) ($a['display_name'] ?? ''),
            'position' => (string) ($a['position'] ?? ''),
            'signature' => (string) ($a['signature'] ?? ''),
            'domain' => $d['name'],
            'disclaimer' => (string) ($d['disclaimer'] ?? ''),
            'can_edit_disclaimer' => $admin,
        ];
    }

    /** Save the address's signature (and, for administrators, the domain's disclaimer) on GhostParse. */
    public function save(array $mailbox, array $in, bool $admin): array
    {
        [$d, $a] = $this->locate($mailbox['address']);
        $fields = [];
        foreach (['display_name' => self::MAX_NAME, 'position' => self::MAX_POSITION, 'signature' => self::MAX_SIGNATURE] as $k => $max) {
            if (array_key_exists($k, $in)) {
                $fields[$k] = self::clean($in[$k], $max);
            }
        }
        try {
            if ($fields) {
                $this->app->gp->updateAddress($d['id'], $a['id'], $fields);
            }
            if (array_key_exists('disclaimer', $in)) {
                if (!$admin) {
                    throw new HttpError(403, 'Only administrators can change the domain\'s disclaimer: it\'s added to everyone\'s email from ' . $d['name'] . '.', 'forbidden');
                }
                $this->app->gp->updateDomain($d['id'], ['disclaimer' => self::clean($in['disclaimer'], self::MAX_DISCLAIMER)]);
            }
        } catch (GhostParseError $e) {
            throw new HttpError($e->status === 422 ? 422 : 502, "GhostParse didn't save it: {$e->getMessage()}", 'ghostparse_error');
        }
        // The From name here follows the address's, and nothing is kept here any more.
        $local = ['signature' => ''];
        if (array_key_exists('display_name', $fields)) {
            $local['display_name'] = (string) $fields['display_name'];
        }
        (new Mailstore($this->app))->updateMailbox((int) $mailbox['id'], $local);
        return $this->get(['signature' => ''] + $mailbox, $admin);
    }
}
