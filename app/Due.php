<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Work that's due: snoozed email whose time has come, and emails scheduled to be sent. Shared hosting often has no cron,
 * so this runs after the webmail answers a request (anyone using it, the page checking for new mail every 30 seconds,
 * GhostParse delivering email) and from due.php, which a cron job can call every minute where there is one, for exact
 * times when nobody has the webmail open.
 *
 * It's one quick query when there's nothing to do, and one request at a time does the work (a database lock).
 */
final class Due
{
    /** Notifies the people on a mailbox that a snoozed email is back: fn(array $woken). Replaced in tests. */
    public ?\Closure $onWoken = null;
    /** Sends the scheduled email (replaced in tests). */
    public ?Scheduler $scheduler = null;

    public function __construct(private App $app)
    {
        if (Notifier::supported()) {
            $this->onWoken = function (array $woken) use ($app) {
                $notifier = new Notifier($app);
                $store = new Mailstore($app);
                foreach ($woken as $w) {
                    $m = $store->headline($w['id']);
                    $from = $m['from'] ?? [];
                    $payload = ['title' => 'Back from snooze: ' . mb_substr((string) (($from['name'] ?? '') ?: ($from['address'] ?? 'an email')), 0, 60),
                        'body' => mb_substr((string) (($m['subject'] ?? '') ?: '(no subject)'), 0, 140), 'tag' => 'm' . $w['id'], 'url' => './#m=' . $w['id']];
                    foreach ($app->db->all('SELECT user_id FROM {user_mailboxes} WHERE mailbox_id = ?', [$w['mailbox_id']]) as $row) {
                        $notifier->notifyUser((int) $row['user_id'], $payload + ['unread' => $notifier->unreadFor((int) $row['user_id'])]);
                    }
                }
            };
        }
    }

    public static function lockName(App $app): string
    {
        return 'wm_due_' . md5((string) $app->db->value('SELECT DATABASE()') . '.' . $app->db->prefix);
    }

    /** Is anything due? One indexed query each. */
    public function pending(): bool
    {
        $now = App::now();
        return (bool) $this->app->db->value('SELECT 1 FROM {messages} WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? LIMIT 1', [$now])
            || (bool) $this->app->db->value("SELECT 1 FROM {scheduled} WHERE (status = 'waiting' AND send_at <= ?) OR (status = 'sending' AND claimed_at < ?) LIMIT 1",
                [$now, gmdate('Y-m-d H:i:s', time() - 600)]);
    }

    /** Do what's due. Returns ['woken' => n, 'sent' => n], or null when another request is doing it. */
    public function run(int $seconds = 20): ?array
    {
        if (!$this->pending()) {
            return ['woken' => 0, 'sent' => 0];
        }
        // Locks are server-wide: this install's own (its database and table prefix), so other webmails on the server don't wait.
        $lock = self::lockName($this->app);
        if (!(int) $this->app->db->value('SELECT GET_LOCK(?, 0)', [$lock])) {
            return null;
        }
        try {
            $woken = (new Mailstore($this->app))->wakeSnoozed();
            if ($woken && $this->onWoken) {
                try {
                    ($this->onWoken)($woken);
                } catch (\Throwable $e) {
                    error_log('webmail: notification failed: ' . $e->getMessage());
                }
            }
            $sent = ($this->scheduler ?? new Scheduler($this->app))->runDue($seconds);
            return ['woken' => count($woken), 'sent' => $sent];
        } finally {
            $this->app->db->value('SELECT RELEASE_LOCK(?)', [$lock]);
        }
    }

    /**
     * After this request's answer has gone (where PHP can finish it early), do what's due. Never lets a problem here
     * reach the request.
     */
    public static function afterResponse(App $app): void
    {
        register_shutdown_function(static function () use ($app) {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            } elseif (function_exists('litespeed_finish_request')) {
                litespeed_finish_request();
            }
            try {
                ignore_user_abort(true);
                (new self($app))->run();
            } catch (\Throwable $e) {
                error_log('webmail: due work failed: ' . $e->getMessage());
            }
        });
    }
}
