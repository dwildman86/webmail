<?php
declare(strict_types=1);

namespace Webmail;

/**
 * An S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO… Written for this
 * webmail with cURL and AWS Signature Version 4, so no SDK or Composer package is needed. Only what Files uses:
 * multipart uploads, ranged reads, HEAD and DELETE. Objects are ciphertext under random names (FileCrypto).
 */
final class S3Store implements FileStore
{
    private string $endpoint;

    /** @var callable(string $method, string $url, array $headers, string $body): array{0: int, 1: array, 2: string} */
    private $send;

    /**
     * @param array{endpoint: string, region: string, bucket: string, access_key: string, secret_key: string, path_style?: bool} $c
     * @param callable|null $send Tests replace the HTTP call: fn($method, $url, $headers, $body) => [status, headers, body]
     */
    public function __construct(private array $c, ?callable $send = null)
    {
        $endpoint = rtrim(trim($c['endpoint'] ?: "https://s3.{$c['region']}.amazonaws.com"), '/');
        if (!preg_match('#^https?://[a-z0-9.\-:]+$#i', $endpoint)) {
            throw new HttpError(422, 'The S3 endpoint should look like https://s3.eu-west-2.amazonaws.com', 'bad_s3');
        }
        if (!preg_match('/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/', (string) $c['bucket'])) {
            throw new HttpError(422, "That isn't a valid bucket name", 'bad_s3');
        }
        $this->endpoint = $endpoint;
        $this->send = $send ?? [$this, 'curl'];
    }

    public function name(): string
    {
        return 's3';
    }

    public function begin(string $key): array
    {
        [, , $body] = $this->request('POST', $key, ['uploads' => '']);
        $id = self::xml($body, 'UploadId');
        if ($id === null) {
            throw new \RuntimeException("The bucket didn't start the upload");
        }
        return ['upload_id' => $id, 'parts' => []];
    }

    public function append(string $key, array $state, string $bytes, int $part): array
    {
        [, $headers] = $this->request('PUT', $key, ['partNumber' => (string) $part, 'uploadId' => $state['upload_id']], [], $bytes);
        $etag = $headers['etag'] ?? null;
        if (!$etag) {
            throw new \RuntimeException("The bucket didn't accept a part of the upload");
        }
        $state['parts'][$part] = $etag;
        return $state;
    }

    public function complete(string $key, array $state): void
    {
        ksort($state['parts']);
        $xml = '<CompleteMultipartUpload>';
        foreach ($state['parts'] as $n => $etag) {
            $xml .= '<Part><PartNumber>' . (int) $n . '</PartNumber><ETag>' . htmlspecialchars($etag, ENT_XML1) . '</ETag></Part>';
        }
        $xml .= '</CompleteMultipartUpload>';
        [, , $body] = $this->request('POST', $key, ['uploadId' => $state['upload_id']], ['content-type' => 'application/xml'], $xml);
        // S3 can answer 200 with an error inside.
        if (str_contains($body, '<Error>')) {
            throw new \RuntimeException('The bucket refused to finish the upload: ' . (self::xml($body, 'Message') ?? 'unknown error'));
        }
    }

    public function abort(string $key, array $state): void
    {
        if (!empty($state['upload_id'])) {
            try {
                $this->request('DELETE', $key, ['uploadId' => $state['upload_id']]);
            } catch (\Throwable) {
                // Already gone: nothing to tidy.
            }
        }
    }

    public function read(string $key, int $offset, int $length): string
    {
        [, , $body] = $this->request('GET', $key, [], ['range' => 'bytes=' . $offset . '-' . ($offset + $length - 1)]);
        return $body;
    }

    public function delete(string $key): void
    {
        $this->request('DELETE', $key);
    }

    public function size(string $key): ?int
    {
        try {
            [, $headers] = $this->request('HEAD', $key);
        } catch (HttpError $e) {
            if ($e->status === 404) {
                return null;
            }
            throw $e;
        }
        return isset($headers['content-length']) ? (int) $headers['content-length'] : null;
    }

    /** Settings → Files → Test connection: write, read back and delete a small object. */
    public function test(): void
    {
        $key = 'wmtest' . bin2hex(random_bytes(12));
        $state = $this->begin($key);
        $state = $this->append($key, $state, 'webmail storage test', 1);
        $this->complete($key, $state);
        if ($this->read($key, 8, 7) !== 'storage') {
            throw new HttpError(502, 'The bucket accepted a test file but gave back something else.', 's3_mismatch');
        }
        $this->delete($key);
    }

    // ------------------------------------------------------------------------------------------------ signing

    /** @return array{0: int, 1: array, 2: string} */
    private function request(string $method, string $key, array $query = [], array $headers = [], string $body = ''): array
    {
        [$url, $host, $path] = $this->locate($key);
        $now = gmdate('Ymd\THis\Z');
        $headers = array_change_key_case($headers) + ['host' => $host, 'x-amz-content-sha256' => hash('sha256', $body), 'x-amz-date' => $now];
        $headers['authorization'] = self::authorization($method, $path, $query, $headers, $headers['x-amz-content-sha256'], $now,
            $this->c['region'] ?: 'us-east-1', $this->c['access_key'], $this->c['secret_key']);
        $qs = self::canonicalQuery($query);
        [$status, $respHeaders, $respBody] = ($this->send)($method, $url . ($qs !== '' ? "?$qs" : ''), $headers, $body);
        if ($status >= 300) {
            $code = self::xml($respBody, 'Code');
            $msg = self::xml($respBody, 'Message') ?? ($status === 404 ? 'Not found' : "HTTP $status");
            throw new HttpError($status === 404 ? 404 : 502, "The S3 bucket refused: $msg" . ($code ? " ($code)" : ''), 's3_error');
        }
        return [$status, $respHeaders, $respBody];
    }

    /** The URL, Host header and canonical path for an object: path-style (endpoint/bucket/key) or virtual-hosted. */
    private function locate(string $key): array
    {
        $parts = parse_url($this->endpoint);
        $hostPort = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        $encodedKey = implode('/', array_map('rawurlencode', explode('/', $key)));
        if (!empty($this->c['path_style'])) {
            $path = '/' . rawurlencode($this->c['bucket']) . '/' . $encodedKey;
            return ["{$parts['scheme']}://$hostPort$path", $hostPort, $path];
        }
        $host = $this->c['bucket'] . '.' . $hostPort;
        return ["{$parts['scheme']}://$host/$encodedKey", $host, "/$encodedKey"];
    }

    /** The SigV4 Authorization header (public for its test against AWS's published example). */
    public static function authorization(string $method, string $path, array $query, array $headers, string $payloadHash, string $amzDate,
        string $region, string $accessKey, string $secretKey, string $service = 's3'): string
    {
        $headers = array_change_key_case($headers);
        ksort($headers);
        $signed = implode(';', array_keys($headers));
        $canonicalHeaders = '';
        foreach ($headers as $k => $v) {
            $canonicalHeaders .= $k . ':' . trim(preg_replace('/\s+/', ' ', (string) $v)) . "\n";
        }
        $canonical = implode("\n", [$method, $path, self::canonicalQuery($query), $canonicalHeaders, $signed, $payloadHash]);
        $date = substr($amzDate, 0, 8);
        $scope = "$date/$region/$service/aws4_request";
        $toSign = implode("\n", ['AWS4-HMAC-SHA256', $amzDate, $scope, hash('sha256', $canonical)]);
        $k = hash_hmac('sha256', $date, 'AWS4' . $secretKey, true);
        $k = hash_hmac('sha256', $region, $k, true);
        $k = hash_hmac('sha256', $service, $k, true);
        $k = hash_hmac('sha256', 'aws4_request', $k, true);
        return "AWS4-HMAC-SHA256 Credential=$accessKey/$scope, SignedHeaders=$signed, Signature=" . hash_hmac('sha256', $toSign, $k);
    }

    private static function canonicalQuery(array $query): string
    {
        ksort($query);
        $out = [];
        foreach ($query as $k => $v) {
            $out[] = rawurlencode((string) $k) . '=' . rawurlencode((string) $v);
        }
        return implode('&', $out);
    }

    private static function xml(string $body, string $tag): ?string
    {
        return preg_match("#<$tag>(.*?)</$tag>#s", $body, $m) ? html_entity_decode($m[1], ENT_XML1) : null;
    }

    /** @return array{0: int, 1: array, 2: string} */
    private function curl(string $method, string $url, array $headers, string $body): array
    {
        $ch = curl_init($url);
        $respHeaders = [];
        $lines = [];
        foreach ($headers as $k => $v) {
            if ($k !== 'host') {
                $lines[] = "$k: $v";
            }
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $lines, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 120,
            CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_NOBODY => $method === 'HEAD',
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders) {
                if (str_contains($line, ':')) {
                    [$k, $v] = explode(':', $line, 2);
                    $respHeaders[strtolower(trim($k))] = trim($v);
                }
                return strlen($line);
            },
        ]);
        if ($body !== '' || in_array($method, ['PUT', 'POST'], true)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $resp = curl_exec($ch);
        if ($resp === false) {
            $err = curl_error($ch);
            throw new HttpError(502, "Couldn't reach the S3 bucket: $err", 's3_unreachable');
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        return [$status, $respHeaders, (string) $resp];
    }
}
