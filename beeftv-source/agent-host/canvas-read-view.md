# Model-facing canvas reads

`canvas_get` still calls the existing Go `canvas.get` on every read, with the
trusted host/turn credentials. Go returns and persists the complete canvas;
the host projects only the model-facing response. `readView` is removed before
the Go request and cannot grant additional canvas access or affect write/CAS.

The default response includes revision first, a separate bounded node ID index,
and bounded node and connection
pages, and field availability. Each tool result is below 40,000 UTF-8 bytes,
under the official Durable default 50 KiB output limit. No global output or
context limit is increased. The index keeps tail IDs discoverable even when
rich node records require additional pages. Large diagnostics, SVGs, long prompts and nested
data have explicit `complete:false` read references rather than silently
disappearing. Small generation configuration and asset/task/resource references
are retained. A preview is never claimed to be the original full field.

`readView.section` selects nodes/connections or the canvas; `nodeId` locates a
node, and `fieldPath` is a JSON Pointer relative to that node (or the canvas).
Object/array fields return key/value entry pages; string fields return exact
character chunks. Follow `nextOffset`/`nextTextOffset`, and supply the observed
`expectedRevision` to reject mixed-revision pages. `recordsComplete` means the
page covers the selected records; `complete` also requires all nested fields
to be complete. The separate connection page records its own completeness.

Tests use synthetic, privacy-safe 23-node shapes with oversized diagnostics
and SVGs, a 1,000-node canvas, long original prompt chunks, and the real official
Durable SQLite/provider transport. They do not submit paid models or export
private user canvas content, and do not claim a native desktop acceptance.
