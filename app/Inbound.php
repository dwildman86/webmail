<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Receiving GhostParse's webhooks: checks the signature, takes each event once, and stores email.received in the
 * right mailboxes. Works whichever way the account sends attachments: in the JSON, as multipart files (each checked
 * against the SHA-256 in the signed event), or as links to its bucket.
 */
final class Inbound
{
    /** @var callable[] called with (array $stored, array $data) after new mail is stored: for notifications */
    public array $onNewMail = [];

    public function __construct(private App $app)
    {
    }

    /**
     * Handle one webhook request. $body is the raw body (JSON mode) or the "event" form field (multipart mode),
     * $files the uploaded parts by name ([name => tmp path]). Returns [status, response array].
     */
    public function handle(string $body, array $headers, array $files = []): array
    {
        try {
            $event = GhostParse::verify($body, $headers, $this->app->webhookSecrets());
        } catch (\RuntimeException $e) {
            // 400: refused for good. Only a forged or broken request gets this.
            return [400, ['error' => 'invalid_signature', 'message' => $e->getMessage()]];
        }
        $id = (string) ($event['id'] ?? '');
        $type = (string) ($event['type'] ?? '');
        if ($type === 'webhook.test') {
            return [200, ['ok' => true, 'test' => true]];
        }
        if ($type !== 'email.received') {
            return [200, ['ok' => true, 'ignored' => $type]];
        }
        $data = $event['data'] ?? [];
        foreach ($data['attachments'] ?? [] as $i => $a) {
            if (!empty($a['part'])) {
                $path = $files[$a['part']] ?? null;
                $bytes = $path ? file_get_contents($path) : false;
                if ($bytes === false || (!empty($a['sha256']) && !hash_equals($a['sha256'], hash('sha256', $bytes)))) {
                    return [400, ['error' => 'attachment_mismatch', 'message' => "Attachment {$a['part']} is missing or doesn't match the signed event"]];
                }
                $data['attachments'][$i]['content'] = base64_encode($bytes);
            }
        }
        $db = $this->app->db;
        if ($id !== '' && $db->value('SELECT id FROM {events} WHERE id = ?', [$id])) {
            return [200, ['ok' => true, 'duplicate' => true]];
        }
        $stored = (new Mailstore($this->app))->storeInbound($data);
        if ($id !== '') {
            $db->run('INSERT IGNORE INTO {events} (id, received_at) VALUES (?, ?)', [$id, App::now()]);
        }
        foreach ($this->onNewMail as $fn) {
            try {
                $fn($stored, $data);
            } catch (\Throwable $e) {
                error_log('webmail: notification failed: ' . $e->getMessage()); // never lose the email over a notification
            }
        }
        return [200, ['ok' => true, 'stored' => count($stored)]];
    }

    /** The request's headers, on Apache, nginx/FPM and LiteSpeed alike. */
    public static function requestHeaders(): array
    {
        if (function_exists('getallheaders')) {
            $h = getallheaders();
            if (is_array($h) && $h) {
                return $h;
            }
        }
        $out = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $out[str_replace('_', '-', strtolower(substr($k, 5)))] = $v;
            }
        }
        return $out;
    }
}
