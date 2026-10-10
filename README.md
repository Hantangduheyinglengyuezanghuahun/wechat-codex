# WeChat Codex Local

A personal WeChat interface to the **installed Codex CLI**, written independently. WeChat carries text and attachments; `codex app-server --listen stdio://` owns the conversations and executes the work on your machine.

```text
Your WeChat → Tencent iLink → this local client → installed codex app-server
Your WeChat ← Tencent iLink ← this local client ← native Codex events
```

## Prompt and configuration behavior

- Ordinary message text is sent unchanged as native user input. It gets no sender label, transport description, system prompt, developer prompt, language instruction, or hidden task.
- The child process inherits your normal environment, Codex login, configuration, project instructions, sandbox, and approval rules. The client supplies no provider override, custom inference endpoint, account pool, or Responses/Chat Completions translation.
- Commands such as `/model`, `/open`, and `/permissions` call native control methods. They do not ask another model to interpret your commands. `/plan` uses Codex's built-in plan/default modes; its developer-instruction override is `null`.
- Attachments use native `localImage` or file `mention` inputs. Incoming voice transcripts, when supplied by WeChat, are user text. Files are saved under `~/.wechat-codex/inbound`.
- The required initialization metadata truthfully names this client `wechat_codex_local`. This is **not byte-for-byte identical to the terminal UI**, and it does not impersonate the official terminal client. No claim is made about making the integration undetectable or guaranteeing an account's treatment.
- Existing sessions retain their previous history and instructions. Use `/new` for a fresh conversation. Importing a WeChat login does not import the old client's prompts or session settings.

OpenAI documents app-server as an integration interface for native threads, turns, models, and approvals: [official app-server documentation](https://learn.chatgpt.com/docs/app-server), [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform). Preserving prompts and configuration is testable; claims that the word “bridge” causes an account-level intelligence downgrade are not established by those documents.

## Requirements and first run

- Linux and Node.js 22.13 or newer. This installation was tested on Node 24.21 and Codex 0.160.1. The app-server interface can change between Codex versions.
- An installed `codex` executable, already signed in with `codex login`.
- A WeChat account with access to Tencent's iLink/ClawBot pairing. This uses personal direct chat, not an ordinary WeChat public-account webhook or WeCom. Availability depends on Tencent and your WeChat account.

```bash
cd ~/tools/wechat-codex
npm ci --ignore-scripts
npm run doctor
npm run login
npm start -- --cwd /absolute/path/to/your/project
```

Scan the QR code with WeChat and confirm. The terminal also gives a local PNG path. Login saves the paired sender as the sole authorized owner. Other senders and group messages are ignored.

The process must stay running, and the machine must be awake and online. Send `/help` from the paired WeChat chat. `--state-dir`, `--cwd`, and `--codex` can be supplied to the CLI; corresponding environment settings are `WECHAT_CODEX_STATE`, `WECHAT_CODEX_CWD`, and `WECHAT_CODEX_BIN`.

## Reuse an existing CodexBridge WeChat login

The old program must stop polling before the replacement begins. Keep its files for rollback.

```bash
node src/cli.js import-account --from /absolute/path/to/old/account.json
node src/cli.js doctor --wechat --cwd /absolute/path/to/project
```

Import reads just the WeChat token, owner, endpoint, reply context, and polling cursor. It writes a separate private state directory. It does not change `~/.codex` or `~/.codexbridge`. The read-only credential check neither consumes messages nor sends messages. On Linux, startup refuses an imported account while the original `CodexBridge/src/cli.ts weixin serve` process is still running. Keep only one poller per account on other systems too.

The working directory is selected with `--cwd` when generating the service. Use `/new /absolute/project/path` to select a project. A Codex session is loaded by its native thread ID; this does not attach to another running terminal process. Avoid writing to the same thread from two clients at once.

## WeChat commands

**Start here: [Practical WeChat guide — permissions, automatic review, usage, and models](docs/wechat-guide.md).** It includes copy-and-send examples and explains what each setting changes.

| Area | Commands |
| --- | --- |
| Sessions | `/new [directory]`, `/threads [archived]`, `/search words`, `/next`, `/prev`, `/open N\|ID`, `/peek [N\|ID]`, `/rename N\|ID title`, `/fork [N\|ID]`, `/archive [N\|ID]`, `/unarchive N\|ID` |
| Models | `/models`, `/models show N\|model`, `/model [N\|model] [effort]`, `/model high`, `/model default`, `/fast on\|off` |
| Status | `/status`, `/usage`, `/account`, `/provider`, `/instructions` |
| Native permissions | `/permissions [profile]`, `/approval on-request\|untrusted\|never`, `/approvals`, `/allow ID [session]`, `/deny ID`, `/answer ID answer` |
| Work | `/stop [N\|ID]`, `/retry`, `/plan on\|off`, `/review [base branch\|commit SHA\|custom instructions]`, `/compact` |
| Goals | `/goal`, `/goal set objective`, `/goal budget N objective`, `/goal pause`, `/goal resume`, `/goal clear` |
| Skills | `/skills`, `/skills search words`, `/skills show N`, `/skills on N`, `/skills off N` |
| Plugins | `/plugins`, `/plugins search words`, `/plugins show N`, `/plugins install N`, `/plugins uninstall N` |
| Experimental features | `/experimental`, `/experimental on name`, `/experimental off name` (native runtime feature controls) |
| Attachments | `/uploads`, `/uploads begin` or `/up`, `/uploads send [task]`, `/uploads clear`, `/download path` |
| Connection | `/reconnect`, `/restart` (restart this client's Codex child), `/outbox [retry\|clear]`, `/login [status\|cancel]` |
| Display | `/help`, `/lang en\|zh` (help language), `/progress on\|off` |

Session and model indices refer to the last list displayed. `/search` uses native full-text search. `/model default` restores the effective project configuration's model and effort. `/models` displays the native catalog, which is not a guarantee of account entitlement. Changing the model, plan mode, or permission profile affects the selected thread; changing a skill or installing a plugin changes native Codex configuration.

Common short aliases include `/h`, `/st`, `/n`, `/th`, `/se`, `/o`, `/pk`, `/rn`, `/ms`, `/m`, `/sp`, `/pl`, `/rv`, `/sk`, `/pg`, `/al`, `/dn`, `/perm`, `/rc`, `/rt`, and `/rs`. A bare `/` refreshes the reply context without generating a reply or model turn. To send a prompt starting with a slash, use `/send /your literal text`. Unknown slash commands report an error instead of becoming model prompts.

Ordinary text sent during a running turn uses native steering. `/stop` interrupts the selected session; other sessions can remain active. Approval requests carry unique IDs and a session identifier. No approval is granted automatically by this client. Your existing Codex approval reviewer can still resolve or reject actions under its own policy. Replies to multi-question prompts use `/answer ID {"question_id":"answer",...}`. Native app/connector forms accept JSON through `/answer`; secret or identity-verification flows should be completed locally.

## Attachments and delivery

Send one or more files/images, then your task. An attachment-only message is staged rather than starting an unexplained model turn. `/up` stages a batch, including captions, until you send the task or `/uploads send`. Paths and names remain visible through `/uploads`. Supported transport types are images, files, videos, and voice; raw voice/video are attached as files, and their interpretation depends on native Codex tools. This client does not run its own transcription model or inject media interpretation instructions. Each file is limited to 25 MiB.

Use `/download /absolute/path/to/result.pdf` to send a local result back to yourself. The file is snapshotted under `~/.wechat-codex/outbound` at command time, so later edits do not change the queued attachment. Model text is never scanned for instructions to transmit arbitrary files. Outgoing files use Tencent's file-message format, including images sent with `/download`.

Final responses retain their text, split at UTF-8 boundaries for WeChat. Completed commentary messages are relayed at most once every 20 seconds when progress is on. This is not a token-by-token mirror of the terminal. WeChat can limit consecutive replies; send `/` to refresh the reply context if necessary. `/outbox clear` discards queued deliveries, without deleting native conversation history; `/peek` can retrieve the latest conversation again.

Received messages and the polling cursor are persisted together. Duplicate message IDs do not start a second task. Replies have a separate durable delivery queue: retrying a failed send does not rerun Codex. If the process dies between starting a task and recording its outcome, it reports that uncertainty and does not automatically replay it. `/retry` explicitly resubmits the last input and can repeat its effects. Delivery uses a stable client message ID, but an ambiguous network failure can still produce duplicate WeChat replies if Tencent does not deduplicate it.

## Background service on Linux

Generate a service using the actual Node and Codex executable paths. Generated `.service` files are machine-specific and excluded from Git:

```bash
node src/cli.js service --cwd /absolute/project/path --output deploy/wechat-codex.service
systemd-analyze --user verify deploy/wechat-codex.service
```

The generated file is reviewable and contains no account tokens. To switch from the old service:

```bash
systemctl --user stop com.ganxing.codexbridge-weixin.service
install -m 600 deploy/wechat-codex.service ~/.config/systemd/user/wechat-codex.service
systemctl --user daemon-reload
systemctl --user enable --now wechat-codex.service
systemctl --user disable com.ganxing.codexbridge-weixin.service
systemctl --user status wechat-codex.service
```

After stopping the old service, refresh the imported polling cursor before starting the replacement if the old service received messages since import. See [deployment notes](deploy/README.md). The client never adds sudo, disables Codex's sandbox, or installs a public HTTP listener. Service operation after logout depends on the machine's existing systemd user/linger setup.

Rollback:

```bash
systemctl --user disable --now wechat-codex.service
systemctl --user enable --now com.ganxing.codexbridge-weixin.service
```

## Validation and scope

```bash
npm test
npm run doctor
npm run doctor -- --wechat
npm run test:live
npm run test:live -- --inference
```

Tests cover transport framing, exact prompt text, session paging, model settings, approvals, attachments, replay protection, and reply retry behavior. The live check creates and archives its own test thread. `--inference` additionally spends a small amount of your normal Codex allowance on a fixed reply test; it never connects to WeChat. End-to-end phone delivery still needs a real message after the new service is activated.

This is a personal client, not a complete terminal emulator. Provider adapters, multi-account inference pools, prompt rewriting, natural-language management classifiers, personal notes/reminders, Weibo integration, and bridge-created scheduled tasks are intentionally outside scope. Existing Codex skills, plugins, native agents, and goals remain available through Codex. Plugin installation that requires a native disclosure is handed back to the local Codex UI. See the [feature comparison](docs/reference-comparison.md).

## Provenance

The behavior reference is [Gan-Xing/CodexBridge](https://github.com/Gan-Xing/CodexBridge), local revision `92166e02f4c7c8fcc0d223e894dd33664db754ea`. Its README and command reference were used to identify features; its implementation was not copied into this project.

WeChat wire fields were checked against [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin), revision `c6643f6f0ac03574eb126f2d69569ea4267cc3c6`. The transport here is independently implemented; it does not install or run OpenClaw. Codex wire shapes were generated from the locally installed `codex app-server generate-ts --experimental` command. The only npm runtime dependency is `qrcode` and its transitive dependencies.
