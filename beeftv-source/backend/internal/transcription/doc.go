// Package transcription owns local whisper.cpp speech-to-text.
//
// The executor preprocesses authorized media to 16 kHz mono PCM, posts it to
// a configured whisper.cpp /inference endpoint, and returns segments plus SRT.
// This package must not import internal/app. Workspace task status and feature
// gates stay in the application adapter.
package transcription
