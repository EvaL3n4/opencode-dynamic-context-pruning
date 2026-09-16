# OpenCode V2 migration journal

## Current status

The first migration pass is implemented for **V2 2.0.4** and **V1 1.18.29+**.
Packed server tests pass for both hosts; V2 range/message compression works over
HTTP and WebSockets. Real Codex-backed compression and both terminal panels have
also passed. Changes are local and unpublished.

Intentional limitations: V2 `ask` is blocked, invisible chat reports use a no-display
extension point, and the self-updater remains V1-only. See verification and remaining
coverage below before treating this as a release-ready compatibility guarantee.

## Goal and decisions

Port DCP to OpenCode V2 while retaining V1 support. Investigate architecture and
existing behavior first, establish an isolated test environment with request and
response capture, then migrate and test features incrementally.

- 2026-09-16: user selected **OpenCode 1.18.29+** as the V1 compatibility floor.
  V2 documents a shared default export with `id`, `setup()` (V2), and `server()`
  (V1). The two implementations still use different APIs.
- User selected **2.0.4** as the first V2 target.
- User requested migrating the existing DCP terminal panel in this pass as well.
- Preserve duplicate/error pruning timing: run these strategies when `compress`
  runs. The user confirmed this deliberately limits prompt-cache invalidation.
- Compaction must apply the same DCP body edits and preserve the existing cache
  prefix. Replay existing nudges, but do not introduce new ones (user clarification).
- User approved omitting V2 displays for V1 `ignored` reports for now. Leave a
  small reporting extension point, without building a replacement UI.
- Live smoke tests should use the user's configured `openai/gpt-5.6-sol` model.
- V2 `compress: ask` will be blocked with a clear error for now (user decision).
  Custom tools must request permission themselves, but the public V2 plugin
  context exposes only permission list/get/reply and hooks. `options.permission`
  controls denied-tool visibility, not an ask dialog.
- Keep this journal updated with evidence, decisions, test results, and open
  questions. Do not infer feature parity from successful plugin loading alone.

## Verified environment

| Item                  | Evidence                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| OpenCode V1 source    | `/home/dan/src/opencode`, `dev` at `501ff62cbf`; `packages/opencode/package.json` reports `1.18.31`      |
| OpenCode V2 source    | same repository, `v2` at `cda2bc5100`; `packages/cli/package.json` reports `2.0.4`                       |
| Source checkout       | currently on `dev`; inspect V2 separately                                                                |
| Installed V1          | `opencode --version`: `1.18.30`                                                                          |
| Installed V2          | `opencode2 --version`: `v0.0.0-beta-19425`; this differs from the V2 branch/release                      |
| Launch configuration  | `.bashrc`: `oc1` uses `~/src/opencode-config`; `oc2` uses `~/src/opencode-config/v2`                     |
| Provider routing      | both normal configurations use local provider proxies; clean tests need their own provider configuration |
| Container runtime     | Docker available, server `29.7.2`                                                                        |
| DCP starting state    | `dev`, clean working tree, package version `3.1.15`                                                      |
| Logger starting state | separate repository at `../opencode-request-logger`, `main`; pre-existing untracked `bun.lock`           |

Credential locations have been identified without copying credentials into this
repository. Test credentials and traffic logs belong in isolated runtime storage.

## Sources

- <https://opencode.ai/v2/docs/migrate-v1>
- <https://opencode.ai/v2/docs/build/plugins>
- <https://opencode.ai/v2/docs/build/plugins/migrate-v1>
- Local OpenCode branch snapshots listed above.

## Initial architecture findings

- V1 plugins return a hook/tool object from a function. V2 plugins register domain
  hooks and synchronous registry transforms from `setup(ctx)`.
- V2's context is also the server client; V1's separate `ctx.client` and old SDK
  request/response envelopes do not carry over.
- V1 system/message transforms converge into V2's `session.hook("context")`.
  V2 separates primary requests, compaction, title generation, and transient
  generation into distinct hooks.
- Context edits affect outgoing requests, not persisted conversation history.
- V2 commands have registered executors; tools use JSON Schema and structured
  results. There is no mutable global config hook.
- V2 has no direct equivalent to `experimental.text.complete`.
- V2 plugin instances are location-scoped and may observe multiple sessions;
  DCP's current single mutable session state needs careful review for concurrency.
- Public HTTP request/response hooks support native provider capture. WebSocket
  traffic bypasses them; the documented experimental WebSocket hook exposes only
  handshake URL/headers. Frame capture requires further source investigation.

## Existing DCP map (investigation in progress)

- `index.ts`: initialization, V1 hook wiring, compression tool selection, config
  changes, command registration, permission snapshots, update checks.
- `lib/hooks.ts`: system instructions; message cleanup, stable references,
  compression sync, tool cache, pruning, subagent results, nudges, message tags;
  commands; output tag stripping; compression timing events.
- `lib/state/`: current session, pruning records, compressed blocks, message IDs,
  token counters, persisted manual mode, compaction resets.
- `lib/messages/prune.ts`: summary insertion/removal and output/input pruning;
  special handling for question/edit/write results.
- `lib/compress/`: validate all ranges before applying state; expand nested block
  placeholders and append omitted required summaries; preserve protected user
  text, `<protect>` sections, tool outputs, and file patterns. Message mode skips
  invalid/protected/already-compressed selections and groups diagnostics.
- `lib/compress/pipeline.ts`: manual-mode gate, permission request, history read,
  ID assignment, duplicate/error strategies, persistence, and notifications.
- `lib/strategies/`: deduplicate by tool name and normalized/sorted parameters,
  keeping the newest; remove old failed-tool inputs while retaining errors.
- `lib/messages/sync.ts`: replay block activation from surviving compression
  origins, consumed blocks, and user decompression flags (important for undo).
- `lib/messages/inject/`: stable nudge anchors above configured model/token
  thresholds; IDs on text/tool results; user protection; manual trigger injection.
- `lib/token-utils.ts`: provider-reported usage plus approximate tokenizer counts;
  V1's token fields and compaction markers need explicit V2 translation.
- `lib/commands/`: context/stats reports, sweep with tool/file protections,
  persisted manual toggle, compression prompt, decompress/recompress block groups.
- `lib/ui/notification.ts`: V1 chat output uses `noReply` plus `ignored` text so
  reports never enter model context. V2 synthetic messages are model-visible and
  are not an equivalent replacement; UI delivery needs an explicit design.
- `tui.tsx` and `lib/tui/`: a separate V1 CLI plugin owns `/dcp` panels and reads
  filesystem state. V2 has a different CLI context, theme, keymap, and data API.
- `lib/config.ts` and `lib/prompts/store.ts`: global, config-directory, and nearest
  `.opencode` overrides; custom prompt files; V1 toast warnings. Preserve existing
  configuration semantics while adapting host dependencies.
- `scripts/verify-package.mjs`: verifies both server and CLI entrypoints and npm
  tarball contents. Shared entrypoint changes must also pass packed-host loading.

## V2 source findings

V2 is inspected in a detached worktree at `/tmp/opencode/dcp-v2-source`.

- `packages/ai/src/schema/messages.ts`: canonical model messages have optional
  IDs, roles, and typed content (text, reasoning, media, call, result, effort,
  provider compaction). Tool results can contain structured multimodal content.
- `packages/core/src/session/runner/to-llm-message.ts`: a persisted assistant
  message becomes one assistant message plus tool-result messages. The latter
  have no message ID; correlate them through tool call IDs. Hosted tools remain
  in assistant content. Preserve native content and provider metadata rather than
  round-tripping all V2 messages through V1 shapes.
- Same converter handles provider/model switching, native checkpoints, skills,
  shell output, and working-directory changes before DCP sees the request.
- `packages/core/src/session/model-request.ts`: hooks precede provider lowering;
  HTTP hooks wrap fallback too. WebSocket handshake hooks do not expose frames.
- `packages/schema/src/session-message.ts`: persisted history has explicit
  compaction/idle/model/agent/location events. V1 `step-start` and summary flags
  are not present. DCP's current “turn” counters count model steps, not V2 idle
  turn markers; keep this distinction explicit.
- `packages/http-recorder/README.md`: upstream has an Effect-layer HTTP/WS
  cassette recorder for embedded tests. Public plugins cannot replace the live
  server's transport layer through this API. A local recording relay can observe
  real CLI traffic without patching OpenCode internals.
- V2 has an `auth.json` migration (`20260805200742_import_legacy_credentials.ts`),
  but fresh database bootstrap marks all migrations complete without running them.
  Copying `auth.json` into a clean home does **not** import credentials. Confirmed
  by the first live test and a read-only inspection of a copied test database.

## Logging findings

The old logger wraps global `fetch` and a V1 request option. It captures JSON
request bodies only, uses mutable global session attribution, never captures
responses or WebSocket frames, and its WeakSet deduplication cannot match bodies
parsed into a fresh object each time. V2 migration should use supported hooks
where available and test streaming behavior explicitly.

## Planned milestones

1. Complete the architecture and DCP behavior map; resolve semantic ambiguities.
2. Establish a pinned clean V2 container, response/request capture, and a parser
   that reports assertions and compact summaries rather than dumping transcripts.
3. Implement the shared package entrypoint and first independently testable DCP
   features; preserve V1 behavior through its own API.
4. Migrate compression, protections, commands, persistence, and UI with focused
   integration scenarios, including concurrent sessions and WebSocket requests.
5. Test packed installation on V2 and V1 1.18.29, document supported features and
   outstanding gaps precisely.

## Validation so far

- Existing DCP baseline: **103 tests passed**, zero failed (`npm test`), before
  any DCP runtime changes. Output: `/tmp/opencode/dcp-baseline.log`.
- Container image `dcp-lab:2.0.4` built from `tests/lab/Dockerfile`.
  Binaries actually executed and report **2.0.4** and **1.18.29**.
- Logger now has the shared V1/V2 entrypoint, native V2 context/HTTP hooks,
  streaming response capture, and optional WebSocket recording relay.
- Logger tests: **3 passed** covering interleaved session attribution and exact
  response bytes, cancellation propagation, and reusable text/binary WebSockets.
- `scripts/lab.mjs` packs the logger and installs it in an isolated container home.
  `tests/lab/run.mjs` drives both host versions against a deterministic Responses
  provider. `tests/lab/inspect.mjs` parses captures and prints compact summaries.
- Packed logger integration passed on V2 HTTP, V2 WebSocket, and V1 HTTP in
  `/tmp/opencode/dcp-lab/2026-09-16T14-00-14-748Z`. Captured request bodies match
  the fake provider's received bodies exactly, without duplicate captures.
- V2 primary/title HTTP responses contain `response.completed`, but OpenCode
  cancels consumption before stream EOF. The harness asserts protocol completion
  as well as recording the actual stream termination (cancelled vs EOF).
- Packed installation exposed two issues fixed in the logger: include compiled
  helpers in npm files; add root `server.js` for V2 local-directory discovery.
  `Host.resolve` probes root server/index files for directories, not package main.
- The first live attempt failed with missing authentication. The old OpenCode
  token had expired; the Codex token is current. `--live` now copies only Codex's
  access token/account into isolated runtime storage and supplies them through
  environment substitutions with the Codex endpoint. This tests real model
  transport, not OAuth login/refresh or legacy credential migration.
- V2's type package requires newer optional OpenTUI peers than V1. For development,
  install with `npm install --legacy-peer-deps`; keep V1's runtime UI dependencies.
  V2 imports are type-only at this stage, so they do not load its terminal runtime.

## First DCP implementation (under test)

- Shared root entrypoint now exposes V2 `setup` and legacy `server`.
- V2 uses per-session state and serializes operations within a session. Existing
  compression, persistence, nudges, protections, and command algorithms are reused.
- Native messages are projected only for DCP bookkeeping. Edits are applied to
  the original native structure, preserving reasoning, media, and provider metadata.
  ID-less tool results are correlated with their assistant by tool-call ID.
- Compression runs deduplication/error pruning at its original cache-breaking
  point. Native compaction checkpoints are excluded from selectable messages.
- V2 reports have a no-display extension point, per the user's decision. The
  existing panel's views are shared with a native V2 CLI setup, keymap, dialogs,
  and theme adapter. A typed RPC supplies server-owned context/stats/manual state;
  the V2 UI does not read or write server persistence files directly.
- Live logger checks passed over HTTP and WebSockets with `openai/gpt-5.6-sol` at
  `/tmp/opencode/dcp-lab/2026-09-16T14-05-29-833Z` (expected reply on both).
- The packed lab now exercises real compression tool execution, both compression
  modes, actual outgoing context removal, tool-call pairing, and WS prefix reset.
  All five scenarios passed at `/tmp/opencode/dcp-lab/2026-09-16T14-12-27-520Z`:
  V2 range/message over HTTP/WS, plus packed V1 1.18.29 range compression.
- Unit suite after the first native adapter: **107 passed**, zero failed.
- At this milestone the terminal panel port was implemented but still awaiting
  runtime/UI validation; see the later results below.

### Code Mode and native subagents

- V2 records nested Code Mode tool names/inputs in `metadata.toolCalls`, but
  retains only a combined `execute` output. The user approved protecting that
  entire output if any nested tool or file matches a protection rule. Compression,
  sweep, deduplication, and error pruning now share this protection check.
- Native `subagent` calls use `metadata.sessionID` and a `<subagent ...>` wrapper.
  Shared expansion now recognizes these alongside V1's `task`/`sessionId`/
  `<task_result>` forms. The V2 context hook invokes the shared expansion step.
- Panel integration exposed two boundary details: foreground V2 servers require
  Basic authentication (the lab uses its own fixed test password), and RPC outputs
  must omit optional fields rather than include properties valued `undefined`.

### Expanded verification

- Packed integration passed all five transport/mode scenarios again at
  `/tmp/opencode/dcp-lab/2026-09-16T14-28-51-739Z`. The V2 HTTP range scenario also
  passed RPC snapshot/manual controls, command-based decompress/recompress,
  explicit allow/deny/unsupported-ask behavior, concurrent sessions, and state
  restoration after a server restart.
- Actual DCP compression passed against `openai/gpt-5.6-sol` over both HTTP and
  WebSockets at `/tmp/opencode/dcp-lab/2026-09-16T14-29-49-827Z`. Each session made
  exactly one successful compression, replaced the disposable source text in
  subsequent wire context, persisted one active block, and returned the expected
  final text. The first fixture accidentally compressed away its own reply
  instruction; preserving that instruction in the fixture summary fixed the test.
- Native checkpoint coverage now includes compressing an assistant after all
  ordinary user messages were replaced by a checkpoint. Summary construction uses
  native session fields without making the checkpoint selectable or modifying it.
- Terminal testing found that V1 requires its separate `tui.json` plugin entry;
  adding only a server plugin does not register the panel. The lab now supplies it.
- V2's first terminal run failed while loading a second, older OpenTUI runtime
  (`OPENTUI_FORCE_WCWIDTH` registered with different settings). The shared views
  now use intrinsic `<b>` elements instead of importing core solely for its bold
  enum. V1's complete panel/Context/Stats/manual-toggle/close test now passes.
- V2's next terminal failure (`Keymap.Provider is missing`) exposed a CLI lifecycle
  requirement: `keymap.layer` is component-owned and cannot run in async plugin
  setup. The adapter now follows V2's built-in stats plugin: register a nonvisual
  app slot and create a global keymap layer from its render function.
- Packed checks passed again at `/tmp/opencode/dcp-lab/2026-09-16T14-45-16-512Z`,
  including a completed native local compaction. Parsed outgoing requests prove
  that its shared message prefix and system instructions match the preceding
  primary request. Block activation is synchronized against full durable history,
  because a compaction request may select a prefix that excludes block origins.
- The full unit run had 112 passes and one incomplete nudge fixture; after supplying
  its missing prompt strings, the targeted nudge test passed. It verifies existing
  anchor replay, unchanged message prefix, and no new anchors during compaction.
- V2's complete terminal test now passes too: panel, Context, Stats, manual toggle
  verified in persisted state, and close. Its keymap uses global mode, and the PTY
  test accounts for V2's two-step autocomplete/submission of argument-taking slash
  commands. Final UI fixes were deployed into the isolated installed package for
  these narrow tests; server checks used packed artifacts. V2 frames/transcript are
  under `/tmp/opencode/dcp-lab/2026-09-16T14-45-16-512Z/runtime/v2-http-range/`;
  the successful V1 run used the `2026-09-16T14-28-51-739Z` lab directory.
- Final `npm run check:package` passed (bundle, TypeScript declarations, import
  compatibility, packed-file checks); `git diff --check` also passed.
- Repacked the final implementation to
  `/tmp/opencode/dcp-ui-final/tarquinen-opencode-dcp-3.1.15.tgz`, installed it into
  the `2026-09-16T14-45-16-512Z` lab, and reran both terminal tests. **V1 and V2
  both passed** panel, Context, Stats, persisted manual-mode toggle, and close
  against that installed tarball. Final outputs are
  `/tmp/opencode/dcp-ui-v1-final.log` and `/tmp/opencode/dcp-ui-v2-final.log`;
  frames/transcripts are in the respective scenario directories in that lab.

## Remaining coverage and API gaps

- V2 has no public custom-tool permission-request method. `allow` and `deny` are
  exercised; `ask` produces an explicit error without compression.
- V1 ignored-message reports have no equivalent in the V2 model history API. The
  `report` function in `lib/v2/index.ts` is the agreed extension point; panel data
  is available through typed RPC. Self-updating is currently V1-only.
- V2 has no documented counterpart to V1's `experimental.text.complete` cleanup.
  Outgoing-context tag cleanup is implemented; generated visible text is not
  rewritten by the V2 adapter.
- Real provider checks cover OpenAI Responses via Codex over HTTP/WS. Other
  providers and provider-native compaction endpoints/triggers have not been run
  end-to-end. Local native compaction and opaque checkpoint preservation are
  covered by integration and adapter tests respectively.
- Code Mode combined-output protection and native subagent formats are covered
  by focused tests; a complete real-model nested-subagent workflow is not covered.
- Live tests use an existing access token; they do not exercise OAuth refresh or
  V1 credential/database migration. Fresh V2 database bootstrap skips the legacy
  credential-import migration, as described above.
- Development installation needs `--legacy-peer-deps` because V1 and V2's type
  packages advertise different optional OpenTUI peers. Packed runtime installation
  and both hosts' panel rendering were exercised with the retained V1 dependencies.

## Reproducing the lab

### Reusable manual launcher

- `scripts/sandbox.mjs` (`npm run sandbox` or `dcp-sandbox`) runs an isolated
  Docker environment from `scripts/sandbox/`. Sessions, scratch files, DCP config,
  and CLI preferences persist. `--fresh` selects an empty profile without deleting
  others. The current Codex access token is read at launch without token refresh.
- Each launch builds and packs the current DCP and sibling logger checkout; npm
  pack output determines artifact filenames rather than hardcoding plugin versions.
  Only the sandbox, packed inputs, and runner are mounted. The container gets its
  own home/XDG paths in an initially empty project. V2 uses a standalone server.
- Default V2 settings are OpenCode 2.0.4, `openai/gpt-5.6-sol`, and WebSockets.
  `--v1` selects OpenCode 1.18.29 over HTTP with independent state under `v1/`
  and panel registration in `tui.json`. Exact versions below V1 1.18.29 and V1
  WebSocket selection are rejected. `--update` selects the latest release of the
  chosen major; version/model/transport choices are remembered per major.
- Minimal token/account inputs are mode 0600 and removed after the container exits;
  normal credentials are read only. No token values appear in config or commands.
- `~/.local/bin/dcp-sandbox` is a symlink to the executable launcher.
  It can run from any directory; no shell configuration edits are needed.
- The launcher creates the scratch directory before mounting, keeping it writable
  by the user's UID. Cached image builds honor Dockerfile changes.

### Automatic readable logs

- Each launch has `raw/` and `readable/` directories. The launcher manages the
  WebSocket relay and the sibling logger's `readable.mjs` watcher throughout the
  session. `--logs` shows paths and capture counts; it does not generate files.
- The watcher publishes requests as they are captured and responses on protocol
  completion, including over reusable WebSockets and HTTP streams that remain
  open. Context snapshots appear as they are captured. Cancellation, socket loss,
  and shutdown preserve available partial output with incomplete metadata.
- Appended stream bytes are read once using per-file offsets and UTF-8 decoding;
  only active response assembly state is retained. JSON metadata is published
  atomically, so readers see complete documents. Raw captures remain intact.
- A session has numbered HTTP/WS request folders containing `request.json`,
  `response.json`, and `meta.json`. Requests retain the actual wire body, including
  WebSocket continuation deltas. Responses contain assistant text, readable
  thinking, parsed tool input, aggregate usage, and errors. Echoed prompts, tool
  definitions, encrypted state, and attribution details remain in raw captures.
  IDs, transport, continuation, and completion information belong in metadata.
- Codex SSE is recognized with or without Content-Type. Completed streamed items
  supply response content when the final event has an empty output array.

### Sandbox verification

- Real Codex-backed runs passed on V1 1.18.29 (HTTP) and V2 2.0.4 (WebSocket):
  each compressed once, replaced the raw fixture with its summary on the wire,
  returned the expected final reply, and removed its temporary auth input.
  Readable output assembled all three requests per run (V2's title used HTTP),
  with zero incomplete responses. Evidence: `/tmp/opencode/dcp-dual-check/`,
  `/tmp/opencode/dcp-sandbox-v1.log`, `/tmp/opencode/dcp-sandbox-v2-new.log`.
- Readable-log tests cover full/incremental WS requests, mixed HTTP/WS sessions,
  split UTF-8, preserved raw bodies, interrupted responses, incomplete trailing
  frames, tool-call assembly, and provider errors. Live-publication verification
  includes requests before any response and replies before transport shutdown.
  All eight logger tests pass, including overlapping HTTP requests completing in
  reverse order and partial replies published when a socket closes. The logger
  build and whitespace checks in both repositories pass.
- Live sandbox checks confirm readable requests appear while pending and completed
  replies are available before closing the terminal: V1 HTTP at
  `/tmp/opencode/dcp-dual-check/v1/profiles/default/logs/2026-09-16T16-10-53-529Z`
  and V2 WebSocket at
  `/tmp/opencode/dcp-dual-check/profiles/default/logs/2026-09-16T16-12-14-679Z`.
  Both terminals exited cleanly. Results and terminal frames are recorded in
  `/tmp/opencode/live-logs-v1.log`, `/tmp/opencode/live-logs-v2.log`, and adjacent
  `.frames.json` files. `--logs` was verified to leave file sizes and modification
  times unchanged.
- PTY validation of the actual `dcp-sandbox --v1 -- --continue` shortcut resumed
  the V1 test session, opened/closed `/dcp`, and exited cleanly with deliberately
  invalid host OpenCode config/password variables. Output:
  `/tmp/opencode/dcp-dual-ui-v1.log`. V1 and V2 retain separate profile databases.
- CLI checks confirmed default V2 selection, separate per-major paths, explicit
  version inference, V1's minimum version (including prerelease rejection at the
  boundary), incompatible major/transport rejection, and V1 update lookup
  resolving to 1.18.31. Whitespace checks passed in both repositories.
- PTY environment-isolation checks used deliberately invalid host OpenCode config
  and password variables, resumed sessions, opened/closed the panel, and exited
  cleanly: `/tmp/opencode/dcp-sandbox-ui.log` and accompanying frames. Fresh-profile
  checks covered writable scratch space, retained prior sessions, remembered
  settings, version selection, and auth-file cleanup.

### Automated migration checks

```sh
npm install --legacy-peer-deps
docker build -t dcp-lab:2.0.4 tests/lab
node scripts/lab.mjs
# After a successful build, test the existing artifact without rebuilding:
node scripts/lab.mjs --built
# Uses the current Codex access token/account in an isolated container:
node scripts/lab.mjs --live
```

The driver prints its output directory under `/tmp/opencode/dcp-lab/`. It packs
this plugin and the sibling `opencode-request-logger` repository, installs them in
the container, and keeps configs, databases, raw captures, and compact result JSON
there. `--live` uses the existing build and tests actual compression on the wire;
it does not test OAuth refresh. Inspect captures with
`node tests/lab/inspect.mjs <log-directory>`.

Terminal tests reopen a completed lab session and exercise the panel, Context,
Stats, manual-mode toggle, and close action:

```sh
uv run --with pexpect --with pyte tests/lab/ui.py <lab-output-directory> v2
uv run --with pexpect --with pyte tests/lab/ui.py <lab-output-directory> v1
```

Terminal transcripts/screens are saved beside each scenario's result JSON. These
tests use only the isolated container homes, not the running user's service.
