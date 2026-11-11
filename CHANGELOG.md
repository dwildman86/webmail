# Changes

Each release's notes, newest first. `build.sh` copies the newest section into `dist/webmail-<version>.txt`, which
GhostParse shows administrators beside **Update now**.

## 1.16.0
- **Firewall** (administrators: Settings → Firewall): the webmail checks every request before answering it, for hosting without a firewall of its own. Attacks in addresses and headers (SQL injection, scripts, reading server files, running commands, Log4Shell, Shellshock) are refused; attack tools, made-up requests and other websites posting here are too. Wrong passwords and floods of requests add up, and an address that keeps at it is blocked for 15 minutes, then an hour, then a day. It never reads the email people write or receive, or what they search for.
- See what it's refused and blocked, unblock or block an address, keep lists of addresses to always allow and always block, and try it in monitoring mode first. Administrators' own addresses and the trusted networks are never blocked.
- **Behind Cloudflare or another proxy**: say so under Settings → Firewall, and the firewall, trusted networks and the list of where people are signed in all see each visitor's own address.
- `php security-reset.php` also clears the firewall's blocks.

## 1.15.0
- **Forgot the attachment?** If your email says "see attached", "I've included…", "please find enclosed" and the like but nothing is attached, Send asks first: attach a file, or send it anyway. Only what you wrote counts, not the email you're replying to.
- **Cc that should be Bcc?** When people outside your organisation who may not know each other (different companies, or personal addresses like Gmail) are in Cc, Send asks whether to move them to Bcc, so they don't see each other's addresses. Not asked for colleagues, or on a reply to people already in the conversation.
- Turn either off under Settings → Account → Before sending. Both also apply to Send later.

## 1.14.0
- **Customer panel** beside every email: who it's with, every conversation with them in the mailboxes you can read (where each is up to, and who has it), how many there have been and since when, their address book entry, and the fields GhostParse's parsers found in their email (order number, customer id, plan…), newest first. Open it with the person button above the email or `i`; it stays open on wide screens, and slides over the email on smaller ones. Email from before this version is added to it in the background over the first few minutes.
- **Where you're signed in**: Settings → Sign-in & alerts lists every browser and installed app you're signed in on, from where and when it was last used. **Sign out** one (it needs your password or passkey again, and its notifications stop), or everywhere else at once. Administrators see anyone's under Users → Devices.
- **Trusted networks** (administrators: Settings → Security): administration only from your office or VPN (elsewhere, administrators can still read their email), everyone only from some networks, or one person only from theirs (Users → Edit). Someone who leaves them is signed out at their next click. You can't save a setting that would lock you out.
- **Passkeys only** (Settings → Security): no passwords for signing in, for administrators or for everyone, just Face ID, Touch ID, Windows Hello or a fingerprint. Someone without a passkey yet signs in with their password once and adds one straight away. Changes that asked for your password ask for your passkey instead. Lost one? An administrator resets the person's two-step verification and they add a new one.
- Locked out by either? On the server: `php security-reset.php`.
- Fixed: a shared mailbox's list could fail to load when two emails of one conversation were both in it.

## 1.13.0
- **Calendar**: Day, Week, Month and Schedule views, in the side menu (and the bottom bar on phones). Drag down the hours to make an event, drag it to move it, drag its edge to change when it ends. Events have a place (video call links open with a click), notes, a colour and reminders as notifications, and repeat daily, on weekdays, weekly on chosen days, monthly on a date or on the second Tuesday (say), yearly, or your own way. Change or delete just one occurrence, it and the ones after, or all. Weekly meetings stay at the same time when the clocks change.
- **Shared calendars** for the team: holidays, rotas, meeting rooms. Choose who's on each and whether they can change it or only see it; everyone gets its reminders and sees who added what. Your own calendars stay yours: *My calendar*, and any more you make.
- **Invitations**: an email with a calendar invitation (from Outlook, Google or Apple) shows what it is, with **Add to calendar**.
- **On your phone's own calendar**: a private link to subscribe to each calendar in Apple Calendar, Google Calendar or Outlook. Import and download `.ics` files too.
- Data requests (GDPR) include calendar events that mention the person.

## 1.12.0
- **Data requests (GDPR)**: find and export everything about one person for a subject access request. Every mailbox and folder is searched, Trash and Spam too: email they sent or received, and email that mentions their address or other terms you give (name, phone, customer number). Every message is checked, not just the search index. The ZIP has each email with its attachments, a spreadsheet of them, their address book entries and your team's notes on those conversations. Administrators: Settings → Data requests. Results are kept for 30 days; the record of each request stays.
- **For your CRM or help desk**: a "GDPR request" button can start the search and download the ZIP itself, with an API key made under Settings → Data requests (it can be limited to your system's IP addresses). See the README.

## 1.11.0
- **Buttons on new-mail notifications**: Mark as read and Reply (and Archive, where your device has room for a third), straight from the notification, without opening the webmail. On Chrome and Edge you type the reply in the notification itself; elsewhere Reply opens the reply window. If a reply can't be sent from the notification, you're told, and tapping opens it with what you wrote. (iPhone and iPad don't show notification buttons: tapping opens the email, as before.)
- Tapping a notification while the webmail is already open now shows that email there.

## 1.10.0
- **Templates**: replies you write often, with formatting and placeholders such as {first_name}, {company} and {ticket_id}, filled in from the email you're writing. Type / and a template's shortcut while writing (/refund), press Ctrl+/ (⌘/ on a Mac), or use the Templates button. Your own under Settings → Templates, and shared ones administrators keep for everyone. A placeholder that can't be filled in is pointed out before the email goes.
- **Undo send**: after Send, the email waits 10 seconds with Undo, to take it back and change it. Choose 5, 20 or 30 seconds, or none, under Settings → Account.
- **Send later**: the clock beside Send sends it tomorrow morning, Monday or whenever you choose. Scheduled lists what's waiting: send it now, change the time, edit it or delete it. You're notified if one can't be sent.
- **Snooze**: hide a conversation until later today, tomorrow, the weekend, next week or a time you choose. It comes back to the top of the Inbox, unread. Snoozed lists what's waiting.
- **Labels and rules**: your own folders and tags for each mailbox, and rules that file new email as it arrives: "if the sender ends with @example.com or the subject contains Invoice, move it to Accounting and label it Billing". Rules can also mark read and star, run in order, and can be run on the Inbox now. Settings → Rules & labels.
- For exact times on scheduled email when nobody has the webmail open, a cron job can call due.php every minute (optional; see the README).

## 1.9.0
For shared mailboxes (ones more than one person reads):
- **Team notes** on every conversation: private comments only the people who share the mailbox see, never sent to the customer. Type @ to mention someone ("@Sarah please process their refund"); they get a notification and the note stands out for them.
- **Assignment and status**: assign a conversation to anyone on the mailbox (or Take it yourself) and mark it Open, In progress or Resolved. The list shows who has each one, and can show just yours, the unassigned ones, or one status. The person it's assigned to is notified. A resolved conversation reopens by itself when the customer writes again. Every change is noted on the conversation.
- **Write together**: a reply two or more people write at once. Everyone sees each change within a couple of seconds, with who else has it open and who's typing; edits made at the same time are merged (different paragraphs, or different parts of one). Anyone can send it, and it closes for everyone.
- Fixed: on computers, the phone's quick buttons showed under the mailbox.

## 1.8.6
- Drafts save themselves as you type: on your device straight away (so a crash, a closed tab or a dropped connection doesn't lose them), and to Drafts on the server a few seconds after you stop. Offline, they're kept on the device and saved when you're back online, in the background where the browser can (Chrome, Edge, Android) or when the webmail next opens. Drafts left unsaved are put back in Drafts, attachments included on the device they were written on. Closing the window saves it; signing out saves drafts to the server first, then removes them from the device.
- The installed app's icon shows how many unread emails are in your inboxes (iPhone and iPad with notifications on, Mac and Windows), and new-mail notifications update it even when the app is closed.

## 1.8.5
- Create new email addresses while installing: the Mailboxes step has an Add a new address form (any of your GhostParse domains), and the new address is made at GhostParse, able to send and receive, and ticked.
- The same in Settings → Connect addresses, for administrators: a new address is made and connected as a mailbox in one go.

## 1.8.4
- On phones, the strip behind the status bar matches the app (white, or dark in dark mode) instead of blue.

## 1.8.3
- On iPhones, the installed app's top bars sit below the status bar instead of under it, and the email's buttons are clearer and easier to tap.

## 1.8.2
- On phones, swipe an email right to delete it or left to archive it, with Undo.

## 1.8.1
- Updates are signed: the webmail only installs a release signed with GhostParse's release key.

## 1.8.0
- Update with one click: administrators see when a new version is out, and update it under Settings → Status.
- Release notes like these, shown before you update.

## 1.7.5
- You stay signed in while you use the webmail (30 days from the last time you opened it).
- Signing out of the installed app no longer turns off its notifications.

## 1.7.4
- Quick buttons along the bottom on phones: Inbox, Sent, Compose, Contacts and More.

## 1.7.3
- Email shown dark in dark mode.
- Settings tabs that fit on a phone, and tapping outside the menu closes it.
- Addresses in emails no longer show as "[email protected]" behind Cloudflare.

## 1.7.2
- Email goes out under the sender's own name.
- Sign in with Face ID, Touch ID or Windows Hello, offered on the sign-in page.
