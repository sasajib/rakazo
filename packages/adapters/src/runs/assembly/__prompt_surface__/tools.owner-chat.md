# Tool surface: owner-chat
67 tools, 81307 bytes of definitions

## add_mcp_server
Connect a remote MCP tool server to this Space when the user asks you to add one and provides the details (URL, optional token/headers). The server is created immediately and an approval card appears in the chat; its tools reach you once the user approves it there. Do not invent endpoints; only use details the user provided. Local (stdio) servers can only be added by an admin in Settings.
schema 65fab3a1ebc3 (746 bytes)

## archive_bot
Archive a bot in this space, yourself included. Archiving stops its work and routines, hides it from the active list, and preserves its conversation, memory, and files for the user to restore or delete later. confirm_name must exactly match its name. Archiving yourself ends your work once this reply is sent.
schema 46b1a82a67f6 (283 bytes)

## ask_user
Ask the user one short multiple-choice question with tappable options, then wait for their selection. Use this instead of asking them to type when two to four concise choices are enough. Put the content the user is deciding about, such as a draft email, in `detail`.
schema 83d75c04a577 (282 bytes)

## attach_file
Attach a workspace file from this bot's home to the chat thread as an image or common file. The user sees it. The file stays in place; users can open it from the message and from the Artifacts tab. For a self-contained HTML page, document, or anything else meant to be viewed on its own — give it name and description: a title and a one-line summary. Skip them for an ordinary attachment like a log file or export. To UPDATE something you already made, call this again with the exact same name — it becomes a new version of that same artifact instead of a separate one; a different name always starts a new artifact.
schema e33890e83dfe (134 bytes)

## bot_queue
Look at a bot's work queue: what it is doing now and what waits (age, lane, who asked, first words). Check it before assigning work so you do not send a duplicate, and to see why a report has not arrived. Defaults to your own queue.
schema 1b4667ec0868 (195 bytes)

## complete_reminder
Complete one reminder in exactly one list on the owner's phone. Use list_reminders to resolve both ids.
schema ebe36508411c (432 bytes)

## connect_app
Show an inline card to connect an app in this chat when you need an unconnected app or the user asks to connect one. Then wait for the user instead of directing them elsewhere.
schema 91d91865c03f (134 bytes)

## create_calendar_event
Create an event in one explicitly chosen writable calendar. Use list_calendars for its exact reference. Timed events use offset ISO timestamps and an IANA time zone. All-day events use dates with an exclusive end. Supports daily or weekly recurrence. If the selected calendar is unavailable, ask before choosing another. If the result is uncertain, check before trying again.
schema 75b3680fe686 (2641 bytes)

## create_child_routine
Schedule a routine that wakes a bot in this space in its own thread. Identify it by bot_id or bot_name (exact). Repeats: cron or every/unit (min 1 minute). One-shot: runAt, delayMinutes, or delaySeconds. on: events, as in schedule_create.
schema 0f312a5c4d94 (11196 bytes)

## create_group
Create a group of 2 to 10 of this user's bots. Pass bot_ids or bot_names (exact).
schema 71cd393873ae (228 bytes)

## create_reminder
Create a reminder in exactly one writable list on the owner's phone. Use list_reminders to resolve the list.
schema 0c36eacc91b0 (969 bytes)

## create_space
Propose a new space in the current organization when the user asks for a separate data boundary. A space can contain many bots and groups, but its chats, files, memory, tools, and integrations stay isolated from other spaces. Creating the space is the whole action; do not create bots in it unless the user asks later.
schema 5eceeb7f6c99 (169 bytes)

## delete_shared_memory
Delete a Space shared memory document when the user asks. MEMORY.md cannot be deleted; save it with new content instead.
schema f07d552b6614 (129 bytes)

## feedback
Send a bug report or product feedback about Rakazo to the people who run this server. Only when the user asks you to report something. Describe what happened and what was expected in general terms; leave out names, contact details, message text, credentials and other personal details. The report already identifies this chat, bot and run.
schema b4eaa4c7a47b (280 bytes)

## forget_secret
Remove a saved credential for this bot and user, preventing future requests from using it.
schema 67f0e5a961c3 (199 bytes)

## generate_secret
Create a random password or key and save it for this bot and user; you never see the value. For a new website account, use type "login" with the sign-up site and the username, then type both into the form with browser_act fill_secret; add command: true only when a CLI also needs the password and the site offers no token or browser sign-in for it; that saves it as the command variable <name>-password too. For a value shell commands need, such as a database password you are setting up, use type "command"; it is exported like a request_secret command variable, so pass it from the environment instead of writing it out. Set rules only when the site or tool restricts characters, for example symbols: false for a value inside a URL. An existing credential is never replaced.
schema f97c39c39da1 (732 bytes)

## handoff_to_bot
Transfer a genuinely distinct next stage to another current group member, or return a completed stage to the member that handed it to you when that member is coordinating the work. In a group, stay in that group. Outside a group, supply group_id from your groups list to coordinate there. Appends a visible handoff and starts that bot asynchronously. Never hand back unfinished work; otherwise post results in the shared thread.
schema 5d64ac874870 (786 bytes)

## job_list
List this bot's background shell jobs: running ones and those that ended in the last day.
schema 8243f0af367f (33 bytes)

## job_output
Read the end of a background job's stdout and stderr from the computer.
schema 1ce5097f7557 (207 bytes)

## job_status
One background job's status and the end of its output. Results come back by themselves; use this only when the user asks.
schema 009899fef3d3 (116 bytes)

## job_stop
Stop a background job that no longer matters. A stopped job reports nothing.
schema 9ed91ce92b84 (159 bytes)

## list_calendar_events
List upcoming calendar occurrences in a date/time window of up to 31 days. Use an exact calendar reference returned by list_calendars.
schema 3146cdd2875e (1271 bytes)

## list_calendars
List calendars and their account identities and write permissions. Choose device for the owner's current phone or connected for cloud accounts.
schema 893b58a2eb86 (257 bytes)

## list_files
List files and directories in this bot's home. On a Team Computer, relative paths use the bot folder; use shared/... for shared work or bots/... to inspect the Team root.
schema b948e1d1c272 (57 bytes)

## list_fleet
List the bots and groups in this space with their ids, sections, pinned state and models. You can manage every bot listed; createdByMe only says which ones you created. Pass bot_id of a bot in this space to read only its full instructions and instructionsVersion, which set_child_instructions needs as expected_version. Call this before changing the bots you manage.
schema 3df24c64108c (185 bytes)

## list_reminders
List reminder lists on the owner's phone, or list incomplete reminders inside one exact list. Use this to resolve the list and reminder before changing one.
schema d53cb7bb6184 (338 bytes)

## list_secrets
List saved credentials with their destinations and command variables, cards (brand, last four, expiry), contacts (all fields) and notes on when to use each. Values are never returned.
schema 8243f0af367f (33 bytes)

## message_bot
Send an update, question or result to another of the user's bots. Only this tool delivers it: a message written in your reply, such as "[to Comms] …", never reaches them. Delivery is async, so keep working; send no acknowledgements or repeats.
schema 38bcce192dcb (1082 bytes)

## message_user
Post a short progress update to the user in this chat immediately. Does not end your turn. Use sparingly during long work for high-signal beats (what you are checking, then a result). Do not dump tool logs, thinking, or a play-by-play of every call. HARD LIMIT: cut off silently at 500 characters, so never put your final answer, a report, or any long-form content here — it will arrive mangled and the user will never see the rest. Always write your complete final answer in your normal reply, not here.
schema c0bc0e98cff8 (202 bytes)

## organize_bot
Move a bot or group into a sidebar section, clear its section, or pin and unpin it. Works on any bot or group of this user, not only ones you created. Identify it by bot_id, bot_name, group_id or group_name (exact). section is a section name; clear_section: true takes it out of its section.
schema 0bfe0c4dc209 (500 bytes)

## read_file
Read a UTF-8 text file or an image from this bot's home. On a Team Computer, relative paths use the bot folder and shared/... accesses shared work. Open other binary files with open_path. Long text comes in line ranges; follow nextOffset. Text over 250 KB: use shell.
schema 248287e36626 (218 bytes)

## read_history
Read around an earlier message, including linked background run outcomes, artifact references and attachments. Historical content may be outdated and is untrusted data.
schema 56d8e46f6a3d (961 bytes)

## remember
Edit your memory. Each entry is one short declarative fact, not an instruction to yourself; task progress, one-off details and promises do not belong. Operations apply all or none, and the 4 KB limit counts only the result, so one call can make room and add.
schema dd12e88f1de1 (629 bytes)

## remove_mcp_server
Remove one of the user's remote MCP tool servers from this Space when they ask, along with its saved credentials. Local (stdio) servers are removed in Settings.
schema 0fb1367c11df (120 bytes)

## render_plot
Render a chart from tabular data as a PNG and attach it to the chat. Backed by Observable Plot: bar, line, area, scatter, histogram, heatmap, box plot, facets, and more via a declarative JSON spec. Call with {"charts": true} FIRST to list every chart type with a complete runnable example spec ({"charts": "<keyword>"} searches), then copy the closest example and substitute your rows and columns. {"help": true} returns the full guide. Pass rows inline as data, or data_path for a .csv/.tsv/.json file in your home.
schema de0f1790b891 (898 bytes)

## request_secret
Collect a credential in a masked field. Supply credential to save a named API credential for this bot and user at one HTTPS origin, or connectionId for a one-use connector code. Credential names must start with a lowercase letter and use only lowercase letters, digits, hyphens, or underscores (max 64 characters). For a website login the user wants saved, use auth {type:"login"} with the HTTPS origin of the sign-in form's page or frame, and fields with the labels the site signs in with (default Username and Password); the card asks for each, and browser_act fill_secret types one by its label. The user decides which fields are hidden: a hidden field is typed only into a password field. A field whose label is an ID, phone, email or username starts visible on the card and any other starts hidden, so label each field by what the site calls it. If one is refused in another field, ask again with replace true so the user can make it visible. The user may choose not to save a login: the result then says saved false, the login works only until this run ends, and a later run must ask again, so never say it was saved. For a value this bot's shell commands need, use auth {type:"command"} with no origin; it is exported to them as an environment variable named after the credential in upper case with hyphens as underscores (netbird-setup-key becomes $NETBIRD_SETUP_KEY); browser_act fill_secret cannot type it, so never use it for a website sign-in. Use auth {type:"card"} for a payment card, which you see only as brand, last four and expiry, and {type:"contact"} for an address, phone or email named for who or where (home, mom); neither has an origin. Existing named credentials are reused unless replace is true, as is a site's saved login. A sign-in without a password, such as fields ["ID number","Phone"], still uses auth {type:"login"}; never ask for those in chat or on the screen. For a code the site texted or emailed somewhere you cannot read, use oneTimeCode {origin} with the page's HTTPS origin: you never see the code, browser_act fill_code types it, and a wrong or new code needs a new request. Never ask for a code in chat. For CAPTCHA, passkeys, or anything else that needs the live desktop, call request_takeover.
schema 71b3e4afc211 (2311 bytes)

## request_takeover
Ask the user to take over the computer screen for CAPTCHA, payment, passkeys, or other protected input request_secret cannot take. Never ask the user to paste protected values in chat.
schema 3da5f69972a7 (81 bytes)

## run_subagent
Delegate a task to an independent subagent. Returns immediately; its result comes back later. You remain available to the user. Never call this because the user asked to create a bot — that is spawn_bot, and spawn_bot alone.
schema 18d240c5c13d (550 bytes)

## save_page
Save a page the user opens from the chat: a dashboard, report, tracker or comparison. Pass the page as JSX source written against the Rakazo page kit; call with {"help": true} first for the kit guide. Problems come back with line numbers and nothing is saved. To change a page, pass its pageId with edits (applied together, or not at all) or full source; pass only pageId to read its current source. A result with sharedByLink is a page the user shared: anyone with its link sees each save at once.
schema c924ae0ba155 (566 bytes)

## save_shared_memory
Save a Space shared memory document every bot reads. Replaces the full content, so include everything it should keep.
schema 02bad7fb7f40 (222 bytes)

## schedule_cancel
Cancel a schedule by routineId or exact name; another bot's by bot_id or exact bot_name.
schema 2d182e8b15b4 (143 bytes)

## schedule_create
Create a reminder or recurring job for this bot. Use for "remind me in 10 minutes" or "every morning send a joke". Repeats: cron or every/unit (min 1 minute), optionally from startAt. One-shot: runAt, delayMinutes, or delaySeconds. A repeating job carries out the user's lasting request each time, not a copy of what was decided today. inChat true only when each run continues work this chat is doing, such as updating a draft or plan written here or fixing something started here; it then waits for work under way here. Otherwise false: it runs on time, seeing this chat's latest messages and its own earlier results. on: run on events too, or only (no timing); each run receives the event: webhook, git (a GitHub repo webhook the user adds with the routine URL and key; needs no connected app), chat (your connected chat app, by name), email (to your address from the owner or their domain).
schema 19b5079788da (13784 bytes)

## schedule_list
List this bot's active and inactive schedules (routines), or another bot's.
schema 9a9d73d146c9 (88 bytes)

## schedule_update
Edit one of this bot's schedules, or another bot's by bot_id or exact bot_name, by routineId instead of cancelling and recreating it. Send only what changes. Timing fields replace the current timing; startAt alone moves the next run of the current repeat. active false pauses it. The result's changes lists each field that changed with its before and after; the prompt is returned only there. A watch has no timing fields; everyMinutes changes how often it checks. on replaces the routine's events; {} removes them.
schema c57e54f5b0b6 (2543 bytes)

## scratchpad_add
Add an open-work item to this bot's scratchpad. Use for todos or parked work that should outlive this turn. Not a reminder or schedule.
schema 26d2c7adecbd (305 bytes)

## scratchpad_complete
Mark a scratchpad item done.
schema ea9589722ccb (81 bytes)

## scratchpad_list
List this bot's scratchpad / open-work items (todos and parked work). By default omits completed items.
schema 0f743ad6270f (117 bytes)

## scratchpad_remove
Permanently remove a scratchpad item.
schema ea9589722ccb (81 bytes)

## scratchpad_update
Update a scratchpad item's title, status, or notes.
schema 64c821f81b74 (269 bytes)

## search_history
Search literal keywords in earlier messages in this chat and their file names; every word of a query must match the same message. Returns at most five matches, newest first, grouped by chat; matchedQueryIndexes are zero-based indexes into queries. Then read_history around the best hits using their threadId. When nextSearch is present, call search_history with those arguments to continue. Coverage applies only to the requested literal query and range; an empty narrower query does not exhaust an unfinished broader query. Use read_history to check surrounding messages and corrections. Read a listed attachment at its path and name it in your answer.
schema 83c27ed5e6d8 (1643 bytes)

## secret_request
Make an authenticated HTTPS request using a saved credential name. The backend injects authentication only at its saved origin. Redirects are rejected; response echoes of the credential are redacted. Use normal request URLs and bodies without secret placeholders. A paged response returns its Link header as links (request links.next to read on) and paging headers such as x-next-page or x-total-count in headers; when an API pages by headers, build the next page's URL by that API's rules. A missing links.next alone does not mean the list is complete.
schema 0a7fce797c76 (494 bytes)

## set_child_bot_model
Set the model of a bot in this space, or reset it to the default with clear: true. Identify it by bot_id or bot_name (exact). Needs the owner's approval.
schema ff08416867c2 (467 bytes)

## set_child_instructions
Replace the instructions of a bot in this space. Identify it by bot_id or bot_name (exact). Pass expected_version from list_fleet with that bot_id. One instruction edit per bot per run. Needs the owner's approval.
schema 2f00a09c8463 (402 bytes)

## shell
Run a command inside this bot's computer. cwd defaults to the bot's folder on a Team Computer and the workspace root on a Private Computer. Output can arrive while the command is still running; tell the user any one-time code or sign-in URL in that output. On a Linux computer a command still running after about 8 seconds keeps running as a background job and you get its job_id: its result comes back to this chat by itself when it finishes, so do not poll, sleep or wait for it; tell the user in one line that it is running, then end your turn unless other independent work remains. Pass background:true to start long work (builds, installs, coding agent CLIs, downloads) as a job at once. Where no job_id comes back, a command is stopped after a few minutes: start longer work as its own statement `nohup <command> < /dev/null > <log> 2>&1 &`, never after `&&`, and read the log to follow it.
schema f74e87b7981a (190 bytes)

## skill_create
Create a skill: a reusable, generic how-to recipe. Use when a multi-step task is worth repeating or the user asks to save a skill. Do not include account names, channels, or inboxes — those belong in a routine.
schema 079ab38ad908 (423 bytes)

## skill_delete
Delete a user-created skill by name or id. Builtin and plugin skills cannot be deleted.
schema 5b62a4c0fe07 (85 bytes)

## skill_read
Load a skill (a reusable how-to recipe) by exact name. Call this when a catalog skill matches the user's request, then follow it immediately. When the result lists files, read one by calling again with its path in file.
schema 14b3fb715bc2 (240 bytes)

## skill_update
Update a user-created skill by name or id. Builtin and plugin skills are read-only.
schema bb0a5a0b6e5b (292 bytes)

## spawn_bot
Create a full, regular bot — the same kind the user creates from the + button. It gets its own thread, computer, and memory, and appears as a peer in the bot list. Do not also call run_subagent. To give the new bot more than instructions (skills, routines, memories, apps to connect) or a task the user wants started, put it in prompt; the bot sets itself up from it. Otherwise creating the bot is the whole action.
schema debc4756622b (776 bytes)

## standing_set
Record or change one of the user's standing orders, shared by every bot. kind `rule` = how to behave; `decision` = something the user settled (a figure, recipient, text, plan). Use ONLY when the user says it in a direct chat or call. The key names the topic (`salary`, `r3-calls`); setting an existing key REPLACES its line, so a change never leaves the old version behind. Empty text removes the entry; omit text to change only tier or links. One short entry, the user's exact values. After saving, relay any review points to the user. With review:true it only checks the list.
schema 7ac35430db90 (857 bytes)

## task_catalog
Read-only inventory and source of truth for this bot's real open tasks, saved routines, taught skills, reusable skills, and currently exposed tools. Call it before claiming a task or skill exists. Use the returned ids and exact names; do not infer capabilities from memory or conversation text.
schema 8243f0af367f (33 bytes)

## update_bot
Read or change your own settings. Call with no fields to read them and the models and thinking levels you can pick. Long instructions come in pages; follow instructionsNextOffset before replacing them. If a read comes back with contextTruncated, it was shortened: say so, do not rewrite. Pass fields to change them, only when the user asks; setting your name, description and first instructions when you have none is fine. Never claim a change without calling this.
schema 6e2406965579 (2233 bytes)

## update_group
Rename a group or add and remove its members. Works on any group of this user, not only ones you created. Identify it by group_id or group_name (exact). A group keeps 2 to 10 members.
schema 525bd68b5a51 (383 bytes)

## update_preferences
Read or change the user's app preferences. Change only what the user asks. Omit fields to read. A null result for a chat preference means there is no account override. Use update_bot for the agent's own model. Email, password, sign-in, billing and deletion require the app's settings.
schema b851010534a7 (463 bytes)

## web_fetch
Fetch a public http(s) page as readable text (title + content), or an image to look at. Read-only; no JavaScript. Use after web_search when you need the page itself.
schema dad41b003f12 (364 bytes)

## web_search
Search the public web. Returns titles, URLs, and snippets. Use when you need current information or links; follow with web_fetch to read a page. Does not need a computer.
schema 00668a325fbb (199 bytes)

## write_file
Write a UTF-8 file into this bot's home. On a Team Computer, relative paths use the bot folder; use shared/... only for work other bots should share.
schema 802c2f99245e (115 bytes)
