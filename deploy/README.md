# Local deployment

Generate a service file for your machine with `node src/cli.js service --cwd /absolute/project/path --output deploy/wechat-codex.service`. It uses your installed Node/Codex executables and a separate state directory (default `~/.wechat-codex`). The generated file is excluded from Git.

Credentials are stored outside the repository with mode 0600. No Codex login credentials are copied. The read-only doctor can verify both the local Codex connection and the WeChat token without polling messages.

Before activation, stop `com.ganxing.codexbridge-weixin.service`. Then refresh the polling cursor from the old account's `.sync.json` file with the included command:

```bash
node scripts/sync-import-cursor.js
```

This command requires an imported account, refuses to run while either service is running, and updates only the WeChat polling cursor/reply context in the new state. It prevents replay of messages the old service processed after initial preparation. It does not import prompts, thread bindings, or settings.

Install/start the generated unit using the commands in the main README. Send `/help`, `/new`, `/models`, and a short message from the phone. Inspect `journalctl --user -u wechat-codex.service -n 50` for service startup/connection failures. Logs omit message bodies and tokens.

On rollback, stop the replacement before starting the old service. The old polling cursor may lag messages handled by the replacement; inspect its behavior before sending work with repeatable side effects.
