<?php
declare(strict_types=1);

namespace Webmail;

/**
 * The database tables, as numbered migrations: the installer runs them all, and an upgrade runs the new ones.
 * Columns ending _enc hold Crypto::encrypt() values; _bidx columns hold blind indexes (for lookups without the value).
 */
final class Schema
{
    /** @return array<int, string[]> */
    /** Every table the webmail makes (without the prefix). */
    public static function tables(): array
    {
        return ['imports', 'address_book', 'mfa_recovery_codes', 'passkeys', 'push_subscriptions', 'login_attempts', 'events', 'contacts', 'search', 'attachments', 'messages', 'user_mailboxes', 'mailboxes', 'users', 'meta'];
    }

    public static function migrations(): array
    {
        return [
            1 => [
                "CREATE TABLE IF NOT EXISTS {meta} (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {users} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    email_bidx BINARY(16) NOT NULL UNIQUE,
                    email_enc TEXT NOT NULL,
                    name_enc TEXT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    role ENUM('admin','user') NOT NULL DEFAULT 'user',
                    created_at DATETIME NOT NULL,
                    last_login_at DATETIME NULL,
                    disabled TINYINT(1) NOT NULL DEFAULT 0
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {mailboxes} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    address_bidx BINARY(16) NOT NULL UNIQUE,
                    address_enc TEXT NOT NULL,
                    display_name_enc TEXT NULL,
                    signature_enc TEXT NULL,
                    created_at DATETIME NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {user_mailboxes} (
                    user_id INT UNSIGNED NOT NULL,
                    mailbox_id INT UNSIGNED NOT NULL,
                    PRIMARY KEY (user_id, mailbox_id),
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE,
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {messages} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    mailbox_id INT UNSIGNED NOT NULL,
                    folder ENUM('inbox','sent','drafts','archive','spam','trash') NOT NULL,
                    gp_id VARCHAR(100) NULL,
                    thread_key VARCHAR(100) NULL,
                    from_enc TEXT NULL,
                    to_enc TEXT NULL,
                    subject_enc TEXT NULL,
                    snippet_enc TEXT NULL,
                    body_enc MEDIUMTEXT NULL,
                    meta_enc MEDIUMTEXT NULL,
                    sent_at DATETIME NOT NULL,
                    is_read TINYINT(1) NOT NULL DEFAULT 0,
                    is_starred TINYINT(1) NOT NULL DEFAULT 0,
                    has_attachments TINYINT(1) NOT NULL DEFAULT 0,
                    size INT UNSIGNED NOT NULL DEFAULT 0,
                    auth_verdict VARCHAR(16) NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE KEY mailbox_gp (mailbox_id, gp_id),
                    KEY mailbox_folder_date (mailbox_id, folder, sent_at),
                    KEY thread (mailbox_id, thread_key),
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {attachments} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    message_id INT UNSIGNED NOT NULL,
                    filename_enc TEXT NOT NULL,
                    content_type VARCHAR(255) NOT NULL,
                    size INT UNSIGNED NOT NULL,
                    content_id_enc TEXT NULL,
                    inline TINYINT(1) NOT NULL DEFAULT 0,
                    content_enc LONGTEXT NULL,
                    url_enc TEXT NULL,
                    FOREIGN KEY (message_id) REFERENCES {messages}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {search} (
                    message_id INT UNSIGNED NOT NULL,
                    token BINARY(16) NOT NULL,
                    PRIMARY KEY (token, message_id),
                    KEY message (message_id),
                    FOREIGN KEY (message_id) REFERENCES {messages}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {contacts} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    address_bidx BINARY(16) NOT NULL,
                    address_enc TEXT NOT NULL,
                    name_enc TEXT NULL,
                    used INT UNSIGNED NOT NULL DEFAULT 1,
                    last_used_at DATETIME NOT NULL,
                    UNIQUE KEY user_address (user_id, address_bidx),
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {events} (
                    id VARCHAR(100) PRIMARY KEY,
                    received_at DATETIME NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {login_attempts} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    key_bidx BINARY(16) NOT NULL,
                    at DATETIME NOT NULL,
                    KEY key_at (key_bidx, at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {push_subscriptions} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    endpoint_bidx BINARY(16) NOT NULL UNIQUE,
                    subscription_enc TEXT NOT NULL,
                    created_at DATETIME NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {passkeys} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    credential_bidx BINARY(16) NOT NULL UNIQUE,
                    credential_id_enc TEXT NOT NULL,
                    public_key_enc TEXT NOT NULL,
                    sign_count INT UNSIGNED NOT NULL DEFAULT 0,
                    name_enc TEXT NULL,
                    created_at DATETIME NOT NULL,
                    last_used_at DATETIME NULL,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Two-step verification: an authenticator app (TOTP) and one-time recovery codes. session_version lets a
            // reset or a password change sign the person out everywhere.
            2 => [
                "ALTER TABLE {users} ADD COLUMN totp_secret_enc TEXT NULL, ADD COLUMN totp_enabled_at DATETIME NULL,
                    ADD COLUMN totp_last_step BIGINT NULL, ADD COLUMN session_version INT UNSIGNED NOT NULL DEFAULT 0",
                "CREATE TABLE IF NOT EXISTS {mfa_recovery_codes} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    code_bidx BINARY(16) NOT NULL UNIQUE,
                    created_at DATETIME NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Address books: owner_id is the user for a personal book, 0 for the shared one. Every field is
            // encrypted; email_bidx finds duplicates without revealing the address.
            3 => [
                "CREATE TABLE IF NOT EXISTS {address_book} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    owner_id INT UNSIGNED NOT NULL,
                    email_bidx BINARY(16) NOT NULL,
                    email_enc TEXT NOT NULL,
                    name_enc TEXT NULL,
                    phone_enc TEXT NULL,
                    company_enc TEXT NULL,
                    notes_enc TEXT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    UNIQUE KEY book_email (owner_id, email_bidx)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Importing email from an old mailbox (IMAP) or a file (.mbox, .eml): where each import has got to. The
            // old server's sign-in is encrypted and can be forgotten; state holds each folder's last copied UID.
            4 => [
                "CREATE TABLE IF NOT EXISTS {imports} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    mailbox_id INT UNSIGNED NOT NULL,
                    kind ENUM('imap','file') NOT NULL,
                    status ENUM('uploading','running','done','failed') NOT NULL,
                    settings_enc TEXT NULL,
                    state_enc MEDIUMTEXT NOT NULL,
                    imported INT UNSIGNED NOT NULL DEFAULT 0,
                    skipped INT UNSIGNED NOT NULL DEFAULT 0,
                    failed INT UNSIGNED NOT NULL DEFAULT 0,
                    note_enc TEXT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    finished_at DATETIME NULL,
                    KEY user_imports (user_id),
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE,
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
        ];
    }

    public static function latest(): int
    {
        return max(array_keys(self::migrations()));
    }

    /** Run the migrations the database hasn't had yet. Returns the new version. */
    /** Apply any changes a newer version brings: one quick check when the webmail is opened. */
    public static function upgrade(Db $db): void
    {
        $latest = max(array_keys(self::migrations()));
        if ((int) ($db->value("SELECT v FROM {meta} WHERE k = 'schema_version'") ?? 0) < $latest) {
            self::migrate($db);
        }
    }

    public static function migrate(Db $db): int
    {
        $db->run("CREATE TABLE IF NOT EXISTS {meta} (k VARCHAR(64) PRIMARY KEY, v TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        $current = (int) ($db->value("SELECT v FROM {meta} WHERE k = 'schema_version'") ?? 0);
        foreach (self::migrations() as $version => $statements) {
            if ($version <= $current) {
                continue;
            }
            foreach ($statements as $sql) {
                $db->run($sql);
            }
            $db->run("REPLACE INTO {meta} (k, v) VALUES ('schema_version', ?)", [(string) $version]);
            $current = $version;
        }
        return $current;
    }
}
