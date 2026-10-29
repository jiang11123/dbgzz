# Workflow Settings Editor Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation and review; root owns integration. User has explicitly requested continuous implementation of the reviewed design.

**Goal:** Ship a usable general workflow node editor, immutable template versions, and explicit instance upgrades.

**Architecture:** Operation descriptors drive ports and settings. Backend owns compilation, execution and version snapshots; React edits a detached graph draft and saves with optimistic concurrency. Existing canvas instances pin revisions.

**Tech Stack:** Existing React/TypeScript/AntD, Go/Gin/GORM/SQLite and native media runtime; no additional dependencies.

**Spec:** ../specs/2026-10-20-workflow-settings-editor-design.md

## Global Constraints

- Current `.workspaces/beeftv` checkout and `/Applications/BeefTV.app` only; preserve all other changes.
- User authorized implementation; choose subagent-driven execution for isolated backend implementation and fresh review. Do not create scratch directories, worktrees, branches, commits or PRs.
- Keep task evidence and rulings here instead of skill scratch directories, per workspace rules.
- No automatic paid model requests. Validate through focused checks and installed App operations.

## Shared contract

- Template adds `revision: number`; legacy template/instance revision is 1.
- Node adds role `operation`, `operationId`, `operationVersion`, `config: Record<string, string | number | boolean>`; preserve legacy generation/depth for migration.
- Operations: `generate.image`, `generate.video`, `generate.audio`, `generate.text`, `video.depth`, `video.trim`, `video.merge`.
- Edge adds `fromPort`, `toPort`, `order`; default output port is `output`; local video operations consume `video` (trim/depth) or `videos` (merge). Model input ports map to named reference slots and prompt.
- `GET /canvas-workflow-operations` -> `{ operations: WorkflowOperation[] }`.
- Descriptor: `{id,version,name,outputType,inputs:[{id,label,mediaType,required,multiple}],fields:[{key,label,type,min?,max?,options?:[{label,value}]}]}`.
- `GET /canvas-workflows/:id/editor?revision=N` -> `{workflow, operations}`; safe public parameters only.
- `PUT /canvas-workflows/:id` accepts `{name,description,definition,expectedRevision}` and returns updated CanvasWorkflow.
- `POST /canvas-workflows/validate` accepts `{definition,templateId?,templateRevision?}`; backend compiles and returns `{valid:true,definition}` with the canonical safe graph or ordinary structured failure.
- Run request adds `templateRevision`; idempotency covers revision. Public run includes templateRevision.

## Review Focus

1. Editing a model prompt must rebuild substitutions; no old string offsets after edit.
2. Multiple references and merge order must use explicit ports/order rather than incidental array order.
3. Save conflict retains the draft; old revision remains executable and secrets never enter public data.
4. Instance upgrade preserves only compatible inputs, clears old run/results, and undo restores exact prior graph.
5. Pure trim/merge works without model requirements; cancellation/restart and resource references remain correct.

### Task 1: Backend operations, safe editing and revisions

Files: `backend/internal/canvasworkflow/`, `backend/internal/app/canvas_workflow*.go`, `backend/internal/handler/canvas_workflow.go`, `backend/internal/model/models_canvas_workflow.go`, `backend/internal/database/local_schema.go` and adjacent focused tests.

- [ ] Read existing recipe binding, credential refresh, native media and scheduler paths.
- [ ] Add failing checks for revision execution/conflict, safe edit payload, operation port validation, trim-only graph, prompt rebinding and ordered merge.
- [ ] Implement shared contract, immutable revision storage and reference protection in transactions.
- [ ] Register adapters using existing generation/depth/media runtime paths; unsupported capabilities cannot advertise availability.
- [ ] Run focused Go checks and return precise evidence and limitations for root review.

### Task 2: Editor and API contract

Files: `web/src/services/api/canvas-workflows.ts`, `web/src/lib/canvas/workflow-editor.ts`, `web/src/pages/canvas/canvas-workflow-editor.tsx`, `canvas-workflow-workspace.tsx`, adjacent tests.

- [ ] Add typed shared API contracts and graph draft helpers with node/edge undo and validation.
- [ ] Implement detached AppModal with node palette, SVG connections, pointer graph navigation and selected-node properties.
- [ ] Add input/constant/local processing nodes and import successful canvas generation provenance.
- [ ] Support explicit ports/order, output marking, schema-driven parameters, safe detail loading, save conflict and unsaved exit.
- [ ] Verify graph mutations and public UI boundaries with focused checks.

### Task 3: Version-pinned instances and upgrades

Files: `web/src/lib/canvas/reusable-workflow-instance.ts`, `web/src/pages/canvas/use-canvas-workflow-instances.ts`, `web/src/components/canvas/nodes/reusable-workflow-node.tsx`, `web/src/types/canvas.ts`, adjacent tests.

- [ ] Pin revision at creation and submission; treat operations generically in layout, labels and progress.
- [ ] Detect available newer revision and offer explicit update with changed node/input summary.
- [ ] Replace one instance atomically, keep stable compatible inputs, clear stale outputs, forbid running/unknown submission upgrades and retain undo.
- [ ] Verify old/new requests and instance upgrade/undo invariants.

### Task 4: Integrated review and installed App

- [ ] Fresh review against spec, focused fixes, type checks and scoped regressions; do not review unrelated dirty files as this task's work.
- [ ] Update API/schema/user docs, coordinate the unique App and run official install flow.
- [ ] Installed App: open editor, add/delete/connect/configure, conflict/error/unsaved paths, save/reopen, pure local operation, template update/instance upgrade, wide/narrow layout.
- [ ] Restore reversible verification changes, verify references and workspace diff; record App version/build and any unverified paid behavior.

## Execution ledger

### 2026-10-21 input/processing/generation palette

- User requested explicit input-node naming and separate image/video/audio/text generation entry points while keeping processing below inputs. Palette now orders 输入节点 → 处理节点 → 生成节点, with four media buttons for input and generation; canvas import preserved.
- Direct generation uses configured current model without a successful source-task prerequisite. Compiler creates clean standard request, then normal model/parameter/reference/ownership checks apply; missing model rejected. Regression exposed local channelId being interpreted as system channel: removed that field from model-switch request, retaining channel identity through existing resolver/recipe.
- Four direct-generation kinds create/save checks passed; app/canvasworkflow/handler workflow suite passed; frontend18 checks/85 assertions and tsc passed. Official installed App v1.7.27 BuildTime2026-10-21T02:06:41Z (10:06 local), release gates passed.
- Initial capture -3811 and failed missing binding recovered through fresh App selection. Installed UI: TAU canvas → workflow → edit template, verified three headings/order, directly added video/image/audio/text nodes, observed all four graph nodes and configured model properties (videoFast/480p/16:9/5s). Undid all four additions and closed editor with no unsaved dialog; original template preserved. No paid generation or commits/PR.

### 2026-10-21 generation model and video settings

- User requested selectable generation models and explicit video resolution/ratio/duration. Operation directory now publishes current enabled channel models and public capabilities. Editor exposes model, ratio, video resolution and duration even if absent from original recipe. Model switch resolves identity via current owned configuration, drops stale endpoint credentials/provider config and logical route, and uses normal model validation/credential refresh. Canvas generated slots show model/resolution/ratio from template configuration.
- Runtime admission failures now identify the actual model and bound reference video names/durations. Current source and depth result each contribute 14.7 seconds: total29.4 seconds exceeds Seedance2.0Fast's15-second aggregate reference limit despite support for3 clips. Catalog Seedance2.5 advertises30 seconds; did not silently change user choice to2.5 or trim user media.
- Scoped frontend suite30 tests/110 assertions passed; additional model-control visibility regression passed (editor16 tests/73 assertions). App/canvasworkflow/handler workflow checks and model route-clearing/type check regression passed; TypeScript passed. Official install v1.7.27 BuildTime2026-10-21T01:55:41Z (09:55 local), gates/signature/diff passed.
- Installed UI entered TAU canvas → workflow → edit single-character template → generation node: observed selectable model seedance-2.0-fast/beefapi,16:9, reference duration source and resolution controls plus3-clips/15-second notice. Existing private recipe already uses requestedFast model; latest template revision11 remains unchanged. Model dropdown typing then CUA rebind each timed out at10 seconds; stopped repeating UI path. Save/reopen and alternate-model submission remain unverified. No paid task or workflow run submitted, no direct DB writes/commit/PR.

### 2026-10-21 depth aspect ratio repair

- Root cause: native command forced `--output-resolution 1920x1080`, and capture persisted those constants regardless of the actual source. Changed command to existing signed worker's `source` mode; probe actual encoded result before saving and propagate its width/height/duration into resource and task result.
- DepthCapture/CanvasWorkflow scoped checks passed, including portrait output metadata and CPU fallback regression. Official App v1.7.27 BuildTime `2026-10-21T01:43:57Z` (09:43 local); release gates, signature, diff checks passed.
- Original 714×1280, 14.7-second source processed by installed App local task `244b928d30d50a29c34a5b121120abfd`; succeeded in 37.7 seconds, resource `3f62f5d84970dfb9a676ef726a7c92a6`, actual 714×1280 /14.7 seconds. media.overview decoded three frames and visual inspection confirmed upright full-height depth subject without horizontal flattening.
- Added corrected result as `深度动作捕捉 · 原比例修正` node `node-dma4xrrzqd8w-87251f9ec8` on user's TAU4jXiBMyc81c4n7SyS0 canvas; bound generated asset, set portrait card geometry and placed beside old result, saved revision 287. Existing nodes preserved. Direct task bind rejected identity mismatch, so used asset bind. CUA capture later failed -3811; installed player clicking not verified. No paid generation or workflow rerun, no commits/PR.

### 2026-10-21 depth worker media tool lookup repair

- Failure traced to local depth worker `FileNotFoundError: ffprobe` before inference. Desktop bundle already contained both tools; Python worker inherited Finder PATH without the bundle media directory.
- Worker environment now prepends directories resolved by shared mediatools resolver, collapses PATH entries and preserves Windows component bin plus inherited PATH. No runtime/model download or duration policy changes.
- depthcapture and mediatools package checks passed, including minimal PATH regression and Windows path preservation. Official install v1.7.27 BuildTime `2026-10-21T01:26:31Z` (09:26 local); release gates, signature and diff checks passed.
- Installed App launched via CUA and homepage version confirmed. Through its MCP created one independent local depth task using the original short source: `ed4e2484f8b616c8ad7a6491e2e26d50`, succeeded/READY at 09:28:07 (about 51 seconds), output `0335cd778efd26eb8331be039c4c5d19`. Actual MPS inference and ffmpeg encoding completed. Did not rerun paid downstream workflow or rewrite failed workflow run/instance.

- Ruling: user explicitly requested implementation after reviewing the design. Continue through tasks without another generic authorization request; skill commit/worktree/scratch requirements yield to user workspace rules.
- Preflight: Task 1 produces API/schema consumed by Task 2 and Task 3 above. Backend files isolated from root's frontend files. Task 2/3 share API and instance graph helpers and remain root-owned. Task 4 consumes all; no simultaneous App operations.
- Design dependency found: current video trim/merge live primarily in frontend FFmpeg helpers; backend has a native media runtime. Adapter availability must be proven and this implementation must not present unexecutable local nodes.

### Implementation and review evidence

- Tasks 1–3 implemented: operation descriptors and safe editor projection, immutable revisions and CAS updates, local durable trim/merge adapters, detached graph editor, draft history, explicit ports/order/defaults, pinned instances and explicit compatible upgrades.
- Scoped backend checks passed: `go test ./internal/canvasworkflow ./internal/app ./internal/handler ./internal/database -run 'CanvasWorkflow|WorkflowMedia' -count=1`; follow-up fixes passed `go test ./internal/app ./internal/handler ./internal/canvasworkflow -run CanvasWorkflow -count=1`.
- Frontend checks passed: `bun test test/canvas-workflow-editor.test.ts test/canvas-reusable-workflow-instance.test.ts test/canvas-workflow-prompt-boundary.test.tsx`: 25 tests, 154 assertions. TypeScript no-emit check passed.
- Independent review completed; fixed source-history deletion, prompt capability revalidation, changed text default substitution, original reference order canonicalization, first-unused edge order allocation, supported-source config fields and explicit default opt-in. Rereview reported no remaining important findings.
- Official `scripts/update-local-beeftv-app.sh` completed successfully on 2026-10-20, installing canonical `/Applications/BeefTV.app` v1.7.27. Release gates, TypeScript/Vite build and bundled media probes passed. `codesign --verify --deep --strict` and `git diff --check` passed after install. Existing unrelated dirty files preserved; no commits, branches, pushes or PRs.
- API, database and user feature docs updated. Model/provider route changes require reimporting a successful source recipe; fields not represented in the source-safe config are not offered. No paid generation submitted.
- Installed App UI verification is pending: CUA launch returned “The Mac is locked and automatic unlock could not unlock it.” Asked user to unlock manually. No user canvas/template was modified during this blocked verification attempt. Do not mark Task 4 or final delivery verified until installed App operations are completed.
- After user unlocked: installed App launched successfully and homepage reported v1.7.27. Cross-chat App access confirmed free. Entering a canvas failed with macOS ScreenCaptureKit error -3812; a lightweight state read and inventory/rebind recovery still failed. Stopped repeating that path. Read-only connector remained available for post-launch canvas integrity checks; editor interaction, native trim execution and instance upgrade remain unverified in installed UI.

### Canvas integration revision

- User requested the editor use external canvas cards and automatically discover existing canvas functions. User approved the execution boundary: automatic adapters / successful model recipes / explicitly marked manual features.
- Shared `WorkflowSlotSurface` and header now serve both instance and editor. Editor uses canvas theme, icons, outside constant-screen-size titles, reference summaries, individual port anchors, parameter summaries and output markers; no upload-plus controls in graph cards. Larger graph spacing and editor layout version 2 prevent reuse of the compact old layout.
- Capability directory reads node registry, image tools and toolbar workflow contributions; backend adapters automatically append. Existing management actions stay outside the processing directory. Source labels/icons remain owned by canvas definitions; future actions declare their workflow contribution at the same registration site. Unsupported or manual actions explain their status and return to canvas; they are never executable placeholders.
- Added fixed local adapters for image crop/resize and video crop/frame/audio, with structured validation, owned ready resources, durable admission, command whitelist, cancellation, stable resource recovery and delivery. Native image crop + same-identity recovery passed with actual encoder. Canvas processing provenance can now be converted without treating every result as generation.
- Release packaging accepts an explicit native encoder and its license, preserving an already installed encoder on subsequent local builds, so Finder PATH is not needed. Existing system-only library checks and bundle signing apply.
- Preflight fetch updated origin/main to bcc277f; preserved the dirty checkout and unrelated work, did not merge or create a branch. CUA runtime reset still returned ScreenCaptureKit -3811; installed wide/narrow visual interaction remains blocked.
- Independent reviewer found missing encoder availability and high-quality resize strategy mismatch. Fixed runtime capability projection (`unavailableReason`) in both editor and catalog, disabled unavailable choices/save, preserved strict doubling resize stages, image crop ceil, and explicit trim provenance. Reviewer reread these fixes and confirmed resolution. Source review only, no claimed UI pass.
- Scoped frontend suite passed 40 tests / 192 assertions plus TypeScript. Backend canvas workflow, local media, task admission and handler checks passed. Actual native PNG crop/recovery passed, producing 32×32 saved output and reusing the same artifact with encoder disabled on replay.
- First official build passed gates/main compilation but stalled downloading identical ffprobe source; cancelled without replacing installed App. Added explicit reuse of installed media runtime with target/SHA256 validation (verified installed probe hash), so the retry does not depend on that download. Second attempt hit a reopened installed App holding workspace lock during Wails bindings, before installation; normal official quit/retry in progress.
- Final official build/install succeeded: v1.7.27, binary contains BuildTime `2026-10-20T06:13:13Z` (14:13 local), deep strict signature verified, source diff check passed, staging App removed. Installed encoder + probe paths passed `TestCanvasMediaNativeCropAndRecovery` against the bundled binaries. Runtime dependency reuse avoided the failed source download. No branch/commit/push/PR created.
- Final UI attempt launched canonical App and returned its loading window, but loading-complete AX observation timed out at 30 seconds and reset CUA. Stopped UI retries. Wide/narrow visual rendering, pointer interactions and installed workflow runs remain unverified; no paid model calls or user template/canvas writes were used in this check.

### Abstract reusable slots revision

- User requested removal of original media previews, filenames and concrete source titles. Extraction now assigns generic input/reference/operation titles; legacy editor drafts and newly imported steps use the same abstraction. Graph cards no longer mount CachedResourceImage. Reference labels inherit the generic node names.
- New definitions carry presentationVersion 1. Media inputs disable original defaults; external media references also default to inputs. Backend first compiles accurate private bindings, then canonicalizes ports and clears non-default public media input IDs and processing result IDs. Explicit fixed/default content is still an intentional user setting. Legacy revisions preserve their existing execution contract.
- Added checks for generic names/default behavior and abstract slots saving/recompiling without public original media. Frontend scoped suite: 40 passing / 189 assertions; TypeScript passed. Go canvas workflow/app/handler checks passed. Independent read-only review reported no important regression; external-reference notice already updated to match the new input behavior.
- Remote fetch stalled and was cancelled; cached origin/main remains bcc277f. No merge or unrelated cleanup. Official installation rebuild uses verified installed media runtime; completion evidence to follow.
- Official install completed: canonical App v1.7.27, BuildTime `2026-10-20T06:28:38Z` (14:28 local). Deep strict signature verification and source diff check passed; official staging App removed. Final installed UI inspection failed with ScreenCaptureKit -3811, so visual interaction remains unverified. No paid calls or user canvas/template writes; no branch, commit, push or PR.

### Small workflow drag rollback fix

- Root cause: workflow material-drop handler consumed the container's own drag when release remained inside its original bounds. Selection controller then skipped committing the entire graph's positions; large drags outside the old bounds escaped this branch.
- Restricted material-drop admission to image/video/audio/text sources; containers and progress controls fall through to ordinary movement. Slot targeting shares the same guard. Added a regression covering self-bounds hit and source-type admission.
- 15 workflow instance checks / 126 assertions and TypeScript passed. Official canonical App updated to v1.7.27, BuildTime `2026-10-20T08:22:08Z` (16:22 local); release gates and bundled probes passed. Remote fetch failed with curl 28; preserved checkout and all unrelated work.
- Initial launch capture failed -3811; AX-only read recovered. In installed App opened existing f0Qou3XJnuPuC0kOysz7t canvas, fit view, performed two small drags on workflow background (12px and 10px horizontal components), observed whole graph retaining each new position after release. Two undo actions restored original graph layout. No workflow run or paid generation. App released to 1020 for its separate task; no branch/commit/PR.
