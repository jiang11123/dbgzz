// Package creation owns structured creative-run execution: lease and epoch
// fencing, proposal snapshot/hash confirmation, quote/confirm/submit
// idempotency, mutation-diff validation, and the canvas write that applies an
// approved operation set.
//
// This is not a pi Session, an AssistantTurn, or /create conversation storage.
// Those ledgers stay in their own domains. Active UI ApprovedToolExecution and
// storyboard paths remain the product surface; they are not a retired Agent.
//
// The package must not import internal/app. Cross-domain work (task quoting,
// secret protection, quota, canvas media guards) enters through typed ports so
// the adapter can map TaskRequest.PrepareOnly onto task.CreateRequest.
package creation
