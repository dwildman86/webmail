<?php
declare(strict_types=1);

namespace Webmail;

/**
 * The GhostParse API (sending, the account's domains and addresses) and webhook verification. Plain cURL, so it runs
 * on any shared host with no Composer packages.
 */
final class GhostParse
{
    public function __construct(private string $apiUrl, private string $apiKey, private ?\Closure $transport = null)
    {
        $this->apiUrl = rtrim($apiUrl, '/');
    }

    /** @return array decoded JSON */
    public function request(string $method, string $path, ?array $body = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->apiKey, 'Accept: application/json', 'User-Agent: ghostparse-webmail/' . App::VERSION];
        $payload = null;
        if ($body !== null) {
            $payload = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            $headers[] = 'Content-Type: application/json';
        }
        if ($this->transport) {
            [$status, $text] = ($this->transport)($method, $this->apiUrl . $path, $headers, $payload);
        } else {
            $ch = curl_init($this->apiUrl . $path);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT => 60,
                CURLOPT_FOLLOWLOCATION => false,
            ]);
            if ($payload !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            }
            $text = curl_exec($ch);
            if ($text === false) {
                $err = curl_error($ch);
                curl_close($ch);
                throw new GhostParseError("Couldn't reach GhostParse at {$this->apiUrl}: $err");
            }
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            curl_close($ch);
        }
        $json = $text === '' ? [] : json_decode((string) $text, true);
        if ($status === 204) {
            return [];
        }
        if (!is_array($json)) {
            throw new GhostParseError("GhostParse answered $status with something that isn't JSON", $status);
        }
        if ($status >= 400) {
            $message = $json['message'] ?? $json['error'] ?? "Error $status";
            if (!empty($json['issues'][0]['message'])) {
                $message .= ': ' . $json['issues'][0]['message'];
            }
            throw new GhostParseError((string) $message, $status, is_string($json['error'] ?? null) ? $json['error'] : null);
        }
        return $json;
    }

    public function me(): array
    {
        return $this->request('GET', '/v1/me');
    }

    public function domains(): array
    {
        return $this->request('GET', '/v1/domains')['domains'] ?? [];
    }

    public function updateAddress(string $domainId, string $addressId, array $fields): array
    {
        return $this->request('PATCH', '/v1/domains/' . rawurlencode($domainId) . '/addresses/' . rawurlencode($addressId), $fields);
    }

    /** POST /v1/emails: returns id, message_id, thread_id, accepted, suppressed. */
    public function send(array $email): array
    {
        return $this->request('POST', '/v1/emails', $email);
    }

    /**
     * Check a webhook's Standard Webhooks signature against any of the secrets (the current one, and the previous one
     * while you rotate), and that it's fresh. Returns the decoded event; throws if it isn't genuine.
     */
    public static function verify(string $body, array $headers, array $secrets, int $toleranceSeconds = 300, ?int $now = null): array
    {
        $h = array_change_key_case($headers, CASE_LOWER);
        $id = (string) ($h['webhook-id'] ?? '');
        $ts = (string) ($h['webhook-timestamp'] ?? '');
        $sigs = (string) ($h['webhook-signature'] ?? '');
        if ($id === '' || !ctype_digit($ts) || $sigs === '') {
            throw new \RuntimeException('Missing webhook signature headers');
        }
        if (abs(($now ?? time()) - (int) $ts) > $toleranceSeconds) {
            throw new \RuntimeException('Webhook timestamp too old or in the future');
        }
        foreach (array_filter($secrets) as $secret) {
            $key = base64_decode(preg_replace('/^whsec_/', '', $secret), true);
            if ($key === false) {
                continue;
            }
            $expected = base64_encode(hash_hmac('sha256', "$id.$ts.$body", $key, true));
            foreach (explode(' ', $sigs) as $sig) {
                $parts = explode(',', $sig, 2);
                if (hash_equals($expected, end($parts))) {
                    $event = json_decode($body, true);
                    if (!is_array($event)) {
                        throw new \RuntimeException('The webhook body is not JSON');
                    }
                    return $event;
                }
            }
        }
        throw new \RuntimeException('Invalid webhook signature');
    }
}
