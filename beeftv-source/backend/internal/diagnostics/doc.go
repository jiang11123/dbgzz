package diagnostics

// Package diagnostics owns user-exported diagnostic ZIP bundles and secret
// redaction. Bundles contain a bounded, sanitized window of client events,
// tasks, business assistant turns, official-runtime metadata, resource state,
// task logs and upstream calls. Every collector reports coverage; offline
// findings never promote absent evidence into a root-cause claim. Transcripts,
// request/response bodies and media addresses stay out of the archive. This
// package must not import internal/app.
