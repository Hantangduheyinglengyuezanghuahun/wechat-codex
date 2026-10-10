# Validation on this machine

Tested with Node.js 24.21.0 and codex-cli 0.160.1.

- **28 automated tests passed.** These include a real child-process JSON protocol test, WeChat-to-Codex-to-reply flow with simulated transport, exact user text, model settings, session paging and search, steering, approvals and user answers, native child-agent approval routing, attachment staging, file snapshots, encrypted media, Unicode splitting, uint64 IDs, owner filtering, deduplication, restart ambiguity, and reply delivery retries.
- **Native Codex connection passed.** Initialization, account status, model catalog, effective configuration, new threads, model reset, permission profiles, plan/default toggles, skills, goals, full-text session search, plugins, experimental features, and rate limits were exercised against the installed executable.
- **One real inference turn passed.** The reply was `WECHAT_CODEX_LOCAL_OK`; stored native history contained the exact submitted user text; reply capture and session resume passed. The dedicated test thread was archived.
- **WeChat credential check passed.** The existing local WeChat login was imported into separate private storage and accepted by Tencent's `getconfig` endpoint. This check did not poll for or send messages.
- **Deployment checks passed.** The systemd unit validates with `systemd-analyze --user verify`. Starting the replacement while the old imported-account poller is running is rejected as intended.

At the time of these checks, the old service was left active pending the user's handover choice. A real phone message through the replacement has **not yet been tested**. QR login's fresh-pairing/verification branches were implemented from Tencent's current protocol but have not been exercised live. File encryption and upload envelopes passed local tests; live file transfer to the user's phone remains untested. This report does not claim complete terminal-UI equivalence or full feature parity with the reference's added assistant workflows.
