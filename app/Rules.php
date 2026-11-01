<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Labels and rules.
 *
 * A label is a mailbox's own folder or tag ("Accounting", "Billing"). An email can have any number of them. Moving an
 * email to a label labels it and takes it out of the Inbox (to Archive), so the label shows it like a folder; tagging
 * labels it and leaves it where it is.
 *
 * A rule files new email as it arrives: "If the sender ends with @example.com or the subject contains Invoice, move it
 * to Accounting and tag it Billing". Each mailbox has its own rules (in a shared mailbox, everyone on it shares them);
 * they run in order on email that arrives in the Inbox (not Spam), and can also be run on what's in the Inbox now.
 * Every rule that matches adds its tags (and marks read, stars); the first one that moves the email decides where it goes.
 * Names and rules are encrypted like the mail.
 */
final class Rules
{
    public const FIELDS = ['from' => 'Sender', 'to' => 'Recipients (To, Cc)', 'subject' => 'Subject', 'body' => 'Message text'];
    public const OPS = ['contains' => 'contains', 'not_contains' => "doesn't contain", 'is' => 'is', 'starts_with' => 'starts with', 'ends_with' => 'ends with'];
    public const MOVES = ['', 'archive', 'spam', 'trash', 'label'];
    public const MAX_CONDITIONS = 10;
    public const MAX_RULES = 100;
    public const MAX_LABELS = 200;
    /** "Apply to the Inbox now" looks at this many of the newest emails. */
    public const RUN_NOW_LIMIT = 5000;

    public function __construct(private App $app)
    {
    }

    private function c(): Crypto
    {
        return $this->app->crypto;
    }

    private function mailbox(array $user, int $mailboxId): array
    {
        return (new Mailstore($this->app))->mailbox($user['id'], $mailboxId);
    }

    public function route(string $action, string $method, array $user): never
    {
        $in = $method === 'GET' ? [] : Http::body();
        $id = fn (string $k) => (int) ($method === 'GET' ? ($_GET[$k] ?? 0) : ($in[$k] ?? 0));
        switch ("$method $action") {
            case 'GET rules':
                $this->mailbox($user, $id('mailbox'));
                Http::json(['rules' => $this->rules($id('mailbox')), 'labels' => $this->labels($id('mailbox')),
                    'fields' => self::FIELDS, 'ops' => self::OPS]);
            case 'POST rules/save':
                Http::json($this->saveRule($user, $id('mailbox_id'), $in, isset($in['id']) ? (int) $in['id'] : null));
            case 'POST rules/enable':
                $rule = $this->ruleFor($user, $id('id'));
                $this->app->db->run('UPDATE {rules} SET enabled = ?, updated_at = ? WHERE id = ?', [!empty($in['enabled']) ? 1 : 0, App::now(), $rule['id']]);
                Http::json(['ok' => true]);
            case 'POST rules/delete':
                $rule = $this->ruleFor($user, $id('id'));
                $this->app->db->run('DELETE FROM {rules} WHERE id = ?', [$rule['id']]);
                Http::json(['ok' => true]);
            case 'POST rules/order':
                $this->order($user, $id('mailbox_id'), (array) ($in['ids'] ?? []));
                Http::json(['ok' => true]);
            case 'POST rules/run':
                $rule = $this->ruleFor($user, $id('id'));
                Http::json(['applied' => $this->runNow((int) $rule['mailbox_id'], $rule)]);
            case 'POST labels/save':
                Http::json($this->saveLabel($user, $id('mailbox_id'), (string) ($in['name'] ?? ''), isset($in['id']) ? (int) $in['id'] : null));
            case 'POST labels/delete':
                $this->deleteLabel($user, $id('id'));
                Http::json(['ok' => true]);
            case 'POST labels/apply':
                Http::json(['changed' => $this->label($user, (array) ($in['ids'] ?? []), (array) ($in['add'] ?? []), (array) ($in['remove'] ?? []), !empty($in['move']))]);
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    // ---------------------------------------------------------------------------------------------- labels

    /** A mailbox's labels, by name: [{id, name}] (and how many unread, for the folder list). */
    public function labels(int $mailboxId, bool $unread = false): array
    {
        $out = [];
        $counts = [];
        if ($unread) {
            foreach ($this->app->db->all("SELECT ml.label_id, COUNT(*) AS n FROM {message_labels} ml JOIN {messages} m ON m.id = ml.message_id
                WHERE m.mailbox_id = ? AND m.is_read = 0 AND m.folder NOT IN ('trash', 'spam') AND m.snoozed_until IS NULL GROUP BY ml.label_id", [$mailboxId]) as $r) {
                $counts[(int) $r['label_id']] = (int) $r['n'];
            }
        }
        foreach ($this->app->db->all('SELECT id, name_enc FROM {labels} WHERE mailbox_id = ?', [$mailboxId]) as $r) {
            $label = ['id' => (int) $r['id'], 'name' => (string) $this->c()->decrypt($r['name_enc'], 'labels.name')];
            if ($unread) {
                $label['unread'] = $counts[(int) $r['id']] ?? 0;
            }
            $out[] = $label;
        }
        usort($out, fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));
        return $out;
    }

    /** Each message's labels: [message id => [{id, name}]]. */
    public function labelsOf(array $messageIds): array
    {
        if (!$messageIds) {
            return [];
        }
        $in = implode(', ', array_fill(0, count($messageIds), '?'));
        $out = [];
        $names = [];
        foreach ($this->app->db->all("SELECT ml.message_id, l.id, l.name_enc FROM {message_labels} ml JOIN {labels} l ON l.id = ml.label_id WHERE ml.message_id IN ($in)", array_values($messageIds)) as $r) {
            $names[(int) $r['id']] ??= (string) $this->c()->decrypt($r['name_enc'], 'labels.name');
            $out[(int) $r['message_id']][] = ['id' => (int) $r['id'], 'name' => $names[(int) $r['id']]];
        }
        foreach ($out as &$list) {
            usort($list, fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));
        }
        return $out;
    }

    private static function cleanName(string $name): string
    {
        $name = trim(preg_replace('/\s+/u', ' ', preg_replace('/[^\P{C}]/u', '', $name) ?? '') ?? '');
        if ($name === '') {
            throw new HttpError(422, 'Give the label a name', 'bad_label');
        }
        if (mb_strlen($name) > 50) {
            throw new HttpError(422, 'Label names are at most 50 characters', 'bad_label');
        }
        return $name;
    }

    private function nameIndex(string $name): string
    {
        return $this->c()->blindIndex(mb_strtolower($name), 'labels.name');
    }

    /** Make a label (or rename one). Returns {id, name}. */
    public function saveLabel(array $user, int $mailboxId, string $name, ?int $id = null): array
    {
        $name = self::cleanName($name);
        if ($id) {
            $label = $this->labelFor($user, $id);
            $mailboxId = (int) $label['mailbox_id'];
        } else {
            $this->mailbox($user, $mailboxId);
            if ((int) $this->app->db->value('SELECT COUNT(*) FROM {labels} WHERE mailbox_id = ?', [$mailboxId]) >= self::MAX_LABELS) {
                throw new HttpError(422, 'A mailbox can have at most ' . self::MAX_LABELS . ' labels', 'too_many_labels');
            }
        }
        $other = $this->app->db->value('SELECT id FROM {labels} WHERE mailbox_id = ? AND name_bidx = ?', [$mailboxId, $this->nameIndex($name)]);
        if ($other && (int) $other !== $id) {
            throw new HttpError(409, "There's a label called $name already", 'duplicate');
        }
        $enc = $this->c()->encrypt($name, 'labels.name');
        if ($id) {
            $this->app->db->run('UPDATE {labels} SET name_bidx = ?, name_enc = ? WHERE id = ?', [$this->nameIndex($name), $enc, $id]);
        } else {
            $id = $this->app->db->insert('INSERT INTO {labels} (mailbox_id, name_bidx, name_enc, created_at) VALUES (?, ?, ?, ?)',
                [$mailboxId, $this->nameIndex($name), $enc, App::now()]);
        }
        return ['id' => $id, 'name' => $name, 'mailbox_id' => $mailboxId];
    }

    /** A label on a mailbox the user can read (404 otherwise). */
    private function labelFor(array $user, int $labelId): array
    {
        $row = $this->app->db->one('SELECT l.* FROM {labels} l JOIN {user_mailboxes} um ON um.mailbox_id = l.mailbox_id WHERE um.user_id = ? AND l.id = ?', [$user['id'], $labelId]);
        return $row ?? throw new HttpError(404, 'Label not found', 'not_found');
    }

    /** Delete a label: its email stays where it is, without it, and rules stop using it. */
    public function deleteLabel(array $user, int $labelId): void
    {
        $label = $this->labelFor($user, $labelId);
        $this->app->db->tx(function (Db $db) use ($label, $labelId) {
            $db->run('DELETE FROM {labels} WHERE id = ?', [$labelId]);
            foreach ($db->all('SELECT id, rule_enc FROM {rules} WHERE mailbox_id = ?', [$label['mailbox_id']]) as $r) {
                $rule = $this->c()->decryptJson($r['rule_enc'], 'rules.rule') ?? [];
                $a = $rule['actions'] ?? [];
                $tags = array_values(array_filter(array_map('intval', $a['tags'] ?? []), fn ($t) => $t !== $labelId));
                $moveGone = ($a['move'] ?? '') === 'label' && (int) ($a['move_label'] ?? 0) === $labelId;
                if ($moveGone || $tags !== array_map('intval', $a['tags'] ?? [])) {
                    $rule['actions']['tags'] = $tags;
                    if ($moveGone) {
                        $rule['actions']['move'] = 'archive'; // still out of the Inbox, as it was meant to be
                        unset($rule['actions']['move_label']);
                    }
                    $db->run('UPDATE {rules} SET rule_enc = ?, updated_at = ? WHERE id = ?', [$this->c()->encryptJson($rule, 'rules.rule'), App::now(), $r['id']]);
                }
            }
        });
    }

    /**
     * Add and remove labels on messages (a label only goes on email in its own mailbox). $move: also take them out of
     * the Inbox (to Archive), as moving to a label does. Returns how many messages changed.
     */
    public function label(array $user, array $messageIds, array $add, array $remove, bool $move = false): int
    {
        $messageIds = array_values(array_unique(array_map('intval', $messageIds)));
        if (!$messageIds || count($messageIds) > 500) {
            throw new HttpError(422, 'Choose between 1 and 500 messages', 'bad_ids');
        }
        $in = implode(', ', array_fill(0, count($messageIds), '?'));
        $messages = $this->app->db->all("SELECT m.id, m.mailbox_id, m.folder FROM {messages} m JOIN {user_mailboxes} um ON um.mailbox_id = m.mailbox_id
            WHERE um.user_id = ? AND m.id IN ($in)", array_merge([$user['id']], $messageIds));
        $labels = [];
        foreach (array_merge($add, $remove) as $l) {
            $labels[(int) $l] ??= (int) $this->labelFor($user, (int) $l)['mailbox_id'];
        }
        $changed = 0;
        foreach ($messages as $m) {
            $did = false;
            foreach ($add as $l) {
                if ($labels[(int) $l] === (int) $m['mailbox_id']) {
                    $did = $this->app->db->run('INSERT IGNORE INTO {message_labels} (message_id, label_id) VALUES (?, ?)', [$m['id'], (int) $l])->rowCount() > 0 || $did;
                }
            }
            foreach ($remove as $l) {
                $did = $this->app->db->run('DELETE FROM {message_labels} WHERE message_id = ? AND label_id = ?', [$m['id'], (int) $l])->rowCount() > 0 || $did;
            }
            if ($move && $m['folder'] === 'inbox') {
                $this->app->db->run("UPDATE {messages} SET folder = 'archive', snoozed_until = NULL WHERE id = ?", [$m['id']]);
                $did = true;
            }
            $changed += $did ? 1 : 0;
        }
        return $changed;
    }

    // ---------------------------------------------------------------------------------------------- rules

    /** A mailbox's rules, in the order they run. */
    public function rules(int $mailboxId, bool $enabledOnly = false): array
    {
        $out = [];
        foreach ($this->app->db->all('SELECT * FROM {rules} WHERE mailbox_id = ?' . ($enabledOnly ? ' AND enabled = 1' : '') . ' ORDER BY position, id', [$mailboxId]) as $r) {
            $out[] = $this->present($r);
        }
        return $out;
    }

    private function present(array $r): array
    {
        $rule = $this->c()->decryptJson($r['rule_enc'], 'rules.rule') ?? [];
        return ['id' => (int) $r['id'], 'mailbox_id' => (int) $r['mailbox_id'], 'enabled' => (bool) $r['enabled'],
            'name' => (string) ($rule['name'] ?? ''), 'match' => ($rule['match'] ?? 'all') === 'any' ? 'any' : 'all',
            'conditions' => $rule['conditions'] ?? [], 'actions' => $rule['actions'] ?? []];
    }

    private function ruleFor(array $user, int $ruleId): array
    {
        $row = $this->app->db->one('SELECT r.* FROM {rules} r JOIN {user_mailboxes} um ON um.mailbox_id = r.mailbox_id WHERE um.user_id = ? AND r.id = ?', [$user['id'], $ruleId]);
        return $row ? $this->present($row) : throw new HttpError(404, 'Rule not found', 'not_found');
    }

    /** Check a rule from the settings: what it looks at and what it does. */
    public function clean(int $mailboxId, array $in): array
    {
        $conditions = [];
        foreach (array_slice((array) ($in['conditions'] ?? []), 0, self::MAX_CONDITIONS + 1) as $c) {
            $field = (string) ($c['field'] ?? '');
            $op = (string) ($c['op'] ?? '');
            $value = trim(preg_replace('/[^\P{C}]/u', '', (string) ($c['value'] ?? '')) ?? '');
            if (!isset(self::FIELDS[$field]) || !isset(self::OPS[$op])) {
                throw new HttpError(422, 'A condition is incomplete', 'bad_rule');
            }
            if ($value === '') {
                throw new HttpError(422, 'Fill in what each condition looks for', 'bad_rule');
            }
            $conditions[] = ['field' => $field, 'op' => $op, 'value' => mb_substr($value, 0, 200)];
        }
        if (!$conditions) {
            throw new HttpError(422, 'Add at least one condition', 'bad_rule');
        }
        if (count($conditions) > self::MAX_CONDITIONS) {
            throw new HttpError(422, 'A rule can have at most ' . self::MAX_CONDITIONS . ' conditions', 'bad_rule');
        }
        $a = (array) ($in['actions'] ?? []);
        $ours = array_column($this->labels($mailboxId), 'name', 'id');
        $move = (string) ($a['move'] ?? '');
        if (!in_array($move, self::MOVES, true)) {
            throw new HttpError(422, 'Choose where the email goes', 'bad_rule');
        }
        $actions = ['move' => $move];
        if ($move === 'label') {
            $label = (int) ($a['move_label'] ?? 0);
            if (!isset($ours[$label])) {
                throw new HttpError(422, 'Choose the label to move it to', 'bad_rule');
            }
            $actions['move_label'] = $label;
        }
        $tags = array_values(array_unique(array_map('intval', (array) ($a['tags'] ?? []))));
        foreach ($tags as $t) {
            if (!isset($ours[$t])) {
                throw new HttpError(422, 'A label to tag it with has gone: choose again', 'bad_rule');
            }
        }
        $actions['tags'] = $tags;
        $actions['read'] = !empty($a['read']);
        $actions['star'] = !empty($a['star']);
        if ($move === '' && !$tags && !$actions['read'] && !$actions['star']) {
            throw new HttpError(422, 'Choose what the rule does', 'bad_rule');
        }
        $name = trim(preg_replace('/[^\P{C}]/u', '', (string) ($in['name'] ?? '')) ?? '');
        return ['name' => mb_substr($name, 0, 80), 'match' => ($in['match'] ?? 'all') === 'any' ? 'any' : 'all', 'conditions' => $conditions, 'actions' => $actions];
    }

    /** Save a rule (new ones go last). With apply_now, also run it on the Inbox. Returns the rule (and how many it filed). */
    public function saveRule(array $user, int $mailboxId, array $in, ?int $id = null): array
    {
        if ($id) {
            $mailboxId = $this->ruleFor($user, $id)['mailbox_id'];
        } else {
            $this->mailbox($user, $mailboxId);
        }
        $rule = $this->clean($mailboxId, $in);
        $enc = $this->c()->encryptJson($rule, 'rules.rule');
        $enabled = !array_key_exists('enabled', $in) || !empty($in['enabled']) ? 1 : 0;
        if ($id) {
            $this->app->db->run('UPDATE {rules} SET rule_enc = ?, enabled = ?, updated_at = ? WHERE id = ?', [$enc, $enabled, App::now(), $id]);
        } else {
            if ((int) $this->app->db->value('SELECT COUNT(*) FROM {rules} WHERE mailbox_id = ?', [$mailboxId]) >= self::MAX_RULES) {
                throw new HttpError(422, 'A mailbox can have at most ' . self::MAX_RULES . ' rules', 'too_many_rules');
            }
            $position = (int) $this->app->db->value('SELECT COALESCE(MAX(position), 0) + 1 FROM {rules} WHERE mailbox_id = ?', [$mailboxId]);
            $id = $this->app->db->insert('INSERT INTO {rules} (mailbox_id, position, enabled, rule_enc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$mailboxId, $position, $enabled, $enc, $user['id'], App::now(), App::now()]);
        }
        $saved = $this->ruleFor($user, $id);
        return $saved + (!empty($in['apply_now']) ? ['applied' => $this->runNow($mailboxId, $saved)] : []);
    }

    /** Put a mailbox's rules in this order (the ones not listed keep their place after them). */
    public function order(array $user, int $mailboxId, array $ids): void
    {
        $this->mailbox($user, $mailboxId);
        $position = 1;
        foreach (array_map('intval', $ids) as $id) {
            $this->app->db->run('UPDATE {rules} SET position = ? WHERE id = ? AND mailbox_id = ?', [$position++, $id, $mailboxId]);
        }
    }

    /** Whether an email (as GhostParse delivers it, or as stored) matches a rule's conditions. */
    public static function matches(array $rule, array $email): bool
    {
        $lower = fn ($s) => mb_strtolower(trim((string) $s));
        $people = function ($list) use ($lower): array {
            $out = [];
            foreach ($list as $p) {
                if (is_array($p)) {
                    foreach ([$p['address'] ?? '', $p['name'] ?? ''] as $v) {
                        if ($lower($v) !== '') {
                            $out[] = $lower($v);
                        }
                    }
                }
            }
            return $out;
        };
        $values = [
            'from' => $people([$email['from'] ?? null]),
            'to' => $people(array_merge($email['to'] ?? [], $email['cc'] ?? [])),
            'subject' => [$lower($email['subject'] ?? '')],
            'body' => [$lower(($email['text'] ?? '') !== '' ? $email['text'] : strip_tags((string) ($email['html'] ?? '')))],
        ];
        $results = [];
        foreach ($rule['conditions'] ?? [] as $c) {
            $want = $lower($c['value'] ?? '');
            $have = $values[$c['field'] ?? ''] ?? [];
            $test = match ($c['op'] ?? '') {
                'contains', 'not_contains' => fn ($v) => $want !== '' && str_contains($v, $want),
                'is' => fn ($v) => $v === $want,
                'starts_with' => fn ($v) => $want !== '' && str_starts_with($v, $want),
                'ends_with' => fn ($v) => $want !== '' && str_ends_with($v, $want),
                default => fn ($v) => false,
            };
            $any = false;
            foreach ($have as $v) {
                if ($test($v)) {
                    $any = true;
                    break;
                }
            }
            $results[] = ($c['op'] ?? '') === 'not_contains' ? !$any : $any;
        }
        if (!$results) {
            return false;
        }
        return ($rule['match'] ?? 'all') === 'any' ? in_array(true, $results, true) : !in_array(false, $results, true);
    }

    /** Run a mailbox's rules on an email that has just arrived in its Inbox. Returns what was done. */
    public function apply(int $mailboxId, int $messageId, array $email): array
    {
        $matched = array_values(array_filter($this->rules($mailboxId, true), fn ($r) => self::matches($r, $email)));
        if (!$matched) {
            return [];
        }
        return $this->act($mailboxId, [$messageId], $matched);
    }

    /** Do what the matching rules say to some messages (all in one mailbox). */
    private function act(int $mailboxId, array $messageIds, array $rules): array
    {
        $ours = array_column($this->labels($mailboxId), 'name', 'id');
        $tags = [];
        $move = null;
        $read = $star = false;
        foreach ($rules as $r) {
            $a = $r['actions'];
            foreach ($a['tags'] ?? [] as $t) {
                if (isset($ours[(int) $t])) {
                    $tags[(int) $t] = true;
                }
            }
            if ($move === null && ($a['move'] ?? '') !== '') {
                if ($a['move'] === 'label') {
                    if (isset($ours[(int) ($a['move_label'] ?? 0)])) {
                        $move = 'archive';
                        $tags[(int) $a['move_label']] = true;
                    }
                } else {
                    $move = $a['move'];
                }
            }
            $read = $read || !empty($a['read']);
            $star = $star || !empty($a['star']);
        }
        $db = $this->app->db;
        foreach ($messageIds as $id) {
            foreach (array_keys($tags) as $t) {
                $db->run('INSERT IGNORE INTO {message_labels} (message_id, label_id) VALUES (?, ?)', [$id, $t]);
            }
            $set = [];
            $params = [];
            if ($move !== null) {
                $set[] = 'folder = ?';
                $params[] = $move;
            }
            if ($read) {
                $set[] = 'is_read = 1';
            }
            if ($star) {
                $set[] = 'is_starred = 1';
            }
            if ($set) {
                $db->run('UPDATE {messages} SET ' . implode(', ', $set) . ' WHERE id = ? AND mailbox_id = ?', array_merge($params, [$id, $mailboxId]));
            }
        }
        return ['labels' => array_keys($tags), 'folder' => $move, 'read' => $read, 'star' => $star];
    }

    /** Run one rule on the email in a mailbox's Inbox now (the newest RUN_NOW_LIMIT). Returns how many it matched. */
    public function runNow(int $mailboxId, array $rule): int
    {
        $c = $this->c();
        $matched = [];
        $rows = $this->app->db->all("SELECT id, from_enc, to_enc, subject_enc, body_enc FROM {messages} WHERE mailbox_id = ? AND folder = 'inbox' AND snoozed_until IS NULL
            ORDER BY sort_at DESC LIMIT " . self::RUN_NOW_LIMIT, [$mailboxId]);
        foreach ($rows as $r) {
            $to = $c->decryptJson($r['to_enc'], 'messages.to') ?? [];
            $body = $c->decryptJson($r['body_enc'], 'messages.body') ?? [];
            $email = ['from' => $c->decryptJson($r['from_enc'], 'messages.from'), 'to' => $to['to'] ?? [], 'cc' => $to['cc'] ?? [],
                'subject' => $c->decrypt($r['subject_enc'], 'messages.subject'), 'text' => $body['text'] ?? '', 'html' => $body['html'] ?? null];
            if (self::matches($rule, $email)) {
                $matched[] = (int) $r['id'];
            }
        }
        if ($matched) {
            $this->act($mailboxId, $matched, [$rule]);
        }
        return count($matched);
    }
}
