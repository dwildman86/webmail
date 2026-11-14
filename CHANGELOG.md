# Changes

Each release's notes, newest first. `build.sh` copies the newest section into `dist/webmail-<version>.txt`, which
GhostParse shows administrators beside **Update now**.

## 1.25.0
- **Presentations**: PowerPoint files (.pptx) open in an editor in the webmail, and Files → New makes one, blank or from a template (pitch, project update, team meeting). Add slides from layouts (title, title and content, section, two content), text boxes, shapes, lines and arrows, and pictures. Move, resize and rotate them by hand, with guides that snap to the slide's centre and to other things. Format text with fonts, sizes, colours, alignment and bulleted or numbered lists. Fill and outline shapes, put things in front or behind, flip them, set each slide's background, drag slides into order, hide slides, and write speaker notes.
- **Present**: show the slides full screen, moving on with the arrow keys, the space bar or a click.
- **Edit together, live**: everyone with edit access can work on the same presentation at once, even typing in the same text box. Each person's selection shows in their colour and name, and the slide list shows who's on which slide. Changes save as real PowerPoint files, which open in PowerPoint, Keynote, LibreOffice and Google Slides.
- PowerPoint files with tables, charts, SmartArt, video, animations or slide transitions in them open to view, with Edit a copy.

## 1.24.0
- **Track changes** in documents: turn it on (Ctrl+Shift+E) and everyone's edits are marked, each person in their own colour, with who made each change and when. Deleted text stays, struck through, until someone accepts or rejects it. Go from change to change, and accept or reject one change, a selection or everything at once. Tracked changes open and save with Word files, so Word shows them too.
- **Footnotes and endnotes**: add one where the cursor is (Ctrl+Alt+F or Ctrl+Alt+D) and type its text at the foot of the document. They're numbered as you go, and saved as real Word footnotes and endnotes.
- Word files with tracked changes or footnotes now open to edit, rather than view-only. Tracked changes to formatting and to tables still open view-only, with Edit a copy.

## 1.23.0
- **Conditional formatting** in spreadsheets: highlight cells greater than, less than, between or equal to a value, text that contains something, dates (this week, last month and so on), duplicates, the top or bottom 10, or above or below average, or use a formula of your own. Data bars, colour scales and icons too. Change each rule's cells and order in Manage rules. Rules open and save with Excel files.
- **Charts**: column, bar, line, area, pie, doughnut and scatter, made from the selected cells in one click. Stack them, give them a title, choose the legend and show values. Drag to move and resize. They follow the numbers as they change, and they're real Excel charts in the saved file. Charts in Excel files you open can be edited too.
- **Pivot tables**: summarise a table by rows and columns with sums, counts, averages, maximums and minimums, on a sheet of their own. Change the fields any time, and press Refresh when the data changes. Excel works them out again when it opens the file.
- Excel files with charts, pivot tables or conditional formatting now open to edit, rather than view-only.
- **Editing together**: what you type reaches the others while you're still typing, not only when you pause. After a dropped connection, changes are sent as soon as it's back. Share and Version history open in front of the editor rather than behind it.
- Spreadsheet fixes: currency with red negatives shows its number (not a date) in the formula bar; long text runs on across empty cells at its real width; text no longer shows an apostrophe in the formula bar; and the fill handle can be dragged in the last frozen row.

## 1.22.1
- **Security fixes from an audit**: update soon.
- **Copying from this hosting account's mailboxes**: only administrators can copy any of them. Others can only copy the old mailbox with the same address as a mailbox they read here. Before, anyone signed in could copy a colleague's old email.
- **Notifications** only go to the browsers' own push services (Google, Mozilla, Microsoft and Apple), never to other addresses. Turning them off on one device can't affect anyone else's.
- **Writing together**: a colleague's part of a shared reply is cleaned to plain formatting before it's shown.
- **Documents**: links only go to web, email and phone addresses, whether they came from a file, from pasting or from someone editing with you.
- **Administrators** confirm their password (or passkey) to make someone an administrator, set someone's password or reset their two-step verification.
- Smaller fixes: a save from the editor can't skip changes made by others; two copies of one incoming email arriving at once are stored once; imports from another mail server connect only to the internet address that was checked; signing out needs the page's own token; browsers are told to keep to HTTPS; spreadsheet colours can't load outside images; and files that unpack to far more than they say are refused.
- Addresses from GhostParse without sending and receiving settings count as both, with no PHP warnings.

## 1.22.0
- **Edit documents and spreadsheets in Files**: Word (.docx), Excel (.xlsx), CSV, text and Markdown files open in an editor in the webmail. They stay real Office files, so they open in Word, Excel, LibreOffice or Google Docs as before. Nothing is installed or sent anywhere else.
- **Edit together, live**: everyone with edit access can work on a file at once. Changes appear for the others within about a second, with each person's cursor or selected cells in their colour and name. Typing in the same paragraph keeps both people's words. Changes save as you go (one browser saves for everyone), each editing session is one version in the file's history, and changes made while the connection drops are kept on the device and sent when it's back.
- **Documents**: headings, title, quotes, fonts, sizes, bold, italic, underline, strikethrough, superscript, colours and highlighting, links, bulleted and numbered lists with levels, alignment and indents, tables (rows, columns, shading, a header row), pictures (resize, align, alt text), page breaks, lines, headers and footers, A4 or Letter, portrait or landscape, margins, find and replace, word count, and printing or saving as PDF.
- **Spreadsheets**: about 160 Excel functions (SUM, IF, VLOOKUP, XLOOKUP, SUMIFS, INDEX/MATCH, dates, text, finance and more), recalculated as you type, and formulas that follow when rows and columns are inserted or deleted. Also: number formats (currency, percentages, dates, custom), fonts, colours, borders, merged cells, wrapping, alignment, several sheets, frozen rows and columns, sorting, filters, AutoSum, the fill handle (series and formulas), copy and paste with Excel and Google Sheets, resizing, find and replace, and printing.
- **Comments** on a paragraph, a cell or the whole file, with replies and resolving. People who can only view a file can comment too.
- **Files → New**: a document, spreadsheet or text file, blank or from a template (letter, meeting notes, report, CV, budget, invoice, timesheet, to-do list).
- Files with things the editor can't keep yet, such as tracked changes, macros, charts or pivot tables, open to view. You can edit a copy, or edit anyway once you've been told what would be lost; earlier versions stay in the history.
- Works on phones: the toolbar scrolls, and documents fit the screen with all their formatting.

## 1.21.0
- **Files**: documents and folders in the webmail, like OneDrive. Upload by dragging in, in pieces, so hosting upload limits don't matter. Make folders, rename, move, copy, search, download a folder as a ZIP, open images, PDFs, text, audio and video in the page, keep earlier versions, and get things back from the Bin for 30 days. Needs an active GhostParse plan; without one, what's stored can still be opened, downloaded and deleted.
- **Sharing** with a person, or with everyone who reads a mailbox, to view or to edit. A folder's sharing covers everything inside it.
- **Share links**, off until an administrator turns them on (Settings → Files). Anyone with the link can view and download, or send files into a folder (a file request). Links can have a password, an expiry and a download limit, and can be turned off. File requests never accept programs.
- **With email**: Save to Files beside attachments, Attach from Files when writing, and a link instead of an attachment that's too big to send.
- **Private vault**: files encrypted in your browser with a key the server never has, opened with a passphrase, a passkey or your recovery key. Nobody else can open them.
- **Encrypted wherever they're kept**: each file has its own key, and is sealed in 64 KB chunks (XChaCha20-Poly1305) on this server or in an S3-compatible bucket (AWS S3, R2, B2, Wasabi, Spaces, MinIO), with no SDK needed. Settings → Files chooses where, tests the bucket, and moves existing files across. It also sets storage limits, the largest file, file types not allowed and share-link rules.
- On Android, Windows and Chrome OS, a file shared to the installed webmail goes to Files.
- `php security-reset.php` also turns every share link off.

## 1.20.0
- **Sharing attacks with GhostParse**: once an hour, the firewall sends GhostParse a summary of what it refused: the attacking address, the kind of attack, how many times and when. It never sends what was in the requests, or anything about your users or email. Private addresses, your own block list and expired forms are left out. It shows GhostParse what's attacking webmail installs, the first step towards protecting every install from attacks seen on any of them.
- Turn it off under Settings → Firewall → **Share attacks with GhostParse**, which also shows when the last summary went. Nothing is blocked because of it.

## 1.19.0
- **A daily check-in with GhostParse**: once a day, the webmail tells GhostParse its version, its web address, and how many users and mailboxes it has. That's counts only, never who the people are or any email. GhostParse uses it to support installs, to know which versions are in use before releasing an update, and to tell you when email can't reach your mailboxes. To turn it off, add `'checkin' => false` to config.php.

## 1.18.0
- **Receiving, switched on for you**: connecting an address as a mailbox now also turns on receiving for its domain at GhostParse. Without it, GhostParse turns away email to the domain, even with the address's webhook set. Mailboxes connected before this update are checked once after it, and their domains turned on. If you turn receiving off again in GhostParse later, the webmail leaves it off.
- **Settings → Connect addresses → Receiving email** shows whether each domain receives here. Turn receiving on with one click, see the MX record to add, and press **Check again** after changing DNS. You'll see what GhostParse found, such as another mail server listed ahead of it, which means email never arrives here.
- Settings → Status says which of the two is missing for each mailbox.

## 1.17.0
- **Install the app, turn on notifications**: a few seconds after the inbox opens, a small card in the corner suggests what this device hasn't set up yet. On a computer, notifications for new email come first, then installing the webmail in its own window (Chrome and Edge). On a phone, the app comes first: Install on Android, and on iPhone and iPad, the steps to add it to the Home Screen, which iOS needs before it allows notifications.
- Only one card at a time, never over an open email you're writing, and nothing at all where notifications are blocked. **Not now** waits 3 days, then 2 weeks, then a month, and after that it stops asking on that device.
- Settings → Sign-in & alerts → Use it like an app: install from there any time, or turn off **Suggest the app and notifications** for all your devices.

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
