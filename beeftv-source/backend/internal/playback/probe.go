package playback

import (
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
)

// ProbeCodec parses the first video sample-entry fourcc of a local MP4.
// Non-MP4 containers and parse failures return "" (callers treat that as
// "no transcode needed"; the original file is still served).
func ProbeCodec(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var moovSize int64
	var moovData []byte
	pos := int64(0)
	for {
		boxType, size, err := readMP4BoxHeaderAt(f, pos)
		if err != nil {
			return ""
		}
		switch boxType {
		case "moov":
			if size > probeMaxMoov {
				return ""
			}
			moovData = make([]byte, size-8)
			if _, err := f.ReadAt(moovData, pos+8); err != nil {
				return ""
			}
			moovSize = size
		}
		pos += size
		if moovSize != 0 {
			break
		}
		if size < 8 {
			return ""
		}
	}
	return codecFromMoov(moovData)
}

func readMP4BoxHeaderAt(r io.ReaderAt, pos int64) (string, int64, error) {
	var hdr [16]byte
	if _, err := r.ReadAt(hdr[:8], pos); err != nil {
		return "", 0, err
	}
	size := int64(binary.BigEndian.Uint32(hdr[:4]))
	boxType := string(hdr[4:8])
	if size == 1 {
		if _, err := r.ReadAt(hdr[8:16], pos+8); err != nil {
			return "", 0, err
		}
		size = int64(binary.BigEndian.Uint64(hdr[8:16]))
	}
	if size < 8 {
		return "", 0, fmt.Errorf("invalid box size %d", size)
	}
	return boxType, size, nil
}

type mp4BoxHeader struct {
	Type string
	Hdr  int
	Size int
}

func parseMP4Box(data []byte, pos, end int) (mp4BoxHeader, bool) {
	if pos < 0 || end > len(data) || pos >= end {
		return mp4BoxHeader{}, false
	}
	remaining := end - pos
	if remaining < 8 {
		return mp4BoxHeader{}, false
	}
	raw32 := binary.BigEndian.Uint32(data[pos : pos+4])
	typ := string(data[pos+4 : pos+8])
	hdr := 8
	var raw uint64
	switch raw32 {
	case 1:
		if remaining < 16 {
			return mp4BoxHeader{}, false
		}
		raw = binary.BigEndian.Uint64(data[pos+8 : pos+16])
		hdr = 16
	case 0:
		raw = uint64(remaining)
	default:
		raw = uint64(raw32)
	}
	if raw < uint64(hdr) || raw > uint64(remaining) {
		return mp4BoxHeader{}, false
	}
	return mp4BoxHeader{Type: typ, Hdr: hdr, Size: int(raw)}, true
}

func mp4BoxPayload(data []byte, pos int, header mp4BoxHeader) []byte {
	return data[pos+header.Hdr : pos+header.Size]
}

// ProbeGeneratedVideoMedia reads width, height, and duration from the same
// vide track. Audio, cover-art, and other non-vide tracks are ignored.
func ProbeGeneratedVideoMedia(data []byte) (width int, height int, durationMs int64) {
	moov := firstMP4Payload(data, 0, len(data), "moov")
	if len(moov) == 0 {
		return 0, 0, 0
	}
	for _, trak := range mp4Payloads(moov, "trak") {
		if trakHandlerType(trak) != "vide" {
			continue
		}
		trackWidth, trackHeight := 0, 0
		trackDurationMs := int64(0)
		if tkhd := firstMP4Payload(trak, 0, len(trak), "tkhd"); len(tkhd) > 0 {
			trackWidth, trackHeight = videoTkhdDimensions(tkhd)
		}
		if mdia := firstMP4Payload(trak, 0, len(trak), "mdia"); len(mdia) > 0 {
			if mdhd := firstMP4Payload(mdia, 0, len(mdia), "mdhd"); len(mdhd) > 0 {
				trackDurationMs = videoMdhdDurationMs(mdhd)
			}
		}
		if trackWidth > 0 && trackHeight > 0 {
			return trackWidth, trackHeight, trackDurationMs
		}
	}
	return 0, 0, 0
}

// FirstPayload returns the first box payload of type want.
func FirstPayload(data []byte, pos, end int, want string) []byte {
	return firstMP4Payload(data, pos, end, want)
}

// Payloads returns every top-level box payload of type want.
func Payloads(data []byte, want string) [][]byte {
	return mp4Payloads(data, want)
}

// TrackHandler returns the mdia/hdlr handler type of a trak payload.
func TrackHandler(trak []byte) string {
	return trakHandlerType(trak)
}

func trakHandlerType(trak []byte) string {
	for _, mdia := range mp4Payloads(trak, "mdia") {
		if hdlr := firstMP4Payload(mdia, 0, len(mdia), "hdlr"); len(hdlr) >= 12 {
			return string(hdlr[8:12])
		}
	}
	return ""
}

func firstMP4Payload(data []byte, pos, end int, want string) []byte {
	payloads := collectMP4Payloads(data, pos, end, want, true)
	if len(payloads) == 0 {
		return nil
	}
	return payloads[0]
}

func mp4Payloads(data []byte, want string) [][]byte {
	return collectMP4Payloads(data, 0, len(data), want, false)
}

func videoTkhdDimensions(body []byte) (int, int) {
	if len(body) < 4 {
		return 0, 0
	}
	widthAt, heightAt := 76, 80
	switch body[0] {
	case 0:
	case 1:
		widthAt, heightAt = 88, 92
	default:
		return 0, 0
	}
	if len(body) < heightAt+4 {
		return 0, 0
	}
	return int(binary.BigEndian.Uint32(body[widthAt:widthAt+4]) >> 16), int(binary.BigEndian.Uint32(body[heightAt:heightAt+4]) >> 16)
}

func videoMdhdDurationMs(body []byte) int64 {
	if len(body) < 4 {
		return 0
	}
	var timescale uint32
	var duration uint64
	switch body[0] {
	case 1:
		if len(body) < 32 {
			return 0
		}
		timescale = binary.BigEndian.Uint32(body[20:24])
		duration = binary.BigEndian.Uint64(body[24:32])
	case 0:
		if len(body) < 20 {
			return 0
		}
		timescale = binary.BigEndian.Uint32(body[12:16])
		duration = uint64(binary.BigEndian.Uint32(body[16:20]))
	default:
		return 0
	}
	if timescale == 0 {
		return 0
	}
	return durationMillis(duration, uint64(timescale))
}

func durationMillis(duration, timescale uint64) int64 {
	if timescale == 0 {
		return 0
	}
	major := duration / timescale
	frac := duration % timescale
	if major > uint64(math.MaxInt64/1000) {
		return 0
	}
	ms := major * 1000
	fracMs := frac * 1000 / timescale
	if ms > uint64(math.MaxInt64)-fracMs {
		return 0
	}
	return int64(ms + fracMs)
}

func codecFromMoov(moov []byte) string {
	for _, stsdBody := range boxBodies(moov, "stsd") {
		if stsdBody+16 > len(moov) {
			continue
		}
		fourcc := string(moov[stsdBody+12 : stsdBody+16])
		switch fourcc {
		case "avc1":
			return CodecH264
		case "hvc1", "hev1":
			return CodecH265
		case "av01":
			return CodecAV1
		case "vp09":
			return CodecVP9
		case "mp4v":
			return CodecMPEG4
		}
	}
	return ""
}

func boxBodies(data []byte, want string) []int {
	var out []int
	var walk func(start, end int)
	walk = func(start, end int) {
		pos := start
		for {
			header, ok := parseMP4Box(data, pos, end)
			if !ok {
				return
			}
			if header.Type == want {
				out = append(out, pos+header.Hdr)
			}
			switch header.Type {
			case "moov", "trak", "mdia", "minf", "stbl":
				walk(pos+header.Hdr, pos+header.Size)
			}
			pos += header.Size
		}
	}
	walk(0, len(data))
	return out
}

func collectMP4Payloads(data []byte, start, end int, want string, firstOnly bool) [][]byte {
	var out [][]byte
	pos := start
	for {
		header, ok := parseMP4Box(data, pos, end)
		if !ok {
			return out
		}
		if header.Type == want {
			out = append(out, mp4BoxPayload(data, pos, header))
			if firstOnly {
				return out
			}
		}
		pos += header.Size
	}
}
