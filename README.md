# Webmail for GhostParse

A modern webmail you host yourself. It reads and sends email for your GhostParse addresses, stores everything
encrypted in your own MySQL database, and installs to phones and computers like an app, with passkey sign-in
(Face ID, Touch ID, Windows Hello, fingerprint) and new-mail notifications.

It runs on ordinary shared hosting: plain PHP and MySQL, no Composer, no command line, no cron jobs.

## What you need

- PHP 8.1 or newer with the `sodium`, `pdo_mysql`, `curl`, `mbstring` and `openssl` extensions (most hosts have them all)
- MySQL 5.7+ or MariaDB 10.3+, and an empty database
- **HTTPS** for the webmail's address. GhostParse only delivers to `https://` webhooks, and passkeys and notifications need it.
- A GhostParse account with a verified domain and at least one email address

## Install

1. Download the latest `webmail-x.y.z.zip` and unzip it.
2. Upload the folder to your hosting, for example to `public_html/mail`. It works in a subfolder or on its own subdomain.
3. In your hosting control panel, create a MySQL database and a user for it.
4. In the GhostParse dashboard:
   - **API keys**: create a key with the **send** and **domains** scopes.
   - **Inbound webhook → Signing secret**: copy it (it starts with `whsec_`).
5. Open `https://your-site/mail/` in your browser. The installer starts and walks you through:
   1. **Check**: it confirms your hosting has what's needed.
   2. **Database**: enter the database details.
   3. **GhostParse**: paste the API key and signing secret.
   4. **Administrator**: create your own sign-in.
   5. **Mailboxes**: choose which GhostParse addresses to use here. Each chosen address can send and receive, and its webhook is pointed at this webmail for you.
6. When it's done, the installer locks itself. **Back up `config.php`**: it holds the encryption key, and without it the stored mail can't be read.

If the folder isn't writable, the last step shows the contents of `config.php` for you to upload yourself.
If the last step fails, the installer removes what it created, so you can fix the problem and try again.

## Using it

- **Mailboxes and users**: under **Settings → Connect addresses**, an administrator turns more GhostParse addresses into mailboxes. Under **Settings → Users**, they add people and choose which mailboxes each person can read and send from. A shared mailbox, such as support@, can belong to several people.
- **Folders**: Inbox, Starred, Sent, Drafts, Archive, Spam and Trash. Conversations are grouped into threads. Email that GhostParse's spam check flags goes to Spam.
- **Search**: searches senders, recipients, subjects and message text. It works on the encrypted data (see below).
- **Writing**: rich text, attachments up to 20 MB, Cc and Bcc, address suggestions from people you've written to, and a signature per mailbox. Replies keep the thread together in the recipient's mail app too.
- **Keyboard**: `c` compose, `/` search, `j`/`k` next/previous, `r` reply, `f` forward, `e` archive, `#` delete, `Esc` close.

### On your phone and computer

- **Install as an app**: in Chrome or Edge, use *Install* in the address bar. On Android, choose *Add to Home screen*. On iPhone or iPad, tap *Share*, then *Add to Home Screen*.
- **Passkeys**: **Settings → Sign-in & alerts → Add a passkey**. After that, choose *Use a passkey* on the sign-in page to sign in with your face, fingerprint or device PIN. Your fingerprint or face never leaves the device. Passwords keep working too.
- **Notifications**: **Settings → Sign-in & alerts → Turn on**, once on each device. You're told about new email in your inboxes, even when the webmail is closed. On iPhone and iPad, this works from the Home Screen app (iOS 16.4 or newer).
- **Offline**: the app opens without a connection and shows the mail you've already opened on that device. Signing out clears it.

## Security

- **Encrypted at rest.** Senders, recipients, subjects, message bodies, attachments, names, email addresses, contacts, signatures, push subscriptions and passkeys are encrypted in the database with XChaCha20-Poly1305 (libsodium). Each value is bound to its column, so values can't be swapped between columns. Someone with a copy of the database sees only ciphertext.
- **Encrypted search.** Searching uses keyed blind indexes (HMAC-SHA-256) of words, never the words themselves.
- **The key lives in `config.php`**, outside the database. It's created at install, and its file permissions are set to 0640. Keep a backup of the file somewhere safe.
- **Passwords** are hashed with Argon2id. Sign-in attempts are limited per IP address and per account, and sessions use HttpOnly, SameSite cookies with CSRF tokens.
- **Email is shown safely.** Each message is displayed in a sandboxed frame with no scripts, under a strict Content Security Policy. Remote images are blocked until you click *Show images*, so senders can't tell when you've opened a message. Attachments are always downloaded and never displayed in the page. Email that fails SPF, DKIM and DMARC is marked as an unverified sender.
- **Only GhostParse can deliver mail here.** `webhook.php` accepts only events signed with your signing secret, sent within the last five minutes, and processes each one only once. Attachments sent separately are checked against the signed event.

### Rotating the GhostParse signing secret

Put the new secret in `config.php` under `ghostparse.webhook_secret`, and the old one under
`ghostparse.previous_webhook_secret` until GhostParse's rotation finishes. Both are accepted during that time.

## nginx

Apache and LiteSpeed use the included `.htaccess` files. On nginx, add this to the site, with `/mail` as the folder the webmail is in:

```nginx
location ~ ^/mail/(app|storage|tests|vendor)/ { deny all; }
location ~ ^/mail/(config\.php|config\.php\.tmp|\.user\.ini|composer\.(json|lock)|phpunit\.xml|README\.md|build\.sh)$ { deny all; }
location = /mail/sw.js { add_header Cache-Control "no-cache"; }
client_max_body_size 48m;
```

Also set `post_max_size = 48M` and `upload_max_filesize = 32M` in PHP-FPM, if `.user.ini` isn't read.

## Updating

Upload the new version's files over the old ones, keeping your `config.php`. Database changes are applied
automatically the next time anyone opens the webmail.

## Troubleshooting

- **No email arrives.** Check **Settings → Status**. In GhostParse, look at the address's webhook delivery log: a `400 invalid_signature` means the signing secret in `config.php` doesn't match.
- **"Not sent: …"** The message comes from GhostParse. Usually the address can't send yet: its domain still needs its SPF and DKIM records verified.
- **Big attachments fail.** Raise `post_max_size`, `upload_max_filesize` and `memory_limit` with your host. You can also set the address in GhostParse to deliver attachments as separate parts, or through storage links.
- **Locked out.** An administrator can set a new password under **Settings → Users**.

## Development

```sh
composer install
TEST_DB_DSN=mysql://user:pass@127.0.0.1:3306 vendor/bin/phpunit
php -S localhost:8080
sh build.sh   # makes dist/webmail-<version>.zip
```

Each test gets its own throwaway database, so the MySQL user needs permission to create and drop databases.
