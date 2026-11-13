<?php
declare(strict_types=1);

namespace Webmail;

/**
 * The webmail's own firewall, for hosting without one (no ModSecurity, no Cloudflare): it looks at each request before
 * the webmail does anything with it.
 *
 * - What it checks: the request's shape (method, action name, sizes, odd bytes), its query string and headers for
 *   attacks (SQL injection, scripts, path traversal, commands, Log4Shell, Shellshock, PHP objects), known attack tools,
 *   requests from other sites, and how fast an address is asking. Never the email people write or receive: an email
 *   about code can say <script> or UNION SELECT, and must still be sent.
 * - What it does: a request that's plainly an attack is refused; each finding adds to the address's score, and an
 *   address that scores 15 in an hour is blocked for 15 minutes, then an hour, then a day if it comes back.
 * - Never blocked: addresses on its allow list, the trusted networks (Settings → Security), and anywhere an
 *   administrator is signed in.
 * - Behind Cloudflare or another proxy, it reads the visitor's real address from the proxy's header (Settings →
 *   Firewall): otherwise everyone would share the proxy's address.
 *
 * Monitor mode logs what it would do without doing it. Settings → Firewall shows what it's seen.
 */
final class Waf
{
    public const MODES = ['off', 'monitor', 'block'];
    public const PROXIES = ['direct', 'cloudflare', 'custom'];
    /** A score that blocks, within this many seconds. */
    public const THRESHOLD = 15;
    public const WINDOW = 3600;
    /** How long a block lasts: the first, the second within a week, then each after. */
    public const BLOCK_STEPS = [900, 3600, 86400];
    /** Requests a minute from one address: everything, and without a session (not signed in). */
    public const LIMITS = ['normal' => ['all' => 300, 'anon' => 60], 'strict' => ['all' => 150, 'anon' => 25]];
    /** Cloudflare's addresses (cloudflare.com/ips). */
    public const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
        '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
        '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
    /** share: an hourly summary of attacks (address, kind, how many, when) goes to GhostParse's operators. */
    private const DEFAULTS = ['mode' => 'block', 'sensitivity' => 'normal', 'allow' => [], 'deny' => [], 'proxy' => 'direct', 'proxy_ranges' => [], 'share' => true];
    /** Not reported: the administrators' own block list, and forms that simply expired. */
    private const NOT_SHARED = ['deny_list', 'failed_csrf'];
    /** Events summarised in one report, at most. */
    private const SHARE_BATCH = 5000;
    /** Query parameters people type freely into (a search): not checked for attacks. */
    private const FREE_TEXT = ['q'];

    /** The time (replaced in tests). */
    public ?\Closure $clock = null;
    private static ?array $cached = null;
    private static ?string $clientIp = null;

    public function __construct(private App $app)
    {
    }

    private function now(): int
    {
        return $this->clock ? ($this->clock)() : time();
    }

    private function at(int $t): string
    {
        return gmdate('Y-m-d H:i:s', $t);
    }

    // ------------------------------------------------------------------------------------------------ settings

    public function settings(): array
    {
        if (self::$cached !== null) {
            return self::$cached;
        }
        $raw = $this->app->db->value("SELECT v FROM {meta} WHERE k = 'waf'");
        $s = ($raw ? (json_decode((string) $raw, true) ?: []) : []) + self::DEFAULTS;
        return self::$cached = array_intersect_key($s, self::DEFAULTS);
    }

    /** For tests and after saving: settings are read again. */
    public static function forget(): void
    {
        self::$cached = null;
        self::$clientIp = null;
    }

    public function save(array $in, string $ip): array
    {
        $s = $this->settings();
        if (isset($in['mode'])) {
            $s['mode'] = in_array($in['mode'], self::MODES, true) ? $in['mode'] : throw new HttpError(422, 'Choose off, monitor or block', 'bad_settings');
        }
        if (isset($in['sensitivity'])) {
            $s['sensitivity'] = isset(self::LIMITS[$in['sensitivity']]) ? $in['sensitivity'] : throw new HttpError(422, 'Choose normal or strict', 'bad_settings');
        }
        if (isset($in['proxy'])) {
            $s['proxy'] = in_array($in['proxy'], self::PROXIES, true) ? $in['proxy'] : throw new HttpError(422, 'Choose direct, Cloudflare or another proxy', 'bad_settings');
        }
        if (array_key_exists('share', $in)) {
            $s['share'] = (bool) $in['share'];
        }
        foreach (['allow', 'deny', 'proxy_ranges'] as $k) {
            if (array_key_exists($k, $in)) {
                $s[$k] = Security::ranges($in[$k]);
            }
        }
        if ($s['proxy'] === 'custom' && !$s['proxy_ranges']) {
            throw new HttpError(422, "Give the proxy's addresses, so its header is only believed when it comes from them", 'bad_settings');
        }
        if ($s['deny'] && Security::inRanges($ip, $s['deny'])) {
            throw new HttpError(422, "Your address now ($ip) is in the block list: you'd block yourself", 'locks_you_out');
        }
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('waf', ?)", [json_encode($s)]);
        self::forget();
        return $this->settings();
    }

    // ------------------------------------------------------------------------------------------------ the visitor's address

    /** The visitor's address: REMOTE_ADDR, or behind a proxy we trust, the address it says it's passing on. */
    public static function clientIp(): string
    {
        $key = ($_SERVER['REMOTE_ADDR'] ?? '') . '|' . ($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '') . '|' . ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        if (self::$clientIp !== null && str_starts_with(self::$clientIp, "$key#")) {
            return substr(self::$clientIp, strlen($key) + 1);
        }
        $settings = self::DEFAULTS;
        try {
            if (Config::installed() || App::has()) {
                $settings = (new self(App::get()))->settings();
            }
        } catch (\Throwable) {
            // The database isn't reachable: the connection's own address.
        }
        $ip = self::resolveIp($_SERVER, $settings);
        self::$clientIp = "$key#$ip";
        return $ip;
    }

    public static function resolveIp(array $server, array $settings): string
    {
        $remote = (string) ($server['REMOTE_ADDR'] ?? '0.0.0.0');
        $proxy = $settings['proxy'] ?? 'direct';
        if ($proxy === 'direct') {
            return $remote;
        }
        $trusted = $proxy === 'cloudflare' ? self::CLOUDFLARE : (array) ($settings['proxy_ranges'] ?? []);
        if (!Security::inRanges($remote, $trusted)) {
            return $remote; // not through the proxy: its headers could be made up by anyone
        }
        if ($proxy === 'cloudflare') {
            $cf = trim((string) ($server['HTTP_CF_CONNECTING_IP'] ?? ''));
            return filter_var($cf, FILTER_VALIDATE_IP) ? $cf : $remote;
        }
        // X-Forwarded-For: the last address that isn't one of the proxy's own (the ones before it can be made up).
        $hops = array_reverse(array_map('trim', explode(',', (string) ($server['HTTP_X_FORWARDED_FOR'] ?? ''))));
        foreach ($hops as $hop) {
            if (filter_var($hop, FILTER_VALIDATE_IP) && !Security::inRanges($hop, $trusted)) {
                return $hop;
            }
        }
        return $remote;
    }

    // ------------------------------------------------------------------------------------------------ the checks

    /**
     * What's wrong with a request: [['rule' => …, 'score' => n, 'detail' => …, 'refuse' => http status or 0]].
     * $r: method, endpoint (api|page|feed), action, query (array), headers (lower-case name => value), path_info,
     * uri, body (fields from a sign-in, checked like the query), origin (the webmail's own, scheme://host[:port]).
     */
    public static function inspect(array $r): array
    {
        $found = [];
        $add = function (string $rule, int $score, string $detail, int $refuse = 0) use (&$found) {
            foreach ($found as $f) {
                if ($f['rule'] === $rule) {
                    return; // once per rule per request
                }
            }
            $found[] = ['rule' => $rule, 'score' => $score, 'detail' => mb_substr($detail, 0, 300), 'refuse' => $refuse];
        };
        $method = strtoupper((string) ($r['method'] ?? 'GET'));
        $endpoint = (string) ($r['endpoint'] ?? 'api');
        $headers = (array) ($r['headers'] ?? []);
        $allowed = in_array($endpoint, ['api', 'share'], true) ? ['GET', 'POST', 'HEAD'] : ['GET', 'HEAD'];
        if (!in_array($method, $allowed, true)) {
            $add('method', 2, $method, 405);
        }
        if (strlen((string) ($r['uri'] ?? '')) > 4096) {
            $add('oversize', 3, 'Address of ' . strlen((string) $r['uri']) . ' characters', 414);
        }
        foreach ($headers as $name => $value) {
            if (strlen((string) $value) > 8192) {
                $add('oversize', 3, "Header $name of " . strlen((string) $value) . ' bytes', 431);
            }
        }
        if (count((array) ($r['query'] ?? [])) > 60) {
            $add('oversize', 3, count($r['query']) . ' query parameters', 400);
        }
        if (($r['path_info'] ?? '') !== '') {
            $add('path_probe', 3, 'Extra path ' . $r['path_info'], 404);
        }
        $action = (string) ($r['action'] ?? '');
        if ($endpoint === 'api' && $action !== '' && !preg_match('#^[a-z0-9][a-z0-9/_-]{0,63}$#', $action)) {
            $add('bad_action', 5, "Action $action", 400);
        }

        // Known attack tools say who they are.
        $ua = (string) ($headers['user-agent'] ?? '');
        if (preg_match('/\b(sqlmap|nikto|nuclei|acunetix|netsparker|wpscan|masscan|zgrab|nmap|dirbuster|gobuster|ffuf|feroxbuster|wfuzz|hydra|jaeles|arachni|openvas|nessus|w3af|commix|xsstrike|whatweb|interactsh|zmeu|morfeus|fimap|havij|appscan|skipfish|dirsearch|joomscan|cmsmap)\b/i', $ua, $m)) {
            $add('scanner', 10, "Attack tool: $m[1]", 403);
        } elseif ($ua === '' && $endpoint !== 'feed' && !str_starts_with($action, 'data-requests')) {
            $add('no_agent', 1, 'No User-Agent');
        }

        // Every header: Log4Shell and Shellshock look the same wherever they're put.
        foreach ($headers as $name => $value) {
            $v = (string) $value;
            if (preg_match('/\$\{(?:[^}]*\$\{)*[^}]*(?:jndi|j\}?\W*n\W*d\W*i|::-|env:|sys:|lower:|upper:|base64:)/i', $v)) {
                $add('log4shell', 15, "$name: $v", 403);
            }
            if (preg_match('/\(\)\s*\{\s*:?\s*;?\s*\}\s*;/', $v)) {
                $add('shellshock', 15, "$name: $v", 403);
            }
        }

        // The query string (and a sign-in's fields, and the Referer): attacks have no business there.
        $values = [];
        $walk = function ($v, string $name) use (&$walk, &$values) {
            if (is_array($v)) {
                foreach ($v as $k => $sub) {
                    $walk($sub, "$name.$k");
                }
            } elseif (is_scalar($v)) {
                $values[$name] = (string) $v;
            }
        };
        foreach ((array) ($r['query'] ?? []) as $k => $v) {
            if (!in_array((string) $k, self::FREE_TEXT, true)) {
                $walk($v, 'query ' . $k);
            }
            $walk((string) $k, 'query name');
        }
        foreach ((array) ($r['body'] ?? []) as $k => $v) {
            $walk($v, 'field ' . $k);
        }
        // (Not the Referer: a normal link's has "&id=…" and whatever was searched for elsewhere. Log4Shell is checked above.)
        foreach (['user-agent', 'x-forwarded-for', 'accept-language', 'x-requested-with'] as $h) {
            if (isset($headers[$h])) {
                $values["header $h"] = (string) $headers[$h];
            }
        }
        foreach ($values as $where => $raw) {
            // Attacks often come encoded twice: look at both.
            foreach (array_unique([$raw, rawurldecode($raw), html_entity_decode(rawurldecode($raw), ENT_QUOTES | ENT_HTML5)]) as $v) {
                foreach (self::signatures() as [$rule, $score, $re]) {
                    if ($where === 'header user-agent' && $rule === 'xss' && !preg_match('/<\s*script|javascript:/i', $v)) {
                        continue; // browsers' own agents have semicolons and brackets
                    }
                    if (preg_match($re, $v, $m)) {
                        $add($rule, $score, "$where: " . $v, 403);
                    }
                }
                if (str_contains($v, "\0") && $where !== 'header user-agent') {
                    $add('null_byte', 5, "$where has a NUL byte", 400);
                }
                if (!str_starts_with($where, 'header') && preg_match('/[\r\n]/', $v) && !str_starts_with($where, 'field')) {
                    $add('crlf', 3, "$where has a line break", 400);
                }
            }
            if (!mb_check_encoding($raw, 'UTF-8') && !str_starts_with($where, 'header')) {
                $add('bad_utf8', 2, "$where isn't UTF-8");
            }
        }

        // Changes must come from the webmail's own pages (the CSRF token is checked too; this is a second lock).
        $origin = (string) ($headers['origin'] ?? '');
        $ours = array_filter([(string) ($r['origin'] ?? ''), (string) ($r['host_origin'] ?? '')]);
        if ($method === 'POST' && $endpoint === 'api' && $origin !== '' && $origin !== 'null' && $ours
            && !in_array(strtolower(rtrim($origin, '/')), $ours, true) && !str_starts_with($action, 'data-requests')) {
            $add('cross_site', 3, "Origin $origin", 403);
        }
        return $found;
    }

    /** [rule, score, regex]: the attack patterns looked for in the query string, a sign-in's fields and some headers. */
    private static function signatures(): array
    {
        return [
            ['sqli', 5, '/\bunion\b[\s\/*+]{1,40}(?:all\b[\s\/*+]+)?select\b/i'],
            ['sqli', 5, '/[\'"`)]\s*(?:\bor\b|\band\b|\|\||&&)\s*[\'"`(]?\s*[\w\'"]+[\'"`)]?\s*(?:=|<|>|\blike\b|\bis\b)/i'],
            ['sqli', 5, '/\b(?:or|and)\b\s+[\'"]?\d+[\'"]?\s*=\s*[\'"]?\d+/i'],
            ['sqli', 5, '/\b(?:sleep|benchmark|pg_sleep|dbms_pipe\.receive_message)\s*\(|\bwaitfor\s+delay\s+[\'"]/i'],
            ['sqli', 5, '/\binformation_schema\b|\bmysql\.user\b|\bsys\.(?:tables|objects|user\$)|\bpg_catalog\b|\bsqlite_master\b/i'],
            ['sqli', 5, '/;\s*(?:drop|truncate|alter|create|insert|delete|update|exec)\s+(?:table|database|from|into|user|procedure|\w+\s+set)\b/i'],
            ['sqli', 5, '/\b(?:load_file|into\s+(?:out|dump)file|xp_cmdshell|extractvalue|updatexml)\b/i'],
            ['sqli', 5, '/[\'"]\s*;?\s*(?:--|#|\/\*)\s*$/'],
            ['xss', 5, '/<\s*\/?\s*(?:script|iframe|object|embed|applet|base|meta|svg|math|template)\b/i'],
            ['xss', 5, '/\b(?:javascript|vbscript|livescript)\s*:/i'],
            ['xss', 5, '/(?:^|[\s"\'\/<>;])on(?:error|load|mouse\w+|focus\w*|blur|click|dblclick|key\w+|toggle|begin|animation\w+|transition\w+|pointer\w+|wheel|input|change|submit)\s*=/i'],
            ['xss', 5, '/\bsrcdoc\s*=|\bdocument\s*\.\s*(?:cookie|domain|write)\b|\bString\s*\.\s*fromCharCode\s*\(|\balert\s*\(\s*[\w\'"`]|\beval\s*\(/i'],
            ['traversal', 5, '/(?:\.\.|%2e%2e|%252e%252e)(?:[\/\\\\]|%2f|%5c|%252f)/i'],
            ['traversal', 5, '/\/etc\/(?:passwd|shadow|hosts|group)\b|\/proc\/self\/|\bc:\\\\windows\\\\|\bboot\.ini\b|\bwin\.ini\b|\.htaccess\b|\.git\/(?:config|HEAD)\b|\bwp-config\.php\b|(?:^|\/)\.env\b/i'],
            ['traversal', 5, '/^(?:php|file|expect|phar|zip|glob|data|compress\.zlib|ogg|ssh2|rar|dict|gopher|ldap|jar):\/\//i'],
            ['command', 5, '/(?:[;|`&]|\$\(|\|\|)\s*(?:cat|ls|id|whoami|uname|wget|curl|nc|ncat|netcat|bash|sh|zsh|python[23]?|perl|ruby|php|powershell|cmd(?:\.exe)?|ping|nslookup|sleep|echo)\b/i'],
            ['command', 5, '/\b(?:system|exec|passthru|shell_exec|popen|proc_open|pcntl_exec|assert|create_function|call_user_func(?:_array)?|base64_decode)\s*\(/i'],
            ['command', 5, '/<\?(?:php|=)/i'],
            ['php_object', 5, '/(?:^|[;{\s])[OC]:\d+:"[A-Za-z_\\\\][\w\\\\]*":\d+:\{/'],
            ['template', 5, '/\{\{\s*\d+\s*[*+]\s*\d+\s*\}\}|\$\{\s*\d+\s*[*+]\s*\d+\s*\}|<%=?\s*\d+\s*[*+]\s*\d+\s*%>|#\{\s*\d+\s*[*+]\s*\d+\s*\}/'],
            ['ssrf', 3, '/^(?:https?|ftp):\/\/(?:127\.|0\.0\.0\.0|localhost|169\.254\.169\.254|\[?::1\]?|metadata\.google\.internal)/i'],
        ];
    }

    // ------------------------------------------------------------------------------------------------ guarding a request

    /**
     * Check this request (from api.php, index.php or calendar.php) and refuse it when it should be. Never stops a
     * request because of its own fault: if the firewall can't work (the database is down), the request goes on.
     */
    public function guard(string $endpoint, array $body = []): void
    {
        try {
            $settings = $this->settings();
            if ($settings['mode'] === 'off') {
                return;
            }
            $ip = self::clientIp();
            $request = $this->request($endpoint, $body);
            $verdict = $this->judge($ip, $request);
        } catch (\Throwable $e) {
            error_log('webmail firewall: ' . $e->getMessage());
            return;
        }
        if ($verdict) {
            $this->refuse($endpoint, ...$verdict);
        }
    }

    /** The request as inspect() takes it, from PHP's globals. */
    public function request(string $endpoint, array $body = []): array
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
            }
        }
        $base = parse_url($this->app->baseUrl());
        $origin = isset($base['scheme'], $base['host']) ? strtolower($base['scheme'] . '://' . $base['host'] . (isset($base['port']) ? ':' . $base['port'] : '')) : '';
        // The address it was reached at, too (www. or not): a page of ours there is ours.
        $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
        $hostOrigin = preg_match('/^[a-z0-9.\-]+(?::\d+)?$|^\[[0-9a-f:.]+\](?::\d+)?$/', $host) ? (Http::isHttps() ? 'https' : 'http') . '://' . $host : '';
        return ['method' => (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'), 'endpoint' => $endpoint, 'action' => (string) ($_GET['a'] ?? ''), 'query' => $_GET,
            'headers' => $headers, 'path_info' => (string) ($_SERVER['PATH_INFO'] ?? ''), 'uri' => (string) ($_SERVER['REQUEST_URI'] ?? ''), 'body' => $body, 'origin' => $origin,
            'host_origin' => $hostOrigin,
            'signed_in' => isset($_COOKIE['wmsid'])];
    }

    /**
     * The verdict on a request from $ip: null to let it through, or [status, code, message, retry-after seconds, ref].
     * Findings are logged and scored; in monitor mode nothing is refused.
     */
    public function judge(string $ip, array $request): ?array
    {
        $s = $this->settings();
        $monitor = $s['mode'] === 'monitor';
        $exempt = $this->exempt($ip);
        // On the block list, or blocked for a while.
        if (!$exempt && $s['deny'] && Security::inRanges($ip, $s['deny'])) {
            $ref = $this->log($ip, 'deny_list', $monitor ? 'logged' : 'blocked', 0, $request, 'On the block list');
            if (!$monitor) {
                return [403, 'blocked', 'This network address is blocked from the webmail. Ask its administrator.', 0, $ref];
            }
        }
        if (!$exempt) {
            $row = $this->app->db->one('SELECT blocked_until, reason FROM {waf_ips} WHERE ip = ?', [$ip]);
            if ($row && $row['blocked_until'] !== null && strtotime($row['blocked_until'] . ' UTC') > $this->now() && !$monitor) {
                $left = strtotime($row['blocked_until'] . ' UTC') - $this->now();
                return [403, 'blocked', 'Too many suspicious requests came from your network address, so it\'s blocked for ' . self::duration($left)
                    . '. If that\'s a mistake, ask the webmail\'s administrator.', $left, null];
            }
        }
        // Too fast.
        if (!$exempt) {
            $limits = self::LIMITS[$s['sensitivity']] ?? self::LIMITS['normal'];
            foreach (['all' => true, 'anon' => empty($request['signed_in'])] as $kind => $applies) {
                if (!$applies) {
                    continue;
                }
                $n = $this->count($ip, $kind);
                if ($n > $limits[$kind]) {
                    if ($n === $limits[$kind] + 1) {
                        $this->penalise($ip, 'rate_limit', 3, $request, "More than {$limits[$kind]} requests a minute" . ($kind === 'anon' ? ' without signing in' : ''), $monitor ? 'logged' : 'limited');
                    }
                    if (!$monitor) {
                        return [429, 'rate_limited', 'Too many requests from your network address. Wait a minute and try again.', 60, null];
                    }
                }
            }
        }
        // What's in it.
        $refuse = null;
        foreach (self::inspect($request) as $f) {
            if ($exempt && $f['refuse'] === 0) {
                continue;
            }
            $action = $monitor ? 'logged' : ($f['refuse'] ? 'blocked' : 'logged');
            $ref = $exempt ? $this->log($ip, $f['rule'], $action, 0, $request, $f['detail']) : $this->penalise($ip, $f['rule'], $f['score'], $request, $f['detail'], $action);
            if ($f['refuse'] && !$monitor && $refuse === null) {
                $refuse = [$f['refuse'], 'firewall', 'The webmail\'s firewall refused this request. If that\'s a mistake, ask its administrator and give them the reference.', 0, $ref];
            }
        }
        return $refuse;
    }

    /** Never blocked or limited: the allow list, the trusted networks, and where an administrator is signed in now. */
    private array $exemptCache = [];

    public function exempt(string $ip): bool
    {
        return $this->exemptCache[$ip] ??= $this->isExempt($ip);
    }

    private function isExempt(string $ip): bool
    {
        $s = $this->settings();
        $policy = (new Security($this->app))->policy();
        if (Security::inRanges($ip, array_merge($s['allow'], $policy['admin_ips'], $policy['user_ips']))) {
            return true;
        }
        // Behind Cloudflare without saying so: every visitor would look like Cloudflare. Don't block it.
        if ($s['proxy'] === 'direct' && Security::inRanges($ip, self::CLOUDFLARE)) {
            return true;
        }
        return (bool) $this->app->db->value("SELECT 1 FROM {sessions} s JOIN {users} u ON u.id = s.user_id WHERE s.ip = ? AND u.role = 'admin' AND u.disabled = 0 AND s.updated_at > ? LIMIT 1",
            [$ip, $this->now() - 86400]);
    }

    /** Requests from an address this minute, counting this one. */
    private function count(string $ip, string $kind): int
    {
        $minute = intdiv($this->now(), 60);
        $id = $this->app->db->insert('INSERT INTO {waf_rate} (ip, minute, kind, n) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE n = LAST_INSERT_ID(n + 1)', [$ip, $minute, $kind]);
        return max(1, $id);
    }

    /**
     * Add to an address's score (and log it); at the threshold, block it. Returns the event's reference. Also used for
     * failed sign-ins and unknown actions (api.php).
     */
    public function penalise(string $ip, string $rule, int $score, array $request, string $detail, string $action = 'logged'): ?string
    {
        if ($this->settings()['mode'] === 'off') {
            return null;
        }
        if ($this->exempt($ip)) {
            return $this->log($ip, $rule, 'logged', 0, $request, $detail);
        }
        $now = $this->now();
        $db = $this->app->db;
        $row = $db->one('SELECT * FROM {waf_ips} WHERE ip = ?', [$ip]);
        $fresh = !$row || strtotime($row['score_since'] . ' UTC') < $now - self::WINDOW;
        $total = ($fresh ? 0 : (int) $row['score']) + $score;
        $db->run('INSERT INTO {waf_ips} (ip, score, score_since) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE score = VALUES(score), score_since = IF(?, VALUES(score_since), score_since)',
            [$ip, $total, $this->at($now), $fresh ? 1 : 0]);
        $ref = $this->log($ip, $rule, $action, $score, $request, $detail);
        $monitor = $this->settings()['mode'] === 'monitor';
        $blocked = $row && $row['blocked_until'] !== null && strtotime($row['blocked_until'] . ' UTC') > $now;
        if ($total >= self::THRESHOLD && !$blocked && !$monitor) {
            $this->block($ip, null, "Scored $total in an hour (last: $rule)", false);
            $this->log($ip, $rule, 'banned', 0, $request, "Blocked: scored $total in an hour");
        }
        return $ref;
    }

    /** Block an address: for $seconds, or (null) as long as its record says it should be (15 minutes, an hour, a day). */
    public function block(string $ip, ?int $seconds, string $reason, bool $manual): array
    {
        $now = $this->now();
        $row = $this->app->db->one('SELECT blocks, last_block_at FROM {waf_ips} WHERE ip = ?', [$ip]);
        // Blocks within the last week count towards a longer one.
        $previous = $row && $row['last_block_at'] && strtotime($row['last_block_at'] . ' UTC') > $now - 7 * 86400 ? (int) $row['blocks'] : 0;
        $seconds ??= self::BLOCK_STEPS[min($previous, count(self::BLOCK_STEPS) - 1)];
        $until = $this->at($now + $seconds);
        $this->app->db->run('INSERT INTO {waf_ips} (ip, score, score_since, blocked_until, blocks, last_block_at, reason, manual) VALUES (?, 0, ?, ?, 1, ?, ?, ?)
            ON DUPLICATE KEY UPDATE score = 0, score_since = VALUES(score_since), blocked_until = VALUES(blocked_until), blocks = ?, last_block_at = VALUES(last_block_at),
            reason = VALUES(reason), manual = VALUES(manual)', [$ip, $this->at($now), $until, $this->at($now), mb_substr($reason, 0, 200), $manual ? 1 : 0, $previous + 1]);
        return ['ip' => $ip, 'until' => gmdate('c', $now + $seconds)];
    }

    public function unblock(string $ip): void
    {
        // Forgiven: its score and record start again.
        $this->app->db->run('UPDATE {waf_ips} SET blocked_until = NULL, score = 0, blocks = 0 WHERE ip = ?', [$ip]);
    }

    /** Log what was seen. Returns its reference ("W" and the event's number), to quote when asking to be let in. */
    private function log(string $ip, string $rule, string $action, int $score, array $request, string $detail): string
    {
        $id = $this->app->db->insert('INSERT INTO {waf_events} (at, ip, rule, action, score, method, target, detail, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            $this->at($this->now()), $ip, $rule, $action, $score, substr(strtoupper((string) ($request['method'] ?? '')), 0, 10),
            mb_substr(($request['endpoint'] ?? '') . ($request['action'] ?? '' ? ' ' . $request['action'] : ''), 0, 200),
            mb_substr(self::printable($detail), 0, 300), mb_substr(self::printable((string) ($request['headers']['user-agent'] ?? '')), 0, 200)]);
        return 'W' . $id;
    }

    private static function printable(string $s): string
    {
        $s = mb_check_encoding($s, 'UTF-8') ? $s : mb_convert_encoding($s, 'UTF-8', 'ISO-8859-1');
        return preg_replace('/[\x00-\x1F\x7F]/u', '·', $s) ?? '';
    }

    private static function duration(int $s): string
    {
        return $s >= 3600 ? ceil($s / 3600) . ' hour' . (ceil($s / 3600) > 1 ? 's' : '') : max(1, (int) ceil($s / 60)) . ' minute' . (ceil($s / 60) > 1 ? 's' : '');
    }

    /** Say no: JSON for the app's API, a page for a browser. */
    private function refuse(string $endpoint, int $status, string $code, string $message, int $retry, ?string $ref): never
    {
        if ($retry > 0) {
            header('Retry-After: ' . $retry);
        }
        if ($endpoint === 'api') {
            Http::json(['error' => $code, 'message' => $message . ($ref ? " (Reference $ref.)" : ''), 'ref' => $ref], $status);
        }
        http_response_code($status);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        $esc = fn ($t) => htmlspecialchars($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        echo '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
            . '<title>Not allowed</title><body style="font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#1d2330">'
            . '<h1 style="font-size:22px">' . ($status === 429 ? 'Slow down a little' : 'Not allowed') . '</h1><p>' . $esc($message) . '</p>'
            . ($ref ? '<p style="color:#64708a">Reference: <code>' . $esc($ref) . '</code></p>' : '') . '</body></html>';
        exit;
    }

    // ------------------------------------------------------------------------------------------------ for administrators

    /** What Settings → Firewall shows. */
    public function status(): array
    {
        $db = $this->app->db;
        $now = $this->now();
        $since = $this->at($now - 86400);
        $s = $this->settings();
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        return [
            'settings' => $s,
            'shared_at' => $this->sharedAt(),
            'your_ip' => self::clientIp(),
            // Behind Cloudflare without saying so: everyone looks like Cloudflare.
            'cloudflare_detected' => $s['proxy'] === 'direct' && Security::inRanges($remote, self::CLOUDFLARE),
            'stats' => [
                'refused_24h' => (int) $db->value("SELECT COUNT(*) FROM {waf_events} WHERE at > ? AND action IN ('blocked','limited')", [$since]),
                'logged_24h' => (int) $db->value("SELECT COUNT(*) FROM {waf_events} WHERE at > ? AND action = 'logged'", [$since]),
                'blocked_now' => (int) $db->value('SELECT COUNT(*) FROM {waf_ips} WHERE blocked_until > ?', [$this->at($now)]),
                'addresses_24h' => (int) $db->value('SELECT COUNT(DISTINCT ip) FROM {waf_events} WHERE at > ?', [$since]),
            ],
            'rules_24h' => array_map(fn ($r) => ['rule' => $r['rule'], 'n' => (int) $r['n']],
                $db->all('SELECT rule, COUNT(*) AS n FROM {waf_events} WHERE at > ? GROUP BY rule ORDER BY n DESC LIMIT 8', [$since])),
            'blocked' => array_map(fn ($r) => ['ip' => $r['ip'], 'until' => gmdate('c', strtotime($r['blocked_until'] . ' UTC')), 'reason' => $r['reason'],
                'blocks' => (int) $r['blocks'], 'manual' => (bool) $r['manual']],
                $db->all('SELECT * FROM {waf_ips} WHERE blocked_until > ? ORDER BY blocked_until DESC LIMIT 200', [$this->at($now)])),
            'events' => array_map(fn ($r) => ['ref' => 'W' . $r['id'], 'at' => gmdate('c', strtotime($r['at'] . ' UTC')), 'ip' => $r['ip'], 'rule' => $r['rule'],
                'action' => $r['action'], 'score' => (int) $r['score'], 'method' => $r['method'], 'target' => $r['target'], 'detail' => $r['detail'], 'agent' => $r['agent']],
                $db->all('SELECT * FROM {waf_events} ORDER BY id DESC LIMIT 200')),
        ];
    }

    /**
     * The attacks since the last report, summarised for GhostParse: per address, kind and action, how many and when.
     * Never what was in the requests. Private and reserved addresses are left out. Returns [reports, last event id].
     */
    public function shareSummary(int $afterId): array
    {
        $rows = $this->app->db->all('SELECT id, at, ip, rule, action FROM {waf_events} WHERE id > ? ORDER BY id LIMIT ' . self::SHARE_BATCH, [$afterId]);
        $groups = [];
        $last = $afterId;
        foreach ($rows as $r) {
            $k = "{$r['ip']}|{$r['rule']}|{$r['action']}";
            if (!isset($groups[$k]) && count($groups) >= 500) {
                break; // the rest go in the next report
            }
            $last = (int) $r['id'];
            if (in_array($r['rule'], self::NOT_SHARED, true)
                || !filter_var($r['ip'], FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                continue;
            }
            $when = gmdate('c', strtotime($r['at'] . ' UTC'));
            $groups[$k] ??= ['ip' => $r['ip'], 'kind' => mb_substr(preg_replace('/[^a-z0-9_]/', '_', strtolower($r['rule'])), 0, 40), 'action' => $r['action'], 'count' => 0, 'first_at' => $when];
            $groups[$k]['count']++;
            $groups[$k]['last_at'] = $when;
        }
        return [array_values($groups), $last];
    }

    /** When the last summary went to GhostParse, if one has. */
    private function sharedAt(): ?string
    {
        $at = (int) ((json_decode((string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'threat_share'"), true) ?: [])['at'] ?? 0);
        return $at > 0 && $at <= time() ? gmdate('c', $at) : null;
    }

    /** Old counts and events go (with the due work). */
    public function cleanup(): void
    {
        $this->app->db->run('DELETE FROM {waf_rate} WHERE minute < ?', [intdiv($this->now(), 60) - 10]);
        $this->app->db->run('DELETE FROM {waf_events} WHERE at < ?', [$this->at($this->now() - 30 * 86400)]);
        $this->app->db->run('DELETE FROM {waf_ips} WHERE (blocked_until IS NULL OR blocked_until < ?) AND score_since < ? AND (last_block_at IS NULL OR last_block_at < ?)',
            [$this->at($this->now()), $this->at($this->now() - self::WINDOW), $this->at($this->now() - 7 * 86400)]);
    }
}
