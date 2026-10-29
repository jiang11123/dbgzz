// Package workflow is the RunningHub workflow provider domain.
//
// Field normalization, override safety, parameter mapping, random seed,
// media upload, task create, original-task poll/recovery, and output
// URL/MIME/download rules live here. Persistence, plugin lifecycle, generic
// provider transport, and videoPollPolicy retry loops stay outside.
//
// This package must not import internal/app. Outbound requests go through
// RequestExecutor, which the app adapter implements with the existing
// outbound/doBinary path.
package workflow
