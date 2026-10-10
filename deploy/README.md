# Local deployment

Generate a service file for your machine with `node src/cli.js service --cwd /absolute/project/path --output deploy/wechat-codex.service`. It uses your installed Node/Codex executables and a separate state directory (default `~/.wechat-codex`). The generated file is excluded from Git.

Credentials are stored outside the repository with mode 0600. No Codex login credentials are copied. The read-only doctor can verify both the local Codex connection and the WeChat token without polling messages.

Before activation, stop `com.ganxing.codexbridge-weixin.service`. Then refresh the polling cursor from the old account's `.sync.json` file with the included command:

```bash
node scripts/sync-import-cursor.js
```

This command requires an imported account, refuses to run while either service is running, and updates only the WeChat polling cursor/reply context in the new state. It prevents replay of messages the old service processed after initial preparation. It does not import prompts, thread bindings, or settings.

Install/start the generated unit using the commands in the main README. Send `/help`, `/new`, `/models`, and a short message from the phone. Inspect `journalctl --user -u wechat-codex.service -n 50` for service startup/connection failures. Logs omit message bodies and tokens.

## Switch back to the original CodexBridge

Both service units can stay installed, but only one should poll the paired WeChat account. These commands apply to the service names used in this repository. They preserve the original program, its configuration, and its conversations.

1. In WeChat, finish the current task or use `/stop` and wait. Check `/status`: no active turns. Check `/outbox` and let wanted replies finish delivery; unsent replies are not migrated. Avoid sending more messages while switching.
2. On the computer, from the new repository directory, run:

   ```bash
   cd ~/tools/wechat-codex
   systemctl --user disable --now wechat-codex.service && \
     node scripts/prepare-rollback.js && \
     systemctl --user enable --now com.ganxing.codexbridge-weixin.service
   ```

   The `&&` chain starts the original only if preparation succeeds. The helper requires both clients to be stopped, matching imported accounts, an empty incoming queue, and no recorded task in progress. It backs up the original cursor/context files before updating their polling position and reply context. It does not change credentials, model settings, or conversation bindings. Backups have a `.before-wechat-codex-rollback-TIMESTAMP` suffix beside the original files; keep them private.
3. Verify:

   ```bash
   systemctl --user is-active com.ganxing.codexbridge-weixin.service
   systemctl --user is-active wechat-codex.service
   ```

   Expected: `active`, then `inactive`. Send `/help` in WeChat. You are now using the original client's commands and session selection, not the new client's selected session.

If the helper refuses, the command chain leaves the original stopped. Read its error; to resume the new client while resolving it, run `systemctl --user enable --now wechat-codex.service`. If you paired a different account instead of importing the original, re-pair the original client rather than copying an unrelated cursor. Cursor transfer reduces replay risk but does not migrate queued work or provide an exactly-once guarantee.

To return to the new client later, finish work in the original, stop/disable its service, run `node scripts/sync-import-cursor.js` from this repository, and enable/start `wechat-codex.service`. Never run both pollers together.
