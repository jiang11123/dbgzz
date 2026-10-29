// Package modelcatalog is the authoritative model catalog, capability,
// channel-configuration, and task-admission domain.
//
// UI, Agent, and ordinary generation must invoke these rules. This package
// must not import internal/app. Persistence, outbound HTTP, protocol plugin
// registration, and generation task lifecycle stay outside. Channel /models
// validate, parse, merge, and BeefAPI/WhatsToken video overlay live here;
// credentials and the outbound transport are injected as ports.
package modelcatalog
