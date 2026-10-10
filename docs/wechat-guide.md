# Using Codex from WeChat

Send each command below as a **separate WeChat message** to your paired bot. Do not include the backticks. Normal messages, such as “Fix the failing tests in this project,” start work. The computer and the WeChat client must be running.

## The commands you will use most

| What you want | Send in WeChat |
| --- | --- |
| Check usage and remaining allowance | `/usage` |
| See your current model and reasoning effort | `/model` |
| List available models | `/models` |
| Choose model number 2 from that list | `/model 2` |
| Choose model 2 with high reasoning, if supported | `/model 2 high` |
| See permission settings and available profiles | `/permissions` |
| Check the active reviewer and session | `/status` |
| See requests waiting for your approval | `/approvals` |
| Stop the current task | `/stop` |
| Show help in Chinese | Send `/lang zh`, then `/help` |

Numbers are examples: choose from the list you actually receive. Settings changes require an idle session. If work is running, let it finish or send `/stop` and wait for it to stop before changing settings.

## 1. Permissions and automatic approval

There are three separate controls:

- **Permission profile:** which files and operations Codex can access within its sandbox.
- **Approval policy:** when Codex may request approval.
- **Approval reviewer:** whether you or native Codex automatic review handles eligible approval requests.

### Change the permission profile

First send:

```text
/permissions
```

The reply contains `current`, `sandbox`, `approvalPolicy`, and a list of `profiles`. Select an exact profile `id` whose `allowed` value is `true`. For ordinary project work, if offered, send:

```text
/permissions :workspace
```

Keep the leading colon. `:workspace` permits work in the configured workspace; `:read-only` is for inspection. The native list may also offer `:danger-full-access`, which removes sandbox restrictions. Full access is not required for automatic review.

Then select an approval policy:

```text
/approval on-request
```

| Policy | Meaning |
| --- | --- |
| `on-request` | Codex can request approval when needed. Use this with automatic review. |
| `untrusted` | Requests approval more often for commands outside the trusted set. |
| `never` | Does not request approval; operations requiring approval cannot proceed through that approval path. It does **not** automatically approve them. |

These WeChat commands change the selected Codex session. They do not edit your global configuration. Other sessions may have different settings.

### “I want automatic permission while Codex works on a task”

Use native **automatic review**: eligible approval requests are evaluated automatically, so accepted actions can continue without a WeChat confirmation. It can still reject actions or require human input. This retains the sandbox boundaries. See [OpenAI’s automatic-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review).

First send `/permissions`, then `/status`. In `/status`, look for:

```json
{
  "approvalPolicy": "on-request",
  "approvalsReviewer": "auto_review"
}
```

If both values are present, automatic review is already selected. You can send your task normally. If the reviewer is already `auto_review` but the policy differs, send `/approval on-request` while idle, then check again.

**Current client limitation:** there is no `/approval auto` command, no WeChat command to change the reviewer, and no “auto-approve everything for this task only” switch. `/approval on-request` alone does not enable automatic review.

If the reviewer is not `auto_review`, configure it on the computer running Codex:

1. Open your Codex `config.toml` (normally `~/.codex/config.toml`, or under your custom `CODEX_HOME`). Record the existing values first.
2. Add or update these keys at the **top level**, before any `[section]` headers. Do not create duplicate keys:

   ```toml
   approval_policy = "on-request"
   approvals_reviewer = "auto_review"
   ```

3. When existing work is finished, restart the WeChat client. For the systemd installation described in this repository, run this **in the computer’s terminal**, not in WeChat:

   ```bash
   systemctl --user restart wechat-codex.service
   ```

   For a foreground installation, stop the existing process and start it again using your usual launch command.
4. In WeChat, start a fresh session with `/new /absolute/path/to/your/project`, replacing the path with your actual project directory. Send `/permissions`, then `/status`, and verify the effective values above before starting work.

This configuration sets a default for Codex sessions that inherit it; it is **not limited to one task**. Existing sessions, project configuration, and managed requirements can affect the effective values. Restoring the previous config values and restarting restores the default for future sessions; it does not promise to reset existing session settings. If `/status` does not show the expected values, do not assume review is active.

### Approve a specific pending request

If WeChat shows a request ID such as `17`, use the actual ID in one of these messages:

```text
/allow 17
```

```text
/allow 17 session
```

```text
/deny 17
```

The scope depends on the native request:

| Request kind (visible in `/approvals`) | `/allow ID` | `/allow ID session` |
| --- | --- | --- |
| `item/permissions/requestApproval` | Grants the requested permissions for the current turn | Grants the requested permissions for the session |
| Command execution or file-change approval | Accepts that action | Uses native “accept for session” when offered; reuse is determined by Codex |

A **turn** is one running response to your task message. A **session** is the conversation, including later tasks. Session approval applies to the requested action or permissions; it is not blanket approval for every future operation. For permissions restricted to the current turn, use `/allow ID` without `session` when the request is a permissions request.

## 2. Check usage

Send:

```text
/usage
```

The reply is structured text with two parts:

- **`session`**: the latest native token-usage report saved for the selected conversation. `total` is cumulative usage reported for that thread; `last` is the latest usage increment. `inputTokens` and `outputTokens` describe input and output; cached input and reasoning output are breakdowns, so do not add every field together. Use `totalTokens` for the reported total. `modelContextWindow` is a model context capacity, not your remaining account allowance.
- **`account`**: the current account limit report returned by Codex. `rateLimits` is the compatibility view; `rateLimitsByLimitId`, when present, contains separate limit buckets. Do not add the compatibility view to those buckets.

Within each available `primary` or `secondary` window:

| Field | How to read it |
| --- | --- |
| `usedPercent` | Percentage used, not remaining. For example, `30` means approximately 70% remains in that window. |
| `windowDurationMins` | Length of the window in minutes. For example, `300` is five hours; `10080` is seven days. Read the returned values rather than assuming every account has those windows. |
| `resetsAt` | Reset time as a Unix timestamp in seconds, when supplied. |

`ordinaryUsageAllowed` is the backend’s reported permission to use ordinary included allowance. `false` means it is not allowed; `null` means unavailable. Percentages and reset times alone do not guarantee that a request can run. Credits and spend-control fields, if returned, are separate from token counts.

`session: null` means this client has no saved token report for that session yet; it does not mean your account has used zero tokens. Missing account values mean unavailable, not unlimited. `/usage` does not provide a complete billing history or an exact number of messages remaining.

For a general activity check, send `/status`. For usage, use `/usage` specifically.

## 3. Change the model

### Pick a model from the live list

Send:

```text
/models
```

The response numbers the models available to your native Codex installation and lists their supported reasoning efforts. To select the second model, send:

```text
/model 2
```

This uses that model’s default reasoning effort. You can also use its exact model name instead of `2`.

To choose a supported effort explicitly:

```text
/model 2 high
```

To keep your current model and change only the effort:

```text
/model high
```

Use an effort shown for that particular model. An unsupported effort is rejected; not every model offers `high`, `xhigh`, `max`, or `ultra`.

### Verify the change and inspect details

Send:

```text
/model
```

The reply shows model, effort, provider, and service tier. For the full native model metadata for model number 2, send:

```text
/models show 2
```

Model numbers refer to the list, not fixed permanent IDs. Run `/models` again if the catalog changes. Selecting a model changes the current session and keeps its conversation history. It does not modify every session or the global default.

### Return to the configured default

```text
/model default
```

This reads the applicable Codex configuration and selects its model and reasoning effort, falling back to the catalog default where implemented. It does not necessarily undo your last model change.

## A simple daily workflow

Send these messages one at a time:

1. `/threads` — list conversations.
2. `/open 2` — open the conversation numbered 2 in that list. Or use `/new /absolute/project/path` to start a new one.
3. `/model` — check the current model; use `/models` then `/model 2 high` if you want to change it and the selected model supports `high`.
4. `/permissions` then `/status` — check permissions and the reviewer.
5. Your task in ordinary language.
6. `/usage` — check usage afterward.

For additional commands, see the [README command table](../README.md#wechat-commands) or send `/help`. This guide describes this repository’s implemented WeChat commands; the interactive Codex terminal may use different menus or syntax.

## File downloads and delivery recovery

Send `/exports` to see the dedicated export folder. Put the intended result in that folder on the computer, then send `/download result.pdf`. Files elsewhere cannot be downloaded directly. Keep credentials out of this folder. Send `/storage` to see the managed attachment quota and any discarded-reply count.

A failed reply no longer blocks all later replies. Use `/outbox` to find the failed delivery ID, `/outbox retry ID` to retry it, or `/outbox drop ID` to remove it. These commands do not repeat the Codex task. After five failures a reply pauses until you retry it. `/outbox clear` removes all queued deliveries.

For switching back to the original client, see [the rollback instructions](../deploy/README.md#switch-back-to-the-original-codexbridge).
