# Reference comparison

The reference program is Gan-Xing/CodexBridge. This table makes scope explicit: native Codex controls are retained; features requiring a separate assistant workflow, injected instructions, or provider routing are excluded in accordance with the requested design.

| Reference feature | This implementation |
| --- | --- |
| WeChat QR login, long polling, owner replies | Independently implemented using Tencent iLink |
| New sessions, browse, open, preview, rename | Native Codex threads; numeric list selection; fork and archive also available |
| Search and natural-language thread management | Native full-text `/search`; explicit commands for changes; no model-based classifier or hidden selection task |
| Pinning, bridge aliases, AI batch deletion | Not recreated; native names and archiving are used |
| Model catalog, metadata, reasoning effort, fast mode | Read/set through native methods; no hardcoded model catalog or reasoning downgrade |
| Status, token usage, rate limits | Native model/session settings, usage events, and account rate-limit response |
| Approval/denial and user questions | Native request IDs mapped to visible one-time IDs; no implicit acceptance |
| Permission presets | Native allowed permission profiles; no bridge-defined full-access default |
| Plan mode and code review | Native plan/default mode and `review/start` |
| Skills and plugins | Native discovery/details and skill enablement/plugin installation; disclosure-dependent plugin setup remains local |
| Experimental features, goals, agents | Native controls; native spawned-agent approvals route to the same owner |
| Custom `/instructions`, personality rewriting | No instruction editing. `/instructions` shows native instruction-source paths. Personality selector is deprecated in installed Codex |
| Provider switching, API-compatible adapters | No implementation; `/provider` displays the native provider already configured by the user |
| Account pools | No implementation; native account status/login only |
| Upload batching and text/image/file/video/voice transport | Local staging; native image/file inputs; existing WeChat voice transcription when present |
| Bridge-specific automatic artifact pickup | Explicit `/download filename` from the dedicated export folder; no artifact instructions added to model context |
| Assistant logs, notes, todos, reminders, Weibo | Excluded assistant workflows |
| Bridge-created automation jobs | Excluded; native goals are supported when explicitly requested |
| Retry and reconnect/restart | Explicit last-input retry, separate delivery retry, local Codex-child restart; no automatic task replay |
| Interface language | English/Chinese help; no model-language instruction; native errors remain unchanged |
| Background services | Prepared Linux systemd user unit; macOS/Windows service installers are not included |

Reopening an old session resumes its old context. A fresh `/new` session avoids importing that old context, but still honors the normal instructions configured for the selected project, exactly as the native harness does.
