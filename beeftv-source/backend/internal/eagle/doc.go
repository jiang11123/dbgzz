package eagle

// Package eagle owns the local Eagle HTTP protocol and filesystem path jail.
// The connector is an explicit user-local trust of 127.0.0.1/localhost/::1:41595.
// HTTP calls do not follow redirects, and custom transports cannot target a
// different host or port than the already-validated destination. Library roots
// are canonicalized so a symlink library still works while file and item-dir
// symlinks cannot leave the jail.
// Callers must not reuse this client for general outbound HTTP.
// This package must not import internal/app.
