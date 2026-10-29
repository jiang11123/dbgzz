package main

import "embed"

// assets is replaced by the real Vite output before a Wails production build.
//
//go:embed all:frontend/dist
var assets embed.FS
