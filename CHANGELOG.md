# Changes

Each release's notes, newest first. `build.sh` copies the newest section into `dist/webmail-<version>.txt`, which
GhostParse shows administrators beside **Update now**.

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
