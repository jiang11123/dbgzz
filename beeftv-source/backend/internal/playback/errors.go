package playback

import "errors"

// ErrNotReady means the resource has no usable browser-compatible copy
// (not transcoded, still processing, or failed). File endpoints fall back
// to the original object.
var ErrNotReady = errors.New("播放副本尚未就绪")
