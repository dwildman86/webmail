# Changes

Each release's notes, newest first. `build.sh` copies the newest section into `dist/webmail-<version>.txt`, which
GhostParse shows administrators beside **Update now**.

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
