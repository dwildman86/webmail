# Webmail for GhostParse

A modern webmail you host yourself. It reads and sends email for your GhostParse addresses, stores everything
encrypted in your own MySQL database, and installs to phones and computers like an app, with passkey sign-in
(Face ID, Touch ID, Windows Hello, fingerprint) and new-mail notifications.

It runs on ordinary shared hosting: plain PHP and MySQL, no Composer, no command line, no cron jobs (one is optional, for
scheduled email on the minute: see [Send later and snooze](#send-later-and-snooze)).

## What you need

- PHP 8.1 or newer with the `sodium`, `pdo_mysql`, `curl`, `mbstring` and `openssl` extensions (most hosts have them all)
- MySQL 5.7+ or MariaDB 10.3+, and an empty database
- **HTTPS** for the webmail's address. GhostParse only delivers to `https://` webhooks, and passkeys and notifications need it.
- A GhostParse account with a verified domain and at least one email address

## Install

### On cPanel hosting, from GhostParse (about a minute)

In the GhostParse dashboard, open your domain and choose **Connect cPanel → Install webmail**. Paste your cPanel
address, username and an API token (cPanel → **Security → Manage API Tokens**). GhostParse creates the database and
its user, uploads the webmail to the folder you choose (`mail` by default) and adds the mailboxes you list. It then
gives you a one-time setup link. Open it to create your sign-in and choose your mailboxes. The installer skips the
database and GhostParse steps.

- The token is used for that one request and never stored. You can delete it in cPanel afterwards.
- The link works until setup is finished, for up to 7 days. The connection details wait in `setup-preset.php`, which the installer deletes when
  it finishes. The web server never shows that file.
- The encryption key is made by the installer on your server, as with a manual install. It never leaves your server.

### By hand

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

### From the command line, or an app installer

Softaculous, Installatron, scripts and hosts with SSH can install it in one step, without the wizard. Unzip it into
the folder, create an empty database, then run:

```sh
php install-cli.php --db-name=acme_mail --db-user=acme_mail --db-pass='…' \
  --api-key=ek_live_… --webhook-secret=whsec_… \
  --admin-email=you@example.com --admin-password='…' --base-url=https://example.com/mail
```

- Optional settings: `--db-host` (default `localhost`), `--db-port` (`3306`), `--db-prefix` (`wm_`),
  `--api-url` (`https://ghostparse.com`), `--admin-name`, `--app-name`, and `--mailboxes`.
- `--mailboxes` is `all` by default, or a comma-separated list of addresses.
- To pass everything as a file instead, use `--json=settings.json` (the same names).
- It prints JSON and exits with 0 when installed. It exits with 1 and the reason when it can't install, and with 2 when
  the options are wrong.
- It makes the same checks as the wizard and writes `config.php`. The web server never runs it: it only works from the
  command line, and `.htaccess` blocks it too.
- In PHP code, `Webmail\Installer::unattended([...])` does the same.

## Moving from your old email

Under **Settings → Import email**, copy your old email into the webmail, keeping folders, dates, and read and starred
marks.

- **Sign in with Google or Microsoft:** for Gmail, Google Workspace, Outlook.com and Microsoft 365, no app password
  needed. The sign-in goes through GhostParse, which holds the Google and Microsoft apps; the webmail keeps the access
  (encrypted) until you choose **Forget the sign-in**. The buttons only show when your GhostParse platform has set
  them up.
- **From your old provider (IMAP):** choose it (Gmail, Outlook.com, Yahoo, iCloud, your web host and others), then
  sign in. Gmail, Yahoo and iCloud need an app password. Choose where each folder goes; Trash, Spam and Gmail's All
  Mail are left out unless you choose them. Nothing on the old server is changed or deleted: it's read-only.
- **From this hosting account:** on cPanel hosting, when the webmail is installed in the same account as the old
  mailboxes, they're listed for you: choose one and its folders, no password needed. It reads the mail files directly.
- **From a file:** an `.mbox` (Google Takeout, Thunderbird, Apple Mail) or a single `.eml`, uploaded in pieces. Gmail
  labels decide each message's folder.
- It runs while the webmail is open, about 20 seconds at a time, and carries on where it stopped if you close it.
- Each message is read by GhostParse's parser, so it looks and searches like new mail and joins its conversation. It
  isn't stored at GhostParse and doesn't count towards your plan.
- **Moving your domain:** import, then point the domain's mail at GhostParse. A day later, choose **Check for new
  mail** to copy anything that reached the old mailbox in the meantime (only new messages are fetched), then
  **Forget the password**.

## Using it

- **Mailboxes and users**: under **Settings → Connect addresses**, an administrator turns more GhostParse addresses into mailboxes. Under **Settings → Users**, they add people and choose which mailboxes each person can read and send from. A shared mailbox, such as support@, can belong to several people.
- **Folders**: Inbox, Starred, Snoozed, Sent, Drafts, Scheduled, Archive, Spam and Trash, and your own labels. Conversations are grouped into threads. Email that GhostParse's spam check flags goes to Spam.
- **Labels and rules**: under **Settings → Rules & labels**, each mailbox has its own labels (folders or tags, such as *Accounting* or *Billing*) and rules that file new email as it arrives. A rule looks at the sender, recipients, subject or text (contains, doesn't contain, is, starts with, ends with), all or any of its conditions, and then moves the email (to Archive, Spam, Trash or a label), labels it, marks it read or stars it. For example: *if the sender ends with @example.com or the subject contains Invoice, move it to Accounting and label it Billing*. Rules run in order; every rule that matches labels the email, and the first one that moves it decides where it goes. Run a rule on what's in the Inbox already with **Run now**, or when you save it. Moving an email to a label takes it out of the Inbox; labelling it leaves it there. Label an email by hand with the label button on it (`l`). In a shared mailbox, everyone shares its labels and rules.
- **Snooze**: the clock on an email (`b`) hides its conversation until later today, tomorrow, the weekend, next week or a time you choose. Then it's back at the top of the Inbox, unread, with a notification. **Snoozed** lists what's waiting.
- **Search**: searches senders, recipients, subjects and message text. It works on the encrypted data (see below).
- **From name**: email goes out under the sender's own name, unless the mailbox has a name of its own (set it under **Settings → Mailboxes**, for example *Acme Support* for a shared mailbox).
- **Undo send**: after you press Send, the email waits 10 seconds with **Undo** (change it, or choose 5, 20 or 30 seconds, or none, under **Settings → Account**). The wait happens in your browser: close the page during it and the email isn't sent; it's in Drafts (the browser asks first).
- **Send later**: the clock beside Send sends the email tomorrow morning, tomorrow afternoon, Monday morning or when you choose. **Scheduled** lists what's waiting: send it now, change the time, take it back to edit, or delete it. If it can't be sent (an address refused, say), it stays there marked *not sent*, with the reason, and you're notified.
- **Templates**: replies you write often, with formatting and placeholders: `{first_name}`, `{last_name}`, `{name}`, `{email}`, `{company}`, `{ticket_id}`, `{subject}`, `{my_name}`, `{my_first_name}`, `{my_email}` and `{date}`. While writing, type `/` and the template's shortcut or name (`/refund`), press `Ctrl+/` (`⌘/` on a Mac), or use the Templates button. Placeholders are filled in from the first recipient (their name and company from your contacts), you, and the conversation (`{ticket_id}` is the conversation's reference, the same for everyone replying to it). One that can't be filled in stays as it is, and Send asks before it goes. Make them under **Settings → Templates**: your own, and shared ones that administrators keep for everyone.
- **Writing**: rich text, attachments up to 20 MB, Cc and Bcc, address suggestions from people you've written to, and a signature per mailbox.
  The signature is the address's on GhostParse, so it's the same wherever the address's email is sent from (here,
  your website, your shop):
  - Under **Settings → Mailboxes**, set the From name, position and signature, with a preview.
  - Administrators also set the domain's disclaimer there.
  - While writing, the signature shows under the message, with a switch to leave it out of that email.
  - Signatures from before 1.5.0 move to GhostParse by themselves, unless the address already has one there. Replies keep the thread together in the recipient's mail app too.
- **Contacts**: two address books. **My contacts** is private to each person. **Shared** is seen by everyone, and administrators keep it up to date. Add contacts by hand, with **Add to contacts** on any email, or by importing a **.vcf** or **.csv** file from Gmail, Outlook, iPhone or Android. Importing fills in missing details for contacts you already have and never overwrites them. Export either book as a .vcf file. When you write an email, names and addresses are suggested from both books, then from people you've written to before.
- **Customer panel**: the person button above an email (or `i`) shows who it's with: every conversation with them in the mailboxes you can read, with where each is up to and who has it, how many there have been and since when, their address book entry, and the fields GhostParse's parsers found in their email (an order number, a customer id, a plan), newest first. Click a conversation to open it. To get fields, give the address a parser in GhostParse (Parsers).
- **Calendar**: see *Calendar* below.
- **Keyboard**: `c` compose, `/` search, `j`/`k` next/previous, `r` reply, `f` forward, `e` archive, `#` delete, `b` snooze, `l` labels, `i` the customer panel, `Esc` close.

### Calendar

**Calendar** in the side menu (on phones, in the bottom bar).

- **Views**: Day, Week, Month and Schedule (what's coming, day by day: the first view on phones). `t` today, `d` `w` `m` `s` the views, `←` `→` back and forward (or swipe on a phone), `n` a new event.
- **Making events**: drag down the hours in the day or week view to make an event that long, click a day in the month, or **New event**. Drag an event to move it to another time or day, and drag its bottom edge to change when it ends. On phones, tap a time.
- **Events** have a place (a video call link opens with a click), notes, a colour, and reminders as notifications (turn notifications on under **Settings → Sign-in & alerts**). They can repeat: every day, every weekday, weekly on chosen days, every 2 weeks, monthly on a date or on, say, the second Tuesday, yearly, or your own pattern, until a date or a number of times. Change or delete one occurrence, that one and the ones after it, or all of them. A weekly 9:00 meeting stays at 9:00 when the clocks change.
- **Your calendars**: everyone has *My calendar*, and can add more (*Family*, *Gym*). Tick a calendar to show or hide it.
- **Shared calendars**: holidays, rotas, meeting rooms. Whoever makes one chooses who's on it and whether each person can change it or only see it; they're told when they're added. Everyone on it sees changes, with who added each event, and gets its reminders. Its owner and administrators can rename it, change who's on it or delete it; anyone else can leave it.
- **Invitations in email**: an email with a calendar file (an invitation from Outlook, Google or Apple, or any `.ics`) shows what it is, with **Add to calendar**. Adding it again later updates it rather than doubling up.
- **Import and export**: a calendar's menu (`…` beside it) imports a `.ics` file (from Google Calendar, Outlook or Apple) and downloads one.
- **On your phone or computer's own calendar**: a calendar's menu → **On your phone or computer** gives a private link to subscribe to in Apple Calendar, Google Calendar or Outlook. It's read-only there and updates every few hours (it's up to the app). Anyone with the link can see the calendar, so keep it to yourself; make a new one there if it gets out, and the old one stops working.

Reminders are sent with the rest of the webmail's due work (see the next section): for reminders on time when nobody has the webmail open, add the `due.php` cron job.

### Send later and snooze

Shared hosting often has no cron, so the webmail sends scheduled email, brings back snoozed email and sends calendar reminders by itself: whenever
someone is using it (the page checks every 30 seconds) and whenever email arrives. On a quiet webmail that nobody has
open, that can be a little after the time. For exact times, add a cron job that calls `due.php` every minute (cPanel →
**Cron Jobs**):

```
* * * * * curl -fsS https://your-site/mail/due.php >/dev/null
```

It only does what's already due, so it's safe for anyone to call. An email that was being sent when the server stopped
part-way is never sent twice: it's marked *not sent*, to check in Sent first.

### On your phone and computer

- **Install as an app**: in Chrome or Edge, use *Install* in the address bar. On Android, choose *Add to Home screen*. On iPhone or iPad, tap *Share*, then *Add to Home Screen*.
- **Two-step verification**: the first time you sign in, you set up an authenticator app (scan the QR code) or a passkey, and save your recovery codes. After that, each sign-in asks for a code from the app, or you use your passkey.
- **Passkeys**: **Settings → Sign-in & alerts → Add a passkey**. After that, sign in with your face, fingerprint or device PIN: choose *Sign in with Face ID* (or *with a passkey*, *Windows Hello*…) on the sign-in page, or pick the passkey your keyboard suggests in the email box. In the installed app, a device that has used its passkey asks for Face ID straight away. Your fingerprint or face never leaves the device. Passwords keep working too.
- **Notifications**: **Settings → Sign-in & alerts → Turn on**, once on each device. You're told about new email in your inboxes, even when the webmail is closed. In the installed app they keep coming even after you sign out (it's your own device); in a browser tab, signing out turns them off, in case it's a shared computer. On iPhone and iPad, this works from the Home Screen app (iOS 16.4 or newer).
- **Notification buttons**: new-mail notifications have **Mark as read** and **Reply**, and **Archive** where the device shows a third button. They work without opening the webmail. On Chrome and Edge (Windows, Mac, Linux, Android) you can type the reply in the notification and it's sent from the mailbox the email came to, in the same thread; elsewhere Reply opens the reply window. If a reply typed in a notification can't be sent (no connection, or the notification is more than 7 days old), a notification says so, and tapping it opens the reply with your text in it. A notification's buttons only act on its own email, for its own person, and stop working when that person's password changes. iPhone and iPad don't show notification buttons: tapping opens the email.
- **On your phone**: quick buttons along the bottom: Inbox (with its unread count), Calendar, Compose (a new event, in the calendar), Contacts, and More for every other folder and Settings. Tap the open folder again to go back to the top.
- **Swipe on your phone**: swipe an email right to delete it, or left to archive it, with Undo.
- **Where you're signed in**: **Settings → Sign-in & alerts** lists each browser and installed app you're signed in on, where from and when it was last used. **Sign out** one you don't recognise or have lost (its notifications stop too), or everywhere else. Administrators can do the same for anyone, under **Users → Devices**.
- **Offline**: the app opens without a connection and shows the mail you've already opened on that device. Signing out clears it.

## Security settings (administrators)

**Settings → Security**:

- **Trusted networks**: *Administration only from* your office's and VPN's addresses (elsewhere, administrators can read and send their email but not change settings or users), and *Everyone only from* (signing in and using the webmail at all). One IP address or range a line: `203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32`. A person can have their own instead, under **Users → Edit** (*Only from these networks*). Someone signed in who leaves them is signed out at their next click, with the reason. The page shows your address now: a setting that would lock you out isn't saved. Behind a proxy or Cloudflare, the webmail sees the proxy's address, so limits by network won't work there.
- **Passkeys only**: for administrators, or everyone. Nobody it applies to can sign in with a password; they use a passkey (Face ID, Touch ID, Windows Hello, a fingerprint, or a security key). Someone without one yet signs in with their password and second step once and must add a passkey before anything else. Changes that ask for your password ask for your passkey instead. You need a passkey yourself to turn it on, and the webmail on https://. Lost passkey: **Users → Edit → Reset two-step verification**, and they add a new one at their next sign-in.

Saving either asks for your password (or passkey). Locked out anyway (the office's address changed, say)? On the server, in the webmail's folder: `php security-reset.php` turns both off (`--user=you@example.com` also clears that person's own networks).

## Data requests (GDPR)

When someone asks for the personal data you hold about them (a subject access request), the webmail finds every
email about them and exports it as one ZIP file.

**What it searches.** Every mailbox (or the ones you name) and every folder, Drafts, Spam and Trash included. An email
is found when the person's address is its sender or a recipient (To, Cc, Bcc, Reply-To), or when the address or one of
your extra terms (their name, a phone number, a customer number) is in its subject, its text or an attachment's name.
The search index finds most matches at once. Then every message is decrypted and checked, so text past the index's reach isn't missed: the end of a long
email, a quoted reply. Attachment contents (PDFs, images) aren't searched, but a matching email's attachments are
exported with it.

**What the ZIP holds.** `README.txt` (what was searched, and when), `messages.csv` (one row per email: date, mailbox,
folder, people, subject and where the person was found), each email as `message.txt` and `message.html` with its
attachments, `contacts.json` (their address book entries, and who has emailed them) and `team-notes.json` (your team's
notes on those conversations). The emails may hold other people's personal data, so check the export and redact it
before you send it (GDPR article 15(4)).

**Keeping it.** Results are kept for 30 days, or until they're removed, then deleted. The record of the request stays
(who asked, when, how many emails, when it was downloaded) as evidence that it was answered.

**By hand.** Administrators: **Settings → Data requests**, then enter the address and press **Search**. Then press
**Download ZIP**.

### From another system: a "GDPR request" button

Your CRM, help desk or website can do the same with an API key. Make one under **Settings → Data requests → From
another system**. You can limit it to your system's IP addresses. The key is shown once; only a keyed hash of it is
stored. Send it as `Authorization: Bearer wmk_…`. Where the hosting drops that header, use `X-Api-Key: wmk_…`.

| Call | What it does |
|---|---|
| `POST api.php?a=data-requests` | Start a request. JSON: `email` (required), `terms` (array, optional), `mailboxes` (array of addresses; all by default), `since` / `until` (dates), `reference` (yours, such as a ticket number), `include_attachments` (default `true`). Answers `201` with the request. |
| `GET api.php?a=data-requests&id=dr_…` | The request: `status` is `searching`, `ready` or `expired`. While it's `searching`, each call carries on with the search for up to 20 seconds and reports `progress` (`scanned` of `total`). When it's `ready`, it lists the matching emails. |
| `GET api.php?a=data-requests/export&id=dr_…` | The ZIP file. `409` while it's still searching, `410` once the results have been removed. |
| `POST api.php?a=data-requests/discard&id=dr_…` | Remove the results now (the request has been answered). The record stays. |
| `GET api.php?a=data-requests` | This key's recent requests. |

A key sees only the requests it made. Each key can have up to 5 searches running at once.

```php
<?php
// "GDPR request" button: start the search, wait for it, save the ZIP.
$base = 'https://example.com/mail/api.php';
$key  = getenv('WEBMAIL_DATA_REQUEST_KEY'); // wmk_…
function call(string $url, string $key, ?array $body = null): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 120,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key, 'Content-Type: application/json']]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body)); // a POST
    }
    $res = curl_exec($ch);
    return [curl_getinfo($ch, CURLINFO_HTTP_CODE), $res];
}
[, $res] = call("$base?a=data-requests", $key, ['email' => $customer->email, 'terms' => [$customer->name, $customer->phone], 'reference' => "DSAR-{$ticket->id}"]);
$request = json_decode($res, true);
while ($request['status'] === 'searching') {
    [, $res] = call("$base?a=data-requests&id={$request['id']}", $key);
    $request = json_decode($res, true);
}
[$status, $zip] = call("$base?a=data-requests/export&id={$request['id']}", $key);
file_put_contents("dsar-{$ticket->id}.zip", $zip); // review it, then send it to the customer
```

With curl:

```sh
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"jane@example.com","terms":["Jane Doe"],"reference":"DSAR-42"}' 'https://example.com/mail/api.php?a=data-requests'
curl -s -H "Authorization: Bearer $KEY" 'https://example.com/mail/api.php?a=data-requests&id=dr_…'          # until "ready"
curl -s -H "Authorization: Bearer $KEY" -o dsar-42.zip 'https://example.com/mail/api.php?a=data-requests/export&id=dr_…'
```

## Security

- **Encrypted at rest.** Senders, recipients, subjects, message bodies, attachments, names, email addresses, contacts and address books, push subscriptions and passkeys are encrypted in the database with XChaCha20-Poly1305 (libsodium). Each value is bound to its column, so values can't be swapped between columns. Someone with a copy of the database sees only ciphertext.
- **Encrypted search.** Searching uses keyed blind indexes (HMAC-SHA-256) of words, never the words themselves.
- **The key lives in `config.php`**, outside the database. It's created at install, and its file permissions are set to 0640. Keep a backup of the file somewhere safe.
- **Two-step verification is required for everyone.** After their password, people enter a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others) or use a passkey. Anyone without one, including existing users after an update, sets it up at their next sign-in, before they can see any mail. Each person gets ten one-time recovery codes for a lost phone. An administrator can reset someone's two-step verification under **Settings → Users**, which also signs them out everywhere. The authenticator secret is stored encrypted, and recovery codes only as keyed hashes.
- **Staying signed in**: you stay signed in while you use the webmail, and are signed out after 30 days without opening it. Sessions are kept in the webmail's own database (only a hash of each session's id, with its contents encrypted), so a host's clean-up of PHP's session files doesn't sign anyone out.
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
location ~ ^/mail/(config\.php|config\.php\.tmp|setup-preset\.php|install-cli\.php|security-reset\.php|\.user\.ini|composer\.(json|lock)|phpunit\.xml|README\.md|build\.sh)$ { deny all; }
location = /mail/sw.js { add_header Cache-Control "no-cache"; }
client_max_body_size 48m;
```

Also set `post_max_size = 48M` and `upload_max_filesize = 32M` in PHP-FPM, if `.user.ini` isn't read.

## Updating

**With one click (1.8.0 and later):** when GhostParse has a new version, administrators are told when they sign in,
and **Settings → Status** shows the new version and what's new, with **Update**. It asks for your password, then
downloads the zip from GhostParse (`<api_url>/downloads/webmail-latest.json` says which, with its SHA-256), checks
it, and copies the new files over these ones:

- From 1.8.1, only a release signed with GhostParse's release key is installed. The key is kept off GhostParse's
  servers; the webmail holds its public key (`Updater::RELEASE_KEYS`), and the signature covers the version and the
  zip's SHA-256. So even someone who took over GhostParse's server or domain couldn't push code to your webmail.

- `config.php`, `setup-preset.php` and `storage/` are never replaced.
- Each file that's replaced is kept in `storage/updates/backup-<old version>/`. If a copy fails part way, every file
  is put back as it was.
- The database is brought up to date the next time anyone opens the webmail, as after a manual update.
- It needs PHP's zip extension and the webmail's folder writable by the web server. If either is missing, Status says
  so, and you update by hand.

**By hand:** upload the new version's files over the old ones, keeping your `config.php`. Database changes are
applied automatically the next time anyone opens the webmail.

**Releasing (for the GhostParse platform):** add the version's notes to `CHANGELOG.md`, set the version in
`app/App.php` and `sw.js`, then on the platform run `sh deploy/publish-webmail.sh /path/to/webmail` (it signs the zip with the
release key, so run it where that key is), commit, package
and deploy. Installed webmails see it within 12 hours, or straight away with **Check again**.

## Troubleshooting

- **No email arrives.** Check **Settings → Status**. In GhostParse, look at the address's webhook delivery log: a `400 invalid_signature` means the signing secret in `config.php` doesn't match.
- **"Not sent: …"** The message comes from GhostParse. Usually the address can't send yet: its domain still needs its SPF and DKIM records verified.
- **Big attachments fail.** Raise `post_max_size`, `upload_max_filesize` and `memory_limit` with your host. You can also set the address in GhostParse to deliver attachments as separate parts, or through storage links.
- **Locked out.** An administrator can set a new password under **Settings → Users**.
- **Lost phone.** Sign in with one of your recovery codes, then set up your authenticator app again under **Settings → Sign-in & alerts**. No recovery codes left? An administrator can reset your two-step verification under **Settings → Users**.
- **"That code didn't work".** Authenticator codes depend on the time: make sure your phone sets its clock automatically.

## Development

```sh
composer install
TEST_DB_DSN=mysql://user:pass@127.0.0.1:3306 vendor/bin/phpunit
php -S localhost:8080
sh build.sh   # makes dist/webmail-<version>.zip
```

Each test gets its own throwaway database, so the MySQL user needs permission to create and drop databases.
