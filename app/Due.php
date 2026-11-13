<?php
declare(strict_types=1);

namespace Webmail;

/**
 * Work that's due: snoozed email whose time has come, emails scheduled to be sent, and calendar reminders. Shared hosting often has no cron,
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
    /** Sends calendar reminders (replaced in tests). */
    public ?Calendar $calendar = null;

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
                        $notifier->notifyUser((int) $row['user_id'], $notifier->mailPayload((int) $row['user_id'], $w['id'], $payload));
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
                [$now, gmdate('Y-m-d H:i:s', time() - 600)])
            || (new Calendar($this->app))->remindersDue()
            || (bool) $this->app->db->value('SELECT 1 FROM {messages} WHERE parties_indexed = 0 LIMIT 1')
            || (bool) $this->app->db->value('SELECT 1 FROM {waf_rate} WHERE minute < ? LIMIT 1', [intdiv(time(), 60) - 60])
            || $this->receivingUnchecked()
            || $this->checkInDue();
    }

    /** Once a day, GhostParse is told this webmail's version and address, and how many users and mailboxes it has. */
    private function checkInDue(): bool
    {
        if ($this->app->config->get('checkin', true) === false) {
            return false;
        }
        $last = (string) $this->app->db->value("SELECT v FROM {meta} WHERE k = 'checkin_at'");
        return $last === '' || strtotime($last) < time() - 86400;
    }

    private function checkIn(): void
    {
        // Marked first: GhostParse being unreachable is tried again tomorrow, not on every request.
        $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('checkin_at', ?)", [App::now()]);
        $this->app->gp->heartbeat(['version' => App::VERSION, 'url' => $this->app->baseUrl(),
            'users' => (int) $this->app->db->value('SELECT COUNT(*) FROM {users}'),
            'mailboxes' => (int) $this->app->db->value('SELECT COUNT(*) FROM {mailboxes}')]);
    }

    /** Once, after updating to 1.18.0: mailboxes here, and their domains not yet checked for receiving switched off. */
    private function receivingUnchecked(): bool
    {
        return !$this->app->db->value("SELECT 1 FROM {meta} WHERE k = 'receiving_checked'")
            && (bool) $this->app->db->value('SELECT 1 FROM {mailboxes} LIMIT 1');
    }

    /** Do what's due. Returns ['woken' => n, 'sent' => n], or null when another request is doing it. */
    public function run(int $seconds = 20): ?array
    {
        if (!$this->pending()) {
            return ['woken' => 0, 'sent' => 0, 'reminded' => 0];
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
            $reminded = ($this->calendar ?? new Calendar($this->app))->sendReminders();
            // Email from before 1.14.0: who it's from and to, for the customer panel (a batch at a time).
            (new Mailstore($this->app))->indexOldParties(300);
            (new Waf($this->app))->cleanup();
            if ($this->checkInDue()) {
                try {
                    $this->checkIn();
                } catch (\Throwable $e) {
                    error_log('webmail: daily check-in with GhostParse failed: ' . $e->getMessage());
                }
            }
            if ($this->receivingUnchecked()) {
                // Marked done first: GhostParse being unreachable now isn't worth asking it on every request after.
                // An administrator's Connect addresses page checks again.
                $this->app->db->run("REPLACE INTO {meta} (k, v) VALUES ('receiving_checked', ?)", [App::now()]);
                try {
                    (new Admin($this->app))->ensureReceiving();
                } catch (\Throwable $e) {
                    error_log('webmail: checking domains receive failed: ' . $e->getMessage());
                }
            }
            return ['woken' => count($woken), 'sent' => $sent, 'reminded' => $reminded];
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
