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
        return ['file_comments', 'file_edit_presence', 'file_edit_ops', 'file_edit_state', 'vault_keys', 'file_activity', 'file_links', 'file_shares', 'file_uploads', 'file_versions', 'file_nodes', 'waf_events', 'waf_rate', 'waf_ips', 'message_parties', 'cal_events', 'cal_members', 'cal_calendars', 'data_requests', 'api_keys', 'rules', 'message_labels', 'labels', 'scheduled', 'templates', 'draft_presence', 'shared_drafts', 'thread_notes', 'thread_state', 'sessions', 'imports', 'address_book', 'mfa_recovery_codes', 'passkeys', 'push_subscriptions', 'login_attempts', 'events', 'contacts', 'search', 'attachments', 'messages', 'user_mailboxes', 'mailboxes', 'users', 'meta'];
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
            // Importing straight from this hosting account's own mailboxes (cPanel's Maildir folders).
            5 => [
                "ALTER TABLE {imports} MODIFY kind ENUM('imap','file','maildir') NOT NULL",
            ],
            // Sign-in sessions, here instead of PHP's session files (which many hosts clear on their own schedule).
            6 => [
                "CREATE TABLE IF NOT EXISTS {sessions} (
                    id_hash CHAR(64) NOT NULL PRIMARY KEY,
                    data_enc MEDIUMTEXT NOT NULL,
                    updated_at INT UNSIGNED NOT NULL,
                    KEY session_age (updated_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Shared mailboxes: who a conversation is assigned to and where it's up to, the team's private notes on it, and
            // replies written together. A conversation is its mailbox and thread_key (or "m<id>" for a lone message).
            7 => [
                "CREATE TABLE IF NOT EXISTS {thread_state} (
                    mailbox_id INT UNSIGNED NOT NULL,
                    thread_key VARCHAR(100) NOT NULL,
                    assignee_id INT UNSIGNED NULL,
                    status ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open',
                    updated_by INT UNSIGNED NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (mailbox_id, thread_key),
                    KEY assignee (assignee_id),
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE,
                    FOREIGN KEY (assignee_id) REFERENCES {users}(id) ON DELETE SET NULL,
                    FOREIGN KEY (updated_by) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {thread_notes} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    mailbox_id INT UNSIGNED NOT NULL,
                    thread_key VARCHAR(100) NOT NULL,
                    user_id INT UNSIGNED NULL,
                    kind ENUM('note','event') NOT NULL DEFAULT 'note',
                    body_enc TEXT NOT NULL,
                    mentions VARCHAR(255) NULL,
                    created_at DATETIME NOT NULL,
                    KEY conversation (mailbox_id, thread_key, id),
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {shared_drafts} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    mailbox_id INT UNSIGNED NOT NULL,
                    thread_key VARCHAR(100) NOT NULL,
                    reply_to_id INT UNSIGNED NULL,
                    fields_enc MEDIUMTEXT NOT NULL,
                    version INT UNSIGNED NOT NULL DEFAULT 1,
                    created_by INT UNSIGNED NULL,
                    updated_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    UNIQUE KEY conversation (mailbox_id, thread_key),
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE,
                    FOREIGN KEY (created_by) REFERENCES {users}(id) ON DELETE SET NULL,
                    FOREIGN KEY (updated_by) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {draft_presence} (
                    draft_id INT UNSIGNED NOT NULL,
                    user_id INT UNSIGNED NOT NULL,
                    seen_at INT UNSIGNED NOT NULL,
                    typing_at INT UNSIGNED NOT NULL DEFAULT 0,
                    PRIMARY KEY (draft_id, user_id),
                    FOREIGN KEY (draft_id) REFERENCES {shared_drafts}(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Templates (canned responses), send later and snooze, and rules that file new email into labels.
            // owner_id 0 is the shared set of templates (administrators edit it). A scheduled email is the compose
            // window's payload, sent by Due when its time comes. sort_at is where a message sits in its list: its date,
            // or when it came back from being snoozed. A label is a mailbox's own folder (or tag).
            8 => [
                "CREATE TABLE IF NOT EXISTS {templates} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    owner_id INT UNSIGNED NOT NULL,
                    name_enc TEXT NOT NULL,
                    shortcut_enc TEXT NULL,
                    subject_enc TEXT NULL,
                    body_enc MEDIUMTEXT NOT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    KEY owner (owner_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {scheduled} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    mailbox_id INT UNSIGNED NOT NULL,
                    send_at DATETIME NOT NULL,
                    payload_enc LONGTEXT NOT NULL,
                    summary_enc TEXT NOT NULL,
                    status ENUM('waiting','sending','failed') NOT NULL DEFAULT 'waiting',
                    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
                    error_enc TEXT NULL,
                    claimed_at DATETIME NULL,
                    created_at DATETIME NOT NULL,
                    KEY due (status, send_at),
                    KEY user_scheduled (user_id, send_at),
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE,
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "ALTER TABLE {messages} ADD COLUMN snoozed_until DATETIME NULL, ADD COLUMN sort_at DATETIME NULL,
                    ADD KEY snoozed (snoozed_until), ADD KEY mailbox_folder_sort (mailbox_id, folder, sort_at)",
                "UPDATE {messages} SET sort_at = sent_at WHERE sort_at IS NULL",
                "ALTER TABLE {users} ADD COLUMN prefs TEXT NULL",
                "CREATE TABLE IF NOT EXISTS {labels} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    mailbox_id INT UNSIGNED NOT NULL,
                    name_bidx BINARY(16) NOT NULL,
                    name_enc TEXT NOT NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE KEY mailbox_name (mailbox_id, name_bidx),
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {message_labels} (
                    message_id INT UNSIGNED NOT NULL,
                    label_id INT UNSIGNED NOT NULL,
                    PRIMARY KEY (message_id, label_id),
                    KEY label (label_id),
                    FOREIGN KEY (message_id) REFERENCES {messages}(id) ON DELETE CASCADE,
                    FOREIGN KEY (label_id) REFERENCES {labels}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {rules} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    mailbox_id INT UNSIGNED NOT NULL,
                    position INT UNSIGNED NOT NULL DEFAULT 0,
                    enabled TINYINT(1) NOT NULL DEFAULT 1,
                    rule_enc TEXT NOT NULL,
                    created_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    KEY mailbox_rules (mailbox_id, position),
                    FOREIGN KEY (mailbox_id) REFERENCES {mailboxes}(id) ON DELETE CASCADE,
                    FOREIGN KEY (created_by) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Data requests (GDPR subject access requests): keys for the systems that make them, and each request with
            // its results (removed after 30 days; the record stays). See DataRequests.
            9 => [
                "CREATE TABLE IF NOT EXISTS {api_keys} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    name_enc TEXT NOT NULL,
                    token_bidx BINARY(16) NOT NULL UNIQUE,
                    hint VARCHAR(32) NOT NULL,
                    allowed_ips_enc TEXT NULL,
                    scopes VARCHAR(100) NOT NULL,
                    created_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    last_used_at DATETIME NULL,
                    revoked_at DATETIME NULL,
                    FOREIGN KEY (created_by) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {data_requests} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    public_id VARCHAR(32) NOT NULL UNIQUE,
                    key_id INT UNSIGNED NULL,
                    user_id INT UNSIGNED NULL,
                    subject_bidx BINARY(16) NOT NULL,
                    subject_enc TEXT NOT NULL,
                    terms_enc TEXT NOT NULL,
                    reference_enc TEXT NULL,
                    mailbox_ids VARCHAR(2000) NULL,
                    since DATETIME NULL,
                    until DATETIME NULL,
                    include_attachments TINYINT(1) NOT NULL DEFAULT 1,
                    status ENUM('searching','ready','expired') NOT NULL,
                    cursor_id INT UNSIGNED NOT NULL DEFAULT 0,
                    scanned INT UNSIGNED NOT NULL DEFAULT 0,
                    total INT UNSIGNED NOT NULL DEFAULT 0,
                    matches_enc MEDIUMTEXT NULL,
                    created_at DATETIME NOT NULL,
                    completed_at DATETIME NULL,
                    expires_at DATETIME NOT NULL,
                    downloads INT UNSIGNED NOT NULL DEFAULT 0,
                    last_download_at DATETIME NULL,
                    KEY key_status (key_id, status),
                    KEY subject (subject_bidx),
                    FOREIGN KEY (key_id) REFERENCES {api_keys}(id) ON DELETE SET NULL,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // The calendar: personal calendars and shared ones, who's on each (and their private feed link), and events.
            10 => [
                "CREATE TABLE IF NOT EXISTS {cal_calendars} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    kind ENUM('personal','shared') NOT NULL,
                    owner_id INT UNSIGNED NULL,
                    name_enc TEXT NOT NULL,
                    color VARCHAR(7) NOT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    KEY owner (owner_id),
                    FOREIGN KEY (owner_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {cal_members} (
                    calendar_id INT UNSIGNED NOT NULL,
                    user_id INT UNSIGNED NOT NULL,
                    role ENUM('owner','edit','view') NOT NULL,
                    hidden TINYINT(1) NOT NULL DEFAULT 0,
                    feed_bidx BINARY(16) NULL UNIQUE,
                    feed_enc TEXT NULL,
                    added_at DATETIME NOT NULL,
                    PRIMARY KEY (calendar_id, user_id),
                    KEY user (user_id),
                    FOREIGN KEY (calendar_id) REFERENCES {cal_calendars}(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {cal_events} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    calendar_id INT UNSIGNED NOT NULL,
                    uid VARCHAR(255) NOT NULL,
                    title_enc TEXT NOT NULL,
                    location_enc TEXT NULL,
                    notes_enc MEDIUMTEXT NULL,
                    all_day TINYINT(1) NOT NULL DEFAULT 0,
                    start_at DATETIME NOT NULL,
                    end_at DATETIME NOT NULL,
                    tz VARCHAR(64) NOT NULL,
                    repeat_json VARCHAR(500) NULL,
                    repeat_until DATETIME NULL,
                    exdates TEXT NULL,
                    reminders VARCHAR(100) NULL,
                    next_reminder_at DATETIME NULL,
                    reminded_to DATETIME NULL,
                    color VARCHAR(7) NULL,
                    created_by INT UNSIGNED NULL,
                    updated_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    KEY range_start (calendar_id, start_at),
                    KEY range_until (calendar_id, repeat_until),
                    KEY reminder (next_reminder_at),
                    KEY uid (calendar_id, uid(64)),
                    FOREIGN KEY (calendar_id) REFERENCES {cal_calendars}(id) ON DELETE CASCADE,
                    FOREIGN KEY (created_by) REFERENCES {users}(id) ON DELETE SET NULL,
                    FOREIGN KEY (updated_by) REFERENCES {users}(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Security and the customer panel. Sessions say whose they are and where from (for the list of devices
            // signed in, and revoking one); a person can be limited to some IP addresses; notifications remember the
            // session that turned them on (revoking it stops them). Each email's people are indexed (blind) to find
            // everything from one customer, and the fields GhostParse's parser pulled out of it are kept.
            11 => [
                "ALTER TABLE {sessions} ADD COLUMN user_id INT UNSIGNED NULL, ADD COLUMN handle CHAR(32) NULL, ADD COLUMN ip VARCHAR(45) NULL,
                    ADD COLUMN agent_enc TEXT NULL, ADD COLUMN app TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN created_at INT UNSIGNED NULL,
                    ADD KEY session_user (user_id), ADD UNIQUE KEY session_handle (handle)",
                "ALTER TABLE {users} ADD COLUMN allowed_ips_enc TEXT NULL",
                "ALTER TABLE {push_subscriptions} ADD COLUMN session_hash CHAR(64) NULL, ADD KEY push_session (session_hash)",
                "ALTER TABLE {messages} ADD COLUMN extracted_enc MEDIUMTEXT NULL, ADD COLUMN parties_indexed TINYINT(1) NOT NULL DEFAULT 0,
                    ADD KEY parties_todo (parties_indexed)",
                "CREATE TABLE IF NOT EXISTS {message_parties} (
                    address_bidx BINARY(16) NOT NULL,
                    message_id INT UNSIGNED NOT NULL,
                    PRIMARY KEY (address_bidx, message_id),
                    KEY party_message (message_id),
                    FOREIGN KEY (message_id) REFERENCES {messages}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // The firewall (Waf): each address's suspicion score and block, requests counted per minute, and what it saw.
            12 => [
                "CREATE TABLE IF NOT EXISTS {waf_ips} (
                    ip VARCHAR(45) NOT NULL PRIMARY KEY,
                    score INT UNSIGNED NOT NULL DEFAULT 0,
                    score_since DATETIME NOT NULL,
                    blocked_until DATETIME NULL,
                    blocks INT UNSIGNED NOT NULL DEFAULT 0,
                    last_block_at DATETIME NULL,
                    reason VARCHAR(200) NULL,
                    manual TINYINT(1) NOT NULL DEFAULT 0,
                    KEY blocked (blocked_until)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {waf_rate} (
                    ip VARCHAR(45) NOT NULL,
                    minute INT UNSIGNED NOT NULL,
                    kind VARCHAR(16) NOT NULL,
                    n INT UNSIGNED NOT NULL DEFAULT 0,
                    PRIMARY KEY (ip, kind, minute),
                    KEY rate_age (minute)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {waf_events} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    at DATETIME NOT NULL,
                    ip VARCHAR(45) NOT NULL,
                    rule VARCHAR(32) NOT NULL,
                    action ENUM('blocked','logged','limited','banned') NOT NULL,
                    score SMALLINT UNSIGNED NOT NULL DEFAULT 0,
                    method VARCHAR(10) NOT NULL,
                    target VARCHAR(200) NOT NULL,
                    detail VARCHAR(300) NULL,
                    agent VARCHAR(200) NULL,
                    KEY event_age (at),
                    KEY event_ip (ip)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Files: folders and files (names encrypted), each file's versions (stored encrypted, on disk or S3, each
            // with its own key), uploads in progress, sharing with people and mailbox teams, share links, what was done,
            // and the private vault's keys (wrapped in the browser: the server can't open them).
            13 => [
                "CREATE TABLE IF NOT EXISTS {file_nodes} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    owner_id INT UNSIGNED NOT NULL,
                    parent_id INT UNSIGNED NULL,
                    kind ENUM('folder','file') NOT NULL,
                    vault TINYINT(1) NOT NULL DEFAULT 0,
                    name_enc TEXT NOT NULL,
                    mime VARCHAR(127) NOT NULL DEFAULT '',
                    size BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    version_id INT UNSIGNED NULL,
                    created_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    trashed_at DATETIME NULL,
                    trash_root TINYINT(1) NOT NULL DEFAULT 0,
                    KEY node_parent (parent_id),
                    KEY node_owner (owner_id, parent_id),
                    KEY node_trash (trashed_at),
                    FOREIGN KEY (owner_id) REFERENCES {users}(id) ON DELETE CASCADE,
                    FOREIGN KEY (parent_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_versions} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    node_id INT UNSIGNED NOT NULL,
                    store VARCHAR(10) NOT NULL,
                    object_key VARCHAR(80) NOT NULL,
                    key_enc TEXT NOT NULL,
                    size BIGINT UNSIGNED NOT NULL,
                    created_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    KEY version_node (node_id),
                    UNIQUE KEY version_object (object_key),
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_uploads} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    token CHAR(32) NOT NULL,
                    user_id INT UNSIGNED NULL,
                    link_id INT UNSIGNED NULL,
                    parent_id INT UNSIGNED NOT NULL,
                    node_id INT UNSIGNED NULL,
                    name_enc TEXT NOT NULL,
                    mime VARCHAR(127) NOT NULL DEFAULT '',
                    size BIGINT UNSIGNED NOT NULL,
                    received BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    store VARCHAR(10) NOT NULL,
                    object_key VARCHAR(80) NOT NULL,
                    key_enc TEXT NOT NULL,
                    state TEXT NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE KEY upload_token (token),
                    KEY upload_age (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_shares} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    node_id INT UNSIGNED NOT NULL,
                    user_id INT UNSIGNED NULL,
                    mailbox_id INT UNSIGNED NULL,
                    role ENUM('viewer','editor') NOT NULL,
                    created_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    UNIQUE KEY share_who (node_id, user_id, mailbox_id),
                    KEY share_user (user_id),
                    KEY share_mailbox (mailbox_id),
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_links} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    node_id INT UNSIGNED NOT NULL,
                    token_hash CHAR(64) NOT NULL,
                    token_enc TEXT NOT NULL,
                    kind ENUM('view','request') NOT NULL,
                    password_hash VARCHAR(255) NULL,
                    expires_at DATETIME NULL,
                    max_downloads INT UNSIGNED NULL,
                    downloads INT UNSIGNED NOT NULL DEFAULT 0,
                    created_by INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    last_used_at DATETIME NULL,
                    revoked_at DATETIME NULL,
                    UNIQUE KEY link_token (token_hash),
                    KEY link_node (node_id),
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_activity} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    at DATETIME NOT NULL,
                    node_id INT UNSIGNED NULL,
                    owner_id INT UNSIGNED NULL,
                    user_id INT UNSIGNED NULL,
                    link_id INT UNSIGNED NULL,
                    action VARCHAR(24) NOT NULL,
                    detail_enc TEXT NULL,
                    ip VARCHAR(45) NULL,
                    KEY activity_node (node_id),
                    KEY activity_owner (owner_id, at),
                    KEY activity_age (at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {vault_keys} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    user_id INT UNSIGNED NOT NULL,
                    method ENUM('passphrase','passkey','recovery') NOT NULL,
                    credential_id VARCHAR(255) NULL,
                    label VARCHAR(100) NULL,
                    wrapped TEXT NOT NULL,
                    created_at DATETIME NOT NULL,
                    KEY vault_user (user_id),
                    FOREIGN KEY (user_id) REFERENCES {users}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
            ],
            // Editing documents and spreadsheets in Files, together: the changes in order (encrypted), what the stored
            // version already includes, who has a file open, and comments.
            14 => [
                "CREATE TABLE IF NOT EXISTS {file_edit_state} (
                    node_id INT UNSIGNED PRIMARY KEY,
                    generation INT UNSIGNED NOT NULL DEFAULT 1,
                    version_id INT UNSIGNED NULL,
                    seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    autosave_version_id INT UNSIGNED NULL,
                    updated_at DATETIME NOT NULL,
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_edit_ops} (
                    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    node_id INT UNSIGNED NOT NULL,
                    generation INT UNSIGNED NOT NULL,
                    client CHAR(16) NOT NULL,
                    user_id INT UNSIGNED NULL,
                    seen BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    op_enc MEDIUMTEXT NOT NULL,
                    created_at DATETIME NOT NULL,
                    KEY edit_ops_node (node_id, id),
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_edit_presence} (
                    node_id INT UNSIGNED NOT NULL,
                    client CHAR(16) NOT NULL,
                    user_id INT UNSIGNED NOT NULL,
                    can_edit TINYINT(1) NOT NULL DEFAULT 0,
                    state_enc TEXT NULL,
                    joined_at DATETIME NOT NULL,
                    seen_at DATETIME NOT NULL,
                    PRIMARY KEY (node_id, client),
                    KEY presence_seen (seen_at),
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
                "CREATE TABLE IF NOT EXISTS {file_comments} (
                    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                    node_id INT UNSIGNED NOT NULL,
                    parent_id INT UNSIGNED NULL,
                    anchor VARCHAR(200) NOT NULL DEFAULT '',
                    body_enc TEXT NOT NULL,
                    user_id INT UNSIGNED NULL,
                    created_at DATETIME NOT NULL,
                    resolved_at DATETIME NULL,
                    resolved_by INT UNSIGNED NULL,
                    KEY comment_node (node_id),
                    FOREIGN KEY (node_id) REFERENCES {file_nodes}(id) ON DELETE CASCADE
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
