<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Templates (canned responses): formatted text with placeholders like {first_name}, {company} and {ticket_id}, put
 * into an email while writing it, by typing / and its shortcut or name, or from the Templates button. Each person has
 * their own, and there's a shared set everyone can use (administrators edit it). The placeholders are filled in by the
 * page, from the email being written; the text is kept to simple formatting (no scripts, styles or images), encrypted.
 */
final class Templates
{
    public const SHARED = 0;
    public const MAX_BODY = 50000;
    public const MAX_TEMPLATES = 200;
    /** The placeholders the page fills in, with what each one is, for the settings. */
    public const PLACEHOLDERS = [
        'first_name' => "The recipient's first name",
        'last_name' => "The recipient's last name",
        'name' => "The recipient's full name",
        'email' => "The recipient's email address",
        'company' => "The recipient's company (from your contacts)",
        'ticket_id' => "The conversation's reference, the same for everyone replying to it",
        'subject' => 'The subject',
        'my_name' => 'Your name',
        'my_first_name' => 'Your first name',
        'my_email' => 'The address you send from',
        'date' => "Today's date",
    ];
    private const TAGS = ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a', 'span', 'h1', 'h2', 'h3', 'hr'];
    private const DROP = ['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'head', 'title', 'meta', 'link', 'form', 'input', 'button', 'select', 'textarea', 'img', 'video', 'audio'];

    public function __construct(private App $app)
    {
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    public function route(string $action, string $method, array $user): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        switch ("$method $action") {
            case 'GET templates':
                Http::json(['personal' => $this->list($user['id']), 'shared' => $this->list(self::SHARED), 'can_edit_shared' => $user['role'] === 'admin',
                    'placeholders' => self::PLACEHOLDERS]);
            case 'POST templates/save':
                $owner = $this->owner($user, (string) ($in['book'] ?? 'personal'));
                Http::json($this->save($owner, $in, isset($in['id']) ? (int) $in['id'] : null), 201);
            case 'POST templates/delete':
                $owner = $this->owner($user, (string) ($in['book'] ?? 'personal'));
                $this->delete($owner, (int) ($in['id'] ?? 0));
                Http::json(['ok' => true]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    /** Whose templates: the user's own, or the shared ones (administrators only change those). */
    public function owner(array $user, string $which): int
    {
        if ($which === 'shared') {
            if ($user['role'] !== 'admin') {
                throw new HttpError(403, 'Only administrators can change the shared templates', 'forbidden');
            }
            return self::SHARED;
        }
        return (int) $user['id'];
    }

    public function list(int $owner): array
    {
        $c = $this->c();
        $out = [];
        foreach ($this->app->db->all('SELECT * FROM {templates} WHERE owner_id = ?', [$owner]) as $r) {
            $out[] = ['id' => (int) $r['id'], 'name' => (string) $c->decrypt($r['name_enc'], 'templates.name'),
                'shortcut' => (string) ($c->decrypt($r['shortcut_enc'], 'templates.shortcut') ?? ''),
                'subject' => (string) ($c->decrypt($r['subject_enc'], 'templates.subject') ?? ''),
                'html' => (string) $c->decrypt($r['body_enc'], 'templates.body'), 'updated_at' => gmdate('c', strtotime($r['updated_at'] . ' UTC'))];
        }
        usort($out, fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));
        return $out;
    }

    public function save(int $owner, array $in, ?int $id = null): array
    {
        $line = fn ($v, $max) => mb_substr(trim(preg_replace('/\s+/u', ' ', preg_replace('/[^\P{C}]/u', '', (string) $v) ?? '') ?? ''), 0, $max);
        $name = $line($in['name'] ?? '', 80);
        if ($name === '') {
            throw new HttpError(422, 'Give the template a name', 'bad_template');
        }
        $shortcut = mb_strtolower(ltrim($line($in['shortcut'] ?? '', 32), '/'));
        if ($shortcut !== '' && !preg_match('/^[\p{L}\p{N}_-]+$/u', $shortcut)) {
            throw new HttpError(422, 'Shortcuts are letters, numbers, - and _ (no spaces)', 'bad_template');
        }
        $html = self::sanitize((string) ($in['html'] ?? ''));
        if (trim(strip_tags($html)) === '') {
            throw new HttpError(422, 'Write the template first', 'bad_template');
        }
        if (strlen($html) > self::MAX_BODY) {
            throw new HttpError(422, 'Templates are at most 50 KB', 'bad_template');
        }
        $existing = $this->list($owner);
        if ($shortcut !== '') {
            foreach ($existing as $t) {
                if ($t['shortcut'] === $shortcut && $t['id'] !== $id) {
                    throw new HttpError(409, "/$shortcut is already the shortcut for {$t['name']}", 'duplicate');
                }
            }
        }
        $c = $this->c();
        $fields = [$c->encrypt($name, 'templates.name'), $c->encrypt($shortcut === '' ? null : $shortcut, 'templates.shortcut'),
            $c->encrypt(($s = $line($in['subject'] ?? '', 200)) === '' ? null : $s, 'templates.subject'), $c->encrypt($html, 'templates.body')];
        if ($id) {
            $n = $this->app->db->run('UPDATE {templates} SET name_enc = ?, shortcut_enc = ?, subject_enc = ?, body_enc = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
                array_merge($fields, [App::now(), $id, $owner]))->rowCount();
            if (!$n && !$this->app->db->value('SELECT id FROM {templates} WHERE id = ? AND owner_id = ?', [$id, $owner])) {
                throw new HttpError(404, 'Template not found', 'not_found');
            }
        } else {
            if (count($existing) >= self::MAX_TEMPLATES) {
                throw new HttpError(422, 'At most ' . self::MAX_TEMPLATES . ' templates', 'too_many_templates');
            }
            $id = $this->app->db->insert('INSERT INTO {templates} (owner_id, name_enc, shortcut_enc, subject_enc, body_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                array_merge([$owner], $fields, [App::now(), App::now()]));
        }
        foreach ($this->list($owner) as $t) {
            if ($t['id'] === $id) {
                return $t;
            }
        }
        throw new HttpError(500, 'The template was not saved', 'server_error');
    }

    public function delete(int $owner, int $id): void
    {
        if (!$this->app->db->run('DELETE FROM {templates} WHERE id = ? AND owner_id = ?', [$id, $owner])->rowCount()) {
            throw new HttpError(404, 'Template not found', 'not_found');
        }
    }

    /**
     * Keep simple formatting only: paragraphs, line breaks, bold, italic, underline, lists, quotes, headings and links
     * (http, https and mailto). Anything else is unwrapped to its text; scripts, styles and embedded things go entirely.
     */
    public static function sanitize(string $html): string
    {
        if (trim($html) === '') {
            return '';
        }
        $doc = new \DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="utf-8"?><html><body><div id="t">' . $html . '</div></body></html>', LIBXML_NONET);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        $root = $doc->getElementById('t');
        if (!$root) {
            return '';
        }
        self::clean($root);
        $out = '';
        foreach ($root->childNodes as $child) {
            $out .= $doc->saveHTML($child);
        }
        return trim($out);
    }

    private static function clean(\DOMNode $node): void
    {
        foreach (iterator_to_array($node->childNodes) as $child) {
            if ($child instanceof \DOMElement) {
                $tag = strtolower($child->tagName);
                if (in_array($tag, self::DROP, true)) {
                    $node->removeChild($child);
                    continue;
                }
                self::clean($child);
                if (!in_array($tag, self::TAGS, true)) {
                    while ($child->firstChild) {
                        $node->insertBefore($child->firstChild, $child);
                    }
                    $node->removeChild($child);
                    continue;
                }
                $href = $tag === 'a' ? trim($child->getAttribute('href')) : '';
                foreach (iterator_to_array($child->attributes) as $attr) {
                    $child->removeAttribute($attr->name);
                }
                if ($tag === 'a') {
                    if (preg_match('#^(https?://|mailto:)#i', $href)) {
                        $child->setAttribute('href', $href);
                    }
                }
            } elseif ($child instanceof \DOMComment || $child instanceof \DOMProcessingInstruction) {
                $node->removeChild($child);
            }
        }
    }
}
