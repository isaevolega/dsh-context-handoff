# Changelog

All notable changes to `dsh-context-handoff` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Fork] — 2026-11-27

### Added — the panel says what the new session will do

`resumeMode` is a plugin config field, so the only way to change it is the profile patch layer, and nothing in the UI showed the value in force: the panel could not tell a `manual` composition from a `brief` or `auto` one until a handoff had already run. `GET /context-handoff/api/state` now returns `resumeMode`, and the card prints one muted line naming it — "New session: created and left idle, the turn is yours (resumeMode=manual)", "… it reads the handoff file, names the next step, then stops (resumeMode=brief)", or "… it reads the handoff file and continues on its own (resumeMode=auto)".

The line is presentational only: an older composition that omits the field simply renders nothing.

### Added — the handoff button waits for background jobs

A background job belongs to the agent that started it: creating a new session neither carries it over nor stops it, its output stays in the old chat, and disposing that agent (`owner disposed`) cancels it. Handing off while one ran therefore abandoned the job silently.

The panel now reads the job registry (`ctx.get('jobs').list(sessionId)`, filtered to the session's own `running`/`stopping` jobs) and disables both write buttons with "Waiting for the background job", plus a line naming the job ids and the `job_kill` hint. `generate()` refuses the same case with `HANDOFF_BUSY` (HTTP 409) so an API call made between a poll and a click cannot slip through. A composition without the registry, or one whose list shape changed, reports no jobs: the guard must never break a handoff by accident.

### Added — the goal of the source session travels into the file

A goal is durable per session and its automatic-continuation authority is process-local, so a new session starts with neither: the objective simply stayed in the old chat. The handoff now records the current goal from `ctx.get('goals').get(agent)` — `goal_objective`, `goal_phase`, `goal_rounds`, `goal_max_rounds` in the frontmatter and a `## Goal (from the source session)` section at the end of the body.

### Added — and, when the handoff starts a session, into that session

The new `handoffGoal` config chooses what happens next: `file` (record only), `paused` (the default), or `armed`. In the last two the plugin re-creates the goal in the new session through `ctx.get('goals')`, passing only the remaining round allowance (`maxGoalRounds - roundsStarted`), and records `goal_transferred` / `goal_activation` in the ledger. `paused` creates and then pauses in one synchronous block, so the fresh chat shows an inactive goal that a person resumes deliberately — the same state a restarted session shows — and the round driver, which only schedules at whole-agent idle, never starts work behind the resume prompt. `armed` leaves continuation on. The section of the file states which of the three happened, and the resume prompt is untouched.

A re-creation failure (no `agents` registry, a goal already present, a service that changed shape) is logged and never fails the handoff: the file already carries the objective.

### Added — the source goal is closed once the new session owns it

Two goals for one objective is a duplicate-work trap, and a leftover that is armed or offers Resume is how the abandoned chat gets revived by accident. After a successful transfer the plugin now closes the source goal, chosen by `handoffGoalSource`: `clear` (the default — removes the current goal and writes a tombstone, making no claim about the work), `complete` (records the objective as achieved), `pause` (stops continuation but keeps a Resume chip), or `keep`.

`clear` is the default because a handoff says "somewhere else now", not "done": marking a transferred goal complete would put a false achievement in the durable log. `pause` is skipped when the phase is not `active`, since the transition table only accepts an active goal, and a failure to close is logged, never fatal. The ledger records `goal_source_closed`.

`test/plugin.test.js` covers the running-job refusal, a composition without the registry, the three goal-transfer modes, the four source-goal modes, both failure paths, and both the goal and no-goal file shapes.

The idle auto-writer treats the refusal as "not yet": it releases its cooldown reservation (`lastAuto`), so the handoff fires on the next idle event after the job settles instead of being held back for the whole cooldown window.

### Changed — the new session no longer takes the turn away from you

Pressing the button while the agent was idle still produced a new chat that began working immediately, because the handoff admitted the resume prompt through `sessionController.prompt` — the same RPC the composer uses — and any admitted prompt starts a turn. `queue` and `steer` only decide how such a prompt waits for a running turn; there is no "append without running" mode, so "leave the turn to the person" has to mean "admit nothing".

`resumeMode` now chooses: `manual` (the default) creates the session and sends nothing — the client switches to it, the composer is empty, the panel prints `New session: … · left idle, the turn is yours` together with the exact line to send; `brief` admits a prompt that reads the file, names the one next step and stops; `auto` is the old behaviour. The file, its resume line, and the goal transfer are identical in all three.

### Added — closing the source goal, and the goal transfer rounding

See the two goal entries above; both defaults (`handoffGoal: paused`, `handoffGoalSource: clear`) are chosen so a handoff never leaves two live goals behind.

### Changed — the digest asks for reasoning off

The summary runs on the session's route, so it inherits that route's reasoning effort. Measured against the real route (`deepseek-account/deepseek-flash`, `reasoningEffort: high`): a 40k-token summarization request with the handoff's own output cap (1738 tokens) spent 1358 of them on thinking, wrote text only after the thinking stopped, and finished with `max_tokens` at 1577 characters of answer. A slightly longer chain of thought leaves no room for text at all, which is the shape the ledger recorded — `the summarization model returned no text`, 0 output tokens, and an empty body.

A summary never needs chain-of-thought, so `streamSummary()` now passes `reasoningEffort` through and `generate()` asks for `"off"` first. The same request with thinking off finished in 639 output tokens, well inside the cap. When a route rejects the control with `UNSUPPORTED_REASONING_EFFORT` the plugin retries once without it, so providers that have no reasoning switch still get a model-written digest. The fallback reason also names the reasoning characters the stream produced, which separates "the model thought until the cap" from "the stream died early".

`test/plugin.test.js` covers both paths: the request carries `reasoningEffort: "off"`, and a route that throws `UNSUPPORTED_REASONING_EFFORT` still produces `generator: llm` on the second attempt.

### Changed — the route probes are opt-in

The two throwaway model calls that probed both LLM call paths before the first prompt answered their question (both paths returned 200; the failure was the signal the admission call never received), and they cost two extra requests per handoff. They now run only when DSH starts with `DSH_HANDOFF_PROBE=1`.

### Fixed — the title and the mission skip host-injected first turns

A compacted session starts with the checkpoint the host writes at the first user position, so the handoff was titled `# Handoff: This is an automatically generated checkpoint condensing an earlier span` and its mission quoted that checkpoint. The same happened to a runtime context, a skill catalog, the time note, and a workspace memo.

`extractTitle()` and the fallback digest's mission now take the first user turn that is the human's own request: a turn whose `source.kind` is set and is not `user` is skipped, as is a turn whose text starts with a host banner (`<system-reminder>`, `<workspace_memory>`, the compaction preamble). `test/digest.test.js` covers a compacted conversation and a runtime-context turn.

### Fixed — an empty model answer no longer ships an empty handoff

A handoff whose summary came back as an empty string was written with its frontmatter, the resume card, and the `# Handoff: …` heading, and nothing else: no mission, no next steps. The deterministic fallback never ran.

`generate()` assigns the sanitized answer to `body` and then throws when it is blank, so the catch block saw `body === ''` — not `undefined`, which is the test that selects the fallback digest. The empty string survived into the render and silenced the fallback. The catch now clears `body`, so a blank answer produces the full deterministic digest.

The last affected file was 208 digest tokens of shell with `summary_output_tokens: 0`, which matches the shape a reasoning route produces when its reasoning consumes the whole output cap before any text is emitted.

### Added — the failed summary now leaves evidence

The fallback reason names the finish kind and the output tokens (`… returned no text (finish stop, 0 output tokens)`), which separates "the model answered nothing" from "the stream died after its headers". The undici records of the summarization request are also flushed to `.dsh/handoff/diagnostics.log` under `summarization request (<mode> mode) after the digest fell back: <reason>`, so the raw transport of a failed digest is no longer dropped on the floor.

`test/plugin.test.js` covers the blank-answer path: a stream that ends with no text delta must still write `## Mission`, the first user request, and `## Next steps`.

### Fixed — the first prompt now really goes through prompt admission

The 0.3.5-fork.6 change that was supposed to admit the first prompt through `sessionController.prompt` never ran. Two faults kept it on the `agent.followup` fallback:

1. `controllerCall()` resolved a controller method as `(request) => direct.call(controller, request)`. It dropped every argument after the first, so `SessionController.prompt(request, signal)` was called without its signal.
2. `SessionController.prompt` opens with `signal.throwIfAborted()`. A missing signal is therefore a `TypeError`, and the `agent.followup` fallback swallowed it. The fallback only reported through `ctx.logger.warn`, which this desktop profile does not surface anywhere.

The durable evidence is the recorded message source. A typed message records `{"kind":"user","rpcId":…,"clientTimeZone":"Asia/Yekaterinburg"}`; every handoff session's first message recorded a bare `{"kind":"user"}`, and the host's context arrived as loose `<system-reminder>` text ending in `Browser time zone for this request: unavailable`.

`controllerCall()` now forwards every argument, `sendFirstPrompt()` passes `AbortSignal.timeout(30000)`, and both outcomes — admitted, or fell back with the error chain — are written to `.dsh/handoff/diagnostics.log`, so a silent fallback can no longer look like success. The controller stub in `test/panel.test.js` now mirrors the real signature and throws when the signal is missing; that is what catches this class of bug.

### Added — raw transport diagnostics

`DeepSeek Messages transport failed` reaches the session log without its cause: `@deepseek-ai/dsh-llm` converts every adapter throw into a terminal `{message, code}` failure chunk (`adapterFailureChunk` → `normalizeLlmFailure`), so `agent/error` only ever rebuilds a bare `LlmError`.

`lib/index.js` now subscribes to the Node `diagnostics_channel` events that the global `fetch` (undici) publishes — `undici:request:create`, `undici:request:headers`, `undici:request:error`, `undici:client:connectError` — and keeps a bounded ring buffer of the raw records for `api.deepseek.com`. On every `turn/end` of a session this plugin created (failed or not) the buffer is appended to `<workspace>/.dsh/handoff/diagnostics.log`.

This is subscription only: nothing is wrapped, proxied, or replaced, and the buffer is dropped with the effect scope. It answers the one question the session log cannot: did the request leave the process, and if it did not, which fetch error stopped it.

A `fetch` that rejects before the dispatcher — an unusable argument, a refused connection, a dead socket — leaves no channel event at all. That gap is closed for the one window that matters: while the new session's first turn runs, the plugin observes the global `fetch`, calls it with the same arguments, records a rejection together with its cause chain, and rethrows the very same error object. The observation is removed on the first `turn/end` of that session and by a three-minute timer, whichever comes first.

Before the first prompt is delivered, the plugin also asks the route one throwaway question over both call paths: `llm.prepareCall(...)` + `stream` (the path a turn takes, through a freshly listed connection) and `llm.stream(...)` (the path the digest and the session title take, through the cached connection). One trivial message, no tools, thirty-second cap. A failure on both proves the call path is at fault; a success on both proves the request content is.

## [Fork] — 2026-11-26

Fork of [idianzi/dsh-context-handoff](https://github.com/idianzi/dsh-context-handoff) at 0.3.4. The sidebar UI is English, and the handoff's new session is created the way the Web client creates one.

### Changed

- `lib/client.js` — the sidebar panel, the chip beside the session title, and the sidebar tab label are English instead of Chinese (38 strings). Keys, routes, polling intervals, and plugin behavior are unchanged.
- `test/client.test.js` — the tab-title assertions follow the English strings.
- `README.md` — fork note, install path for this fork, and a "Fork changes" section.
- `package.json` — `repository`, `homepage`, and `bugs` point at this fork.
- The panel report now names the new session and how it was created (`session controller` or `bare agent`), instead of always printing the manual "start a new session and send" instructions.

### Fixed

- **The new session is now the client's agent, in its workspace group.** Two faults made the handoff session useless:
  1. The plugin created it with a bare `ctx.agents.create`, which mounts no agent preset. The agent then ran with the five base tools only (no `read`, `write`, `pwsh`, `subagent`, …) and a degraded system prompt. The creation now goes through the host session controller (`sessionController.create({ workspaceId })`), which resolves and mounts the default preset exactly like "+ new chat".
  2. The workspace was never attached, so the session appeared under **Ungrouped**. The controller call passes the workspace id resolved from the session directory, and the bare fallback calls `attachSession()` itself.
- **The plugin leaves the model alone.** It never calls `sessionController.selectModel(...)`: the controller applies the deployment default, which is exactly what a hand-written "+ new chat" gets. Picking a route here would spend the user's balance on a model they did not choose for that conversation.
- **The first prompt is now admitted the way a typed one is.** `agent.followup({ source: { kind: 'user' } })` skips prompt admission: the message records a bare user source, the host has no client time zone, and it injects the runtime context, the skill catalog, and the time note as loose `<system-reminder>` text — five user messages where a typed first turn has four structured ones. `sessionController.prompt({ sessionId, requestId, mode: 'queue', content, clientTimeZone })` is the RPC the composer itself calls: it records a user-rpc source with the conversation's own time zone and lets the host attach its context as structured `runtime-context` / `skill-catalog` / `time-context` parts. `agent.followup` remains as the fallback when a composition mounts no controller. The first message also names the handoff file as a plain workspace-relative path instead of an `@` reference, which is a composer feature that a host-injected message never registers.
- **A failed handoff session now leaves evidence.** `<workspace>/.dsh/handoff/diagnostics.log` records how the session was created (path, workspace, source session) and the error chain of any `agent/error` or failed `turn/end` in a session this plugin created.
- `test/panel.test.js` — coverage for the controller path (workspace id, no model call, no bare agent, prompt admitted with the conversation's time zone), for the fallback (preset mounted, no route override, workspace attached), and for the diagnostics record.

### Reverted

- **`installLlmProbe` is gone.** 0.3.5-fork.4 wrapped `llm.prepareCall` and returned a `Proxy` that overrode `stream`, to capture the adapter error that the host drops before `agent/error`. A prepared call exposes `stream` as a non-configurable, non-writable own data property, so the `get` trap violated the Proxy invariant and every model call in the process failed with `'get' on proxy: property 'stream' is a read-only and non-configurable data property…`. Nothing wraps the LLM service any more: the plugin only listens to agent events and writes files.

## [Unreleased]

### Changed (docs only)

- `README.md` and `README.zh.md` now describe the route that actually runs instead of claiming a direct `ctx.compaction` call. On a desktop preset the backend sits inside the session's preset group, so a host-plane plugin can never reach it; the working path is the official `/compact` command through `ctx.commands.execute`. Both READMEs point at the panel's `source` field (`agent` / `context` / `command` / `none`) so a composition that genuinely lacks a backend is distinguishable from a lookup bug.
- Validated against a running desktop profile at `0.3.4`: `compaction: { available: true, source: "command", probe: { commandExecute: "function" } }`. No code change ships with this entry.
- `docs/PUBLISHING.md` gained the real market procedure: the catalog is `awesome-dsh-plugin/awesome-dsh-plugin`, one YAML file per plugin under `data/plugins/`, and the file is the whole submission. It records which requirements this repo already meets, the CI order (entry count → `dsh.bundle` → repo age → lint and site build), and that `hunyu-feng/dsh-context-handoff` already holds the name on the list.
- `examples/awesome-dsh-plugin.yml` now describes the condense-then-handoff flow instead of only the file-writing half.
- The install section of both READMEs points at `github:idianzi/dsh-context-handoff`, which works today; the npm form is marked as post-publication.

## [0.3.4] — 2026-10-27

### Added

- **Condensation can be driven through the official `/compact` command.** When the preset's backend is not reachable from the plugin (`agent.ctx.get('compaction')` returns nothing), the plugin executes `/compact` against the agent through `ctx.commands.execute`; that handler runs inside the preset scope and calls the same backend. It is the supported path when service isolation blocks a direct call.
- The lookup also retries the non-strict form `ctx.get(name, false)`, which returns a provider whose fiber is still settling.
- Tests for the command path and for a rejected `/compact` falling back to a handoff.

### Changed

- `compaction.available` is true when either the service or the command path exists, and `source` reports `agent`, `context`, `command`, or `none`.

## [0.3.3] — 2026-10-27

### Fixed

- Reading `agent.ctx.compaction` as a property throws `cannot get property "compaction" without inject`, and the panel payload read `this.ctx.compaction` unguarded, so the whole `/state` request failed. The isolated backend is now reached through `agent.ctx.get('compaction')` — the inject-free lookup the compaction backend itself uses — and every diagnostic read is guarded.
- `probe` now reports `agentGet` and the actual outcome of the agent-scoped lookup.

### Added

- Regression test for the isolated-scope lookup path.

## [0.3.2] — 2026-10-27

### Fixed

- **The compaction service is mounted per agent, not on the host plane.** DSH assembles each session from a preset, and the preset's isolated group owns `compaction` (`isolate: { compaction: true }`); a host-plane plugin can never see it through `ctx` or injection. The plugin now reads `agent.ctx.compaction`, per call and without caching, because two sessions may run under different presets with different backends. `compaction.source` reports `agent` when that path is used.
- The panel payload now carries a `probe` (`agentCompaction`, `rootCompaction`) so a composition that genuinely lacks a backend is distinguishable from a lookup bug.

## [0.3.1] — 2026-10-27

### Fixed

- **Automatic condensation never ran in the Desktop app.** The plugin only looked for the compaction service through `ctx.inject`, which never resolved in that composition, so `compaction.available` stayed `false` and every session fell back to a handoff. The service is now also resolved lazily through `ctx.get('compaction')` and `ctx.compaction` at every use, with the discovery path reported as `source` in the panel payload.
- A second `maybeAuto` pass while a condensation was in flight could call `compactNow` on a busy agent. An in-flight per-session guard now ignores the duplicate, and a busy failure backs off for a minute instead of retrying immediately.

### Added

- Regression tests for context-based service discovery and for the concurrent-condense guard.

## [0.3.0] — 2026-10-27

### Added

- **Automatic condensation at the recommendation point.** When a session crosses its recommendation threshold, the plugin calls the composition's compaction service (`ctx.compaction.compactNow`) before doing anything else. There is no switch for this step.
- `maxCompactionsPerSession` (default `3`): a session is condensed at most this many times, each condense is logged with its before/after token counts, and a condense that frees less than 10% of the context ends the session's budget immediately instead of looping.
- **The handoff is now the fallback, not the first step.** A handoff file and a new session are only produced when the context is still at or above the recommendation point after condensing. The workspace switch now gates this step only: off means condense but never switch sessions.
- The panel reports how many automatic condensations a session has used and the tokens it moved (`before → after`).
- Four tests covering condense-then-recover, condense-then-fallback, condense with the switch off, and the per-session budget.

### Changed

- The panel's subtitle and footer now describe the two-stage behavior.

## [0.2.5] — 2026-10-27

### Added

- A session-header chip (`上下文 545k`, or `自动总结 545k` while auto mode is on) registered at `conversation.session.header.actions`. It shows the current context size, turns amber past the recommendation point, and opens the handoff panel on click — so the switch is reachable without knowing that the right sidebar exists.

### Fixed

- The panel now takes its session from the slot framework's session-scoped `sessionId` prop first and only falls back to DOM lookup, so a panel that mounts before the sidebar writes its marker can no longer show "先打开一个会话" or the wrong session.

## [0.2.4] — 2026-10-27

### Fixed

- The sidebar panel resolves its session from its own right-sidebar DOM owner (`closest('[data-sidebar-right-session]')`) before falling back to a visible owner or main-view retention. A tab that mounted before retention, or a background session kept mounted, can no longer steal the switch or poll a stale session.
- Added a brief retry poll while the session marker is not written yet.
- Added a loading state, a visible text toggle (`开启自动总结` / `关闭自动总结`), an unavailable-state label, and a retry button, so the panel no longer reports "已关闭" before it has read the host state or when the request fails.
- Warn when the current context is already past the recommendation point, so enabling auto mode is not a surprise.

## [0.2.1] — 2026-10-27

### Fixed

- The sidebar panel resolves its session from the right-sidebar DOM marker first, then from `sessions.list` retention. A tab that mounted before the main-view retention was set no longer shows "先打开一个会话" forever.
- Added a visible text toggle (`开启自动总结` / `关闭自动总结`) beside the small switch, and a loading state so the panel no longer says "已关闭" before the first state response.
- State errors now show the error and a retry button instead of leaving the switch disabled with no explanation.
- Added a brief poll when the session marker has not been written yet, instead of waiting for an unrelated session-list event.

## [0.2.0] — 2026-10-27

### Added

- Right-sidebar **Context Handoff** panel: per-workspace auto switch, current pressure, recommendation point, progress bar, file-only and file-plus-new-session actions.
- Automatic new-session flow: when auto mode fires, the host writes the file, creates a new root session in the same workspace, and queues the `Read @...` resume prompt. The panel switches to it when the source session is on screen.
- `/handoff auto [on|off]` as a command-level equivalent of the sidebar switch.
- Per-workspace switch persistence in `.dsh/handoff/auto.json`.
- HTTP bridge for the panel with same-origin/custom-header mutation checks.
- `recommendMaxTokens` (default 256k) as an absolute cap so large windows do not wait indefinitely; `0` disables it.
- `autoNewSession` (default true) to disable automatic session creation while keeping file generation.
- Client test that loads the browser bundle and verifies tab/pane registration; host tests for the panel bridge, auto state, new-session creation, and threshold caps.

### Changed

- **Recommendation point is earlier and bounded**: default `recommendAtRatio` is now `0.55`, capped by `recommendMaxTokens` and the window reserve. For a 128k window the default point is **70.4k tokens**; 32k → 17.6k; 200k → 110k; 1M → 256k.
- Fixed prefix `S` now prefers the host's `contextBreakdown` projection when available, instead of deriving it only from provider usage totals.
- Model-window lookup is cached per provider/model, so sidebar polling does not repeat metadata resolution.
- Auto mode is evaluated per workspace and completed once per source session.

### Fixed

- Unknown model windows now fall back to the economic break-even point instead of `Infinity`.
- The panel and line output keep the source session, new session, and digest numbers consistent.

## [0.1.0] — 2026-10-27

### Added

- `/handoff` command: LLM-written, self-contained Markdown handoff with a copy-paste resume line.
- `/handoff plan [turns]`: cache-adjusted token comparison, break-even turns, economic threshold, and quality-aware recommendation.
- `/handoff now [tokens]` with an explicit digest budget.
- `/handoff status`, `/handoff list`, and `/handoff stats`.
- Optional idle-time auto mode through `agent.runMaintenance()`, with growth and cooldown guards.
- Deterministic fallback digest when no model is available or summarization fails.
- Budget enforcement that preserves the opening summary and the trailing next-steps section.
- Prefix-replay summary requests (warm provider cache) with a budgeted plain-text transcript fallback.
- Best-effort secret redaction for common API keys, tokens, and private keys.
- Atomic writes, retention pruning that never touches unrelated Markdown, and an append-only JSONL ledger.
- `dsh.bundle` manifest, config schema, and market catalog entry.
- 31 `node:test` tests covering economics, digest construction, file handling, and plugin integration.

### Verified

- DSH Desktop 0.2.1-rc.3: bundle composition, config-schema import, plugin load, and `/handoff` command registration in a disposable Web profile. Command execution, model calls, fallback, and ledger behavior are covered by the test suite with stubbed services.

[Unreleased]: https://github.com/idianzi/dsh-context-handoff/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.4
[0.2.1]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.1
[0.2.0]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.2.0
[0.1.0]: https://github.com/idianzi/dsh-context-handoff/releases/tag/v0.1.0
