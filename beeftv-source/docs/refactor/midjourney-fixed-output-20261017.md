# Midjourney fixed four-image requests

The owner requested publishing Tencent VOD Midjourney and real BeefTV acceptance.
The BeefAPI model is `midjourney-v8.2`: each request generates and bills four
images. The generic image flow previously sent `n=1` and created separate tasks
for each requested canvas image, so selecting four images did not satisfy this
provider contract.

## Contract

`backend/internal/providerpreset/image_contracts.json` is shared by Go and the
frontend. The MJ entry declares `fixedOutputs=4`, native 1024 square requests,
automatic quality, a 2000-character prompt, one reference image up to 10 MiB and
no mask. Non-square output uses `--ar` in the prompt. Unsupported dimensions,
quality, transparency, references and counts are rejected before submission.

The settings show a fixed four-image count. Canvas generation creates four
candidate placeholders and submits one task with `count=4`; OpenAI Images JSON
or multipart sends `n=4`. All candidates retain the same task/operation identity
and their individual `taskOutputIndex` (0–3). Each output is saved and bound to
its own node. Submission freezes `metadata.outputNodeIds`; the backend permits
each output only at its declared destination and retains the existing ownership
and ready-resource checks. Binding writes are serialized; failure to bind one candidate does
not discard the other candidates or create another paid task.

Polling, result retrieval and reload use that output index. A new generation
clears the previous index. Submission-unknown state is propagated to the batch
root and every candidate; it blocks another generation and directs the user to
query the original task. Canceling the wait preserves all candidate identities; history
inserts all four indexed images and retry delegates the fixed batch only once.
A missing logical output fails immediately instead of polling or aliasing another
image. Known output-application errors retain the existing
continue-retrieval behavior.

Other image models keep their existing count and submission behavior. No schema
migration, credential handling, dependency or model price is changed.
The Create page likewise submits one four-output task and consumes the complete
task once, preserving all four conversation attachments.

## Verification

Build official protocol packages before Go tests, as CI does:

```sh
sh plugin-packages/build-packages.sh
cd backend && go test ./internal/generation ./internal/modelcatalog ./internal/providerpreset
cd ../web && bun test test/midjourney-generation.test.ts test/model-capabilities.test.ts test/canvas-image-save-barrier.test.ts test/canvas-task-bind-cutover.test.ts
bun run typecheck
```

The wire tests cover one `n=4` create for JSON and reference-image multipart,
all four returned results, the full execution path and rejection before create.
The frontend fixture uses the real canvas executor with a synthetic submission
boundary to verify one task, four distinct indices, serialized bindings, partial
binding failure, cancellation before/after acceptance and unknown submission with
no new task. History recovery and insertion check all four indices, and a sparse
output fails without querying or binding the wrong image. Neighboring save/bind
regressions run alongside it.

These deterministic tests do not prove a production generation or native app
readiness. Real acceptance still needs the installed BeefTV app, model discovery,
four saved and visible MJ candidates, a saved/playable Wan video and gateway
wallet reconciliation. Public desktop release is separate from a local candidate.

## Installed Midjourney acceptance — 2026-10-20

The canonical `/Applications/BeefTV.app` v1.7.27 was rebuilt from main
`9bb7b7f` with local fixes. Through the native canvas UI, `midjourney-v8.2`
(BeefTV channel) displayed fixed four-image settings at 1024 × 1024. One click
with prompt `中式宫廷画风女子` created task
`d830d7f3bf13b0bbb4f3d3ebe92599b1` at 08:58:16 +08:00. It completed at
09:00:01 with `succeeded` / `READY`. Canvas
`RLEWBraNqyc_UDIZs3Vbq` has four successful candidates with output indices 0–3,
the same task ID and four distinct local resource/asset identities. All four
local image previews were read and visually checked. Returning to the home page
and reopening the canvas retained all four visible results and the saved state.
This acceptance covers one real Midjourney request; it does not establish Wan
video behavior or independently reconcile gateway billing.

The local fixes also stop recovery resends for the specific structured
`invalid_request` rejection stating that Midjourney requires four images, when
no task identity or earlier accepted response exists. The route remains
`rejected_no_job`, retaining `invalid_params` and a specific user explanation.
Generic HTTP 500 errors, responses with a task identity and previously accepted
submissions retain uncertainty/recovery protection. The regression reproduced
12 sends before the fix and verifies one send after it.

Batch-root failure notices now have a centered, clipped container; task details
are passed through to the root. Child cards retain the reason and task-details
action without repeating the full guidance and diagnostic-copy control. Native
inspection of the original failed canvas confirmed that the root notice stays
inside its card. Browser bounds checks cover 20%, 68%, 100% and 150% zoom.
Historical task diagnostics are preserved rather than rewritten as new results.


## 2026-10-20 size and total-output adaptation (pending live acceptance)

The shared contract now declares fourteen presets: SD/HD (1K/2K) for 1:1,
16:9, 9:16, 4:3, 3:4, 3:2 and 2:3. The official gateway wire size remains
1024x1024; the selected output is encoded using Midjourney prompt parameters
`--ar` and `--sd`/`--hd`. Conflicting manual prompt parameters are rejected
before submitting. Dimensions are preset estimates; actual provider dimensions
need to be checked against a live result.

The user chose exact total counts 4, 8 and 12. These mean one, two or three
independent native requests, each with n=4. Canvas candidates retain the owning
task and local output index 0–3 per batch. The create page uses the same native
batch count. Settings explain the batch count and charging basis. Recovery
retains each task identity; manual retries target a failed native batch and
refuse to regenerate a batch that already has a local result.

Checks: provider/model catalog packages, Midjourney request tests (JSON,
multipart and official declarative registry), frontend counts/identity/recovery,
old official capability upgrade, image presets and batch retry checks passed;
TypeScript and diff whitespace checks passed. The user authorized exactly one HD 16:9 native batch (four images). After a
coordinated official installation of v1.7.27 (build 2026-10-20T02:33:59Z), the
native UI confirmed all seven ratios and total counts 4/8/12 with correct batch
counts. The real request created task `aca88d357a19d5b91089e0722112d6c9` on canvas
`nKovxYrrLKU5MO2inNAB-` at 10:35:40 +08:00. It entered `submission_unknown` after
about one second, with no outputs, no recorded image POST evidence and no
`image_submissions` row. Its saved input confirms size 2912x1632 and count 4.
No resend was performed; upstream acceptance and charging cannot be established
from these local records. HD/aspect-ratio live output remains unverified.

Native inspection also found the generic pixel heuristic mislabeled the HD
landscape summary as 4K. The summary now uses the model's declared presets,
with a regression check for 2912x1632 -> 16:9 / 2K. A follow-up official build
installs that display correction without submitting another generation.

Final native UI check on v1.7.27 / build 2026-10-20T02:37:55Z confirmed
`16:9 · 2K · 4 张` in the summary, with 2K and 16:9 selected and counts
4/8/12 available after restarting the canonical installed App. All 35 relevant
frontend checks (235 assertions), TypeScript, backend Midjourney request checks,
release gates and installed signature validation passed. Official staging was
cleaned. Live output/charging for the uncertain task remains unresolved.


## 2026-10-20 gateway contract correction

Investigation of failed task `a154f2e79b7e60b98ec2005d770961ce` found
HTTP 400 / `vod_image_invalid_params`. Its logged wire prompt was
`中式古典宫廷风格 --ar 1:1 --sd`, whereas the earlier successful task used
a plain prompt. The previous native-parameter adaptation was not a verified
gateway contract and is superseded below.

The deployed BeefAPI source at commit
`79cfae055190b9ec5d05d54c3e2435d043db4ea1`,
`relay/channel/tencent/vod_midjourney.go` and
`docs/specs/vod-wan3-midjourney.md`, declares only native standard output.
HD/quality/version/speed/repeat flags require separately priced models and
are rejected. Exact non-square pixel sizes are unsupported; non-square
framing uses `--ar`, with wire size omitted or auto. A fixed 1024x1024
wire size conflicts with any non-square aspect flag.

Correction: advertise only the seven native 1K presets; emit a plain prompt
for square output and only `--ar` for non-square output; omit wire size.
Reject unsupported priced flags before sending. Totals 4/8/12 remain native
batches of four. Explicit structured VOD parameter/media HTTP 400 failures
remain terminal failures instead of being wrapped as submission uncertainty.
A supplier-task marker preserves accepted execution history; it does not
become evidence of a rejected-before-create request. Prior genuine unknown
submissions retain their protection.

Local request tests cover JSON, reference multipart and official declarative
protocol paths; frontend counts/presets/recovery tests and typecheck passed.
Live installed-App acceptance is pending below.


### Installed application acceptance after correction

Canonical App: `/Applications/BeefTV.app`, v1.7.27, build
2026-10-20T07:20:58Z (15:20:58 +08:00). The user approved at most two native
four-image tasks. Native capture failed repeatedly with ScreenCaptureKit -3811;
no new runtime was created. Requests were submitted through this installed
App's authenticated MCP business endpoint, using the existing managed BeefAPI
credential reference. This validates the installed backend and storage/binding
path, not a full button-click UI acceptance.

- Square: `c4c5514ca5014b13f7ab48b2cf92fcc5`; VOD task
  `1467940581-AigcImageTask-425b29b8bed786d889a68ff566cbd8dat`.
  Four distinct 1024x1024 PNG resources, all materialized and bound.
- Landscape: `d8d91d764b9c3ec852378d435a0970fa`; VOD task
  `1467940581-AigcImageTask-d345e92bf430eb372133ccd8d18c0c8ct`.
  Four distinct 1456x816 PNG resources, all materialized and bound.
- Both requests returned HTTP 200. Persistent image-submission send counts are
  one each with response accepted. Square wire prompt had no appended flags;
  landscape had only `--ar 16:9`. Neither wire body contained size, SD or HD.
- Re-read canvas `-K00clAgNNn5tGK-SMP7y`: all eight new canary nodes have
  successful status, owning task, output index and independent local assets.
  Only these canary nodes were laid out as two compact grids. Other nodes were
  preserved using revision-checked saves. A local saved image from each task
  was opened and visually inspected. Actual gateway wallet billing was not
  independently reconciled. No further task was created.

The old `a154...` task detail/list now projects its single complete structured
400 response as invalid_params, preserving the original historical record.
Regression checks protect genuine unknown submissions and synchronize a failed
task's state across all cached canvas candidates sharing its task ID.
Native 2K remains unavailable in this deployed priced model; no local upscale
is disguised as native generation, and no gateway pricing/deployment changed.


### 2026-10-20: real canvas acceptance and metadata preflight failure

User-reported task `e8bb0e42598b23954c2e59e4fb9788a7` failed before any paid
HTTP request: API receipt `request_not_sent`, status 0, no image_submissions
row. Its native batch config was already count 4 and 1456x816; the displayed
8-image total was split by the UI. The five-second image replay metadata GET
could time out before image interception, but returned an untyped error;
route sealing classified it as submission_unknown and then hid the original
cause behind imageRecoveryError. This is a separate failure from the earlier
structured VOD 400 parameter rejection.

Correction: metadata probes have a ten-second deadline and at most three
attempts for transient network/timeouts only. Cancellation/permanent failures
stop immediately. Exhausted probes return typed RequestPreparationError and
RequestNotSentError, preserving rejected_no_job routing and a definite unsent
UI failure. These retries execute metadata GETs only; no image POST is retried
by this change. Actual unknown paid submissions retain their protections.
Regression coverage includes exhausted probes, transient-then-success probes,
protocol negotiation, redirects, and app route terminal state/classification.

Canonical App v1.7.27 build 2026-10-20T08:27:59Z was installed through the
existing update script. Unlike the prior MCP backend-only canaries, the rounds
below were submitted by clicking Generate in the installed App canvas UI.
No task creation or result binding API was used to construct these outcomes.
Canvas: `WoFSZcw8VA5BSceP7-41f`, workspace `Midjourney 三轮实机验收 1020`.

Prompt A: 中式宫廷巨型建筑，金色屋顶，清晨薄雾，电影级建筑摄影，无文字

- Round 1: UI 1K/1:1/4; task `e7a81f8224edeafd2f3c5362d826def0`, succeeded.
  Four distinct local ready PNGs with actual 1024x1024 headers; four child
  nodes auto-bound with indices 0..3 and local resource keys. App quit/reopen
  and canvas re-entry retained and loaded all four images.
- Round 2: UI 1K/1:1/8; tasks `95eb1aad4eb7c2764cc7448cee9ae714` and
  `9fbe5719bbb32c0290e9defef68b7e4e`, both succeeded. Each had count 4,
  distinct operation suffix :0/:1, send_count 1, response_accepted true.
  Eight child nodes auto-bound to their owning task/output indices, all
  success. Eight distinct local ready PNGs have actual 1024x1024 headers.
  App was quit/reopened; after capture recovery the installed canvas loaded
  all eight child images, including outputs 7 and 8.
- Round 3: UI 1K/16:9/4; prompt B: 未来海滨城市的雨夜，蓝紫色霓虹倒映在街道，电影感全景，无文字.
  Task `9cf3256351ebdc771598169397607d41`, succeeded, HTTP 200, send_count 1,
  response_accepted true. Four local ready PNGs have actual 1456x816 headers;
  four child nodes auto-bound to task output indices 0..3. Wire prompt contains
  only the appended `--ar 16:9`; no exact size or HD/SD quality flag.
  Third-round App quit/reopen and canvas re-entry passed. Fit-to-screen screenshot
  showed all 16 child outputs across the three original groups loaded from the
  saved canvas; no generation remained active after reopening.

All three installed UI cycles and reopen checks are now complete. Sixteen
independent local PNG files were read, their headers matched 12 x 1024x1024
and 4 x 1456x816, and their SHA-256 digests were all distinct. All 16 children
have successful status, local resource keys, owning task and output index.
All four native requests returned HTTP 200, with send_count 1 and accepted
receipts. The App is left on this workspace showing the generated images.
No paid task was submitted through MCP, no results were manually injected or
bound, and no extra source/runtime directory was created for these cycles.

The earlier final report overstated backend-only success as user-path
acceptance and did not exercise the eight-image UI. That acceptance gap was
corrected by the three real button-click cycles above. This verifies standard
1K square and landscape generation, totals 4/8, and two prompts; it does not
attest native 2K or every Midjourney prompt flag. No commit/push/PR yet.

### 批量图片排布修复（2026-10-20）

- 根因：批次按占位尺寸计算坐标，图片解码却用另一套默认边界放大节点。
  1:1 从 420 放大到 520，4:3 也会放大；原列距、行距不变，造成真实图片框重叠。
- 解码使用批次既有尺寸边界；按实际列宽、行高重排已经重叠的图片组，
  为标题保留行间距；新批次按完整范围避让其他节点。
  锁定布局、工作流占位不自动重排，正常布局保持不变。
- 重排通过现有画布恢复和保存流程持久化，不改图片、任务和素材身份。
- 41 项专项检查、4535 个断言及类型检查通过；覆盖七种比例、4/8/12 张，
  1K/2K/4K 像素尺寸、混合输出尺寸、手动缩放与锁定布局。
  像素尺寸检查是布局计算检查，不代表渠道新增了对应生成能力。
- 安装版 v1.7.27，构建时间 2026-10-20T09:24:52Z。
  在原验收画布实机查看方图四张、方图八张、4:3 批次，图片框已分开。
  保存记录 revision 138：上述三个批次重叠数均为零、行间距 84；
  原 16:9 批次坐标保持不变。24 个节点的资源引用和宽高全部保留。
  没有新增付费生成。额外窄窗口、收起展开及再次重开检查因
  ScreenCaptureKit -3812 和窗口状态保护未完成；不作为已验收项。
