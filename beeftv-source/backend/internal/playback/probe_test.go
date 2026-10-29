package playback

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func stsdBoxWithFourcc(fourcc string) []byte {
	b := make([]byte, 24)
	binary.BigEndian.PutUint32(b[0:4], 24)
	copy(b[4:8], "stsd")
	binary.BigEndian.PutUint32(b[12:16], 1)
	binary.BigEndian.PutUint32(b[16:20], 8)
	copy(b[20:24], fourcc)
	return b
}

func TestCodecFromMoov(t *testing.T) {
	cases := []struct {
		fourcc string
		want   string
	}{
		{"hvc1", CodecH265},
		{"hev1", CodecH265},
		{"avc1", CodecH264},
		{"av01", CodecAV1},
		{"vp09", CodecVP9},
	}
	for _, c := range cases {
		if got := codecFromMoov(stsdBoxWithFourcc(c.fourcc)); got != c.want {
			t.Errorf("codecFromMoov(%s) = %q, want %q", c.fourcc, got, c.want)
		}
	}
	if got := codecFromMoov([]byte{0, 1, 2, 3}); got != "" {
		t.Errorf("garbage moov codec = %q, want empty", got)
	}
}

func mp4Box(typ string, payload []byte) []byte {
	size := 8 + len(payload)
	out := make([]byte, size)
	binary.BigEndian.PutUint32(out[0:4], uint32(size))
	copy(out[4:8], typ)
	copy(out[8:], payload)
	return out
}

func mp4Hdlr(kind string) []byte {
	payload := make([]byte, 21)
	copy(payload[8:12], kind)
	return mp4Box("hdlr", payload)
}

func syntheticTrack(handler string, width, height int, durationMs int64) []byte {
	tkhd := make([]byte, 84)
	binary.BigEndian.PutUint32(tkhd[12:16], 1)
	binary.BigEndian.PutUint32(tkhd[76:80], uint32(width)<<16)
	binary.BigEndian.PutUint32(tkhd[80:84], uint32(height)<<16)
	mdhd := make([]byte, 24)
	binary.BigEndian.PutUint32(mdhd[12:16], 1000)
	binary.BigEndian.PutUint32(mdhd[16:20], uint32(durationMs))
	mdia := append(mp4Hdlr(handler), mp4Box("mdhd", mdhd)...)
	return mp4Box("trak", append(mp4Box("tkhd", tkhd), mp4Box("mdia", mdia)...))
}

func syntheticVideoMP4(width, height int, durationMs int64) []byte {
	ftypPayload := make([]byte, 8)
	copy(ftypPayload[:4], "isom")
	return append(mp4Box("ftyp", ftypPayload), mp4Box("moov", syntheticTrack("vide", width, height, durationMs))...)
}

func TestVideoMdhdDurationMsBoundedArithmetic(t *testing.T) {
	v0 := make([]byte, 20)
	binary.BigEndian.PutUint32(v0[12:16], 12288)
	binary.BigEndian.PutUint32(v0[16:20], 74240)
	if got := videoMdhdDurationMs(v0); got != 6041 {
		t.Fatalf("v0 durationMs = %d, want 6041", got)
	}

	unknown := make([]byte, 20)
	unknown[0] = 2
	binary.BigEndian.PutUint32(unknown[12:16], 1000)
	binary.BigEndian.PutUint32(unknown[16:20], 5000)
	if got := videoMdhdDurationMs(unknown); got != 0 {
		t.Fatalf("unsupported mdhd version = %d, want 0", got)
	}

	overflow := make([]byte, 32)
	overflow[0] = 1
	binary.BigEndian.PutUint32(overflow[20:24], 1)
	binary.BigEndian.PutUint64(overflow[24:32], ^uint64(0))
	if got := videoMdhdDurationMs(overflow); got != 0 {
		t.Fatalf("overflowing mdhd durationMs = %d, want 0", got)
	}

	zeroTimescale := make([]byte, 20)
	binary.BigEndian.PutUint32(zeroTimescale[16:20], 1000)
	if got := videoMdhdDurationMs(zeroTimescale); got != 0 {
		t.Fatalf("zero timescale = %d, want 0", got)
	}
}

func TestProbeGeneratedVideoMediaReadsTkhdAndMdhd(t *testing.T) {
	clip := syntheticVideoMP4(1280, 720, 5042)
	width, height, durationMs := ProbeGeneratedVideoMedia(clip)
	if width != 1280 || height != 720 || durationMs != 5042 {
		t.Fatalf("ProbeGeneratedVideoMedia = %d x %d @ %dms, want 1280x720 @ 5042ms", width, height, durationMs)
	}
	if w, h, d := ProbeGeneratedVideoMedia([]byte("not an mp4")); w != 0 || h != 0 || d != 0 {
		t.Fatalf("garbage probe = %d x %d @ %dms", w, h, d)
	}
}

func TestProbeGeneratedVideoMediaUsesVideTrackNotAudio(t *testing.T) {
	ftypPayload := make([]byte, 8)
	copy(ftypPayload[:4], "isom")
	cover := syntheticTrack("auxv", 64, 64, 40)
	audio := syntheticTrack("soun", 0, 0, 1111)
	video := syntheticTrack("vide", 1280, 720, 5042)
	moovPayload := append(append(cover, audio...), video...)
	clip := append(mp4Box("ftyp", ftypPayload), mp4Box("moov", moovPayload)...)
	width, height, durationMs := ProbeGeneratedVideoMedia(clip)
	if width != 1280 || height != 720 || durationMs != 5042 {
		t.Fatalf("ProbeGeneratedVideoMedia = %d x %d @ %dms, want video track 1280x720 @ 5042ms", width, height, durationMs)
	}
}

func TestParseMP4BoxRejectsMalformedSizes(t *testing.T) {
	extendedHuge := make([]byte, 24)
	binary.BigEndian.PutUint32(extendedHuge[0:4], 1)
	copy(extendedHuge[4:8], "moov")
	binary.BigEndian.PutUint64(extendedHuge[8:16], 1<<60)
	if _, ok := parseMP4Box(extendedHuge, 0, len(extendedHuge)); ok {
		t.Fatal("extended size larger than remaining must be rejected")
	}

	extendedTiny := make([]byte, 16)
	binary.BigEndian.PutUint32(extendedTiny[0:4], 1)
	copy(extendedTiny[4:8], "moov")
	binary.BigEndian.PutUint64(extendedTiny[8:16], 10)
	if _, ok := parseMP4Box(extendedTiny, 0, len(extendedTiny)); ok {
		t.Fatal("extended size smaller than the 16-byte header must be rejected")
	}

	oversize := []byte{0, 0, 1, 0, 'm', 'o', 'o', 'v', 1, 2, 3, 4}
	if _, ok := parseMP4Box(oversize, 0, len(oversize)); ok {
		t.Fatal("32-bit size larger than remaining must be rejected")
	}

	truncated := []byte{0, 0, 0, 32, 'm', 'o', 'o'}
	if _, ok := parseMP4Box(truncated, 0, len(truncated)); ok {
		t.Fatal("truncated header must be rejected")
	}
}

func TestProbeGeneratedVideoMediaReadsQAGrokImagineFile(t *testing.T) {
	data := loadQAGrokImagineVideo(t)
	width, height, durationMs := ProbeGeneratedVideoMedia(data)
	if width != 720 || height != 720 {
		t.Fatalf("QA clip dimensions = %dx%d, want 720x720", width, height)
	}
	if durationMs < 6041 || durationMs > 6042 {
		t.Fatalf("QA clip durationMs = %d, want 6041–6042 (6.041667s)", durationMs)
	}
}

func TestProbeGeneratedVideoMediaRejectsMalformedBoxes(t *testing.T) {
	extendedHuge := make([]byte, 24)
	binary.BigEndian.PutUint32(extendedHuge[0:4], 1)
	copy(extendedHuge[4:8], "moov")
	binary.BigEndian.PutUint64(extendedHuge[8:16], 1<<60)

	extendedTiny := make([]byte, 16)
	binary.BigEndian.PutUint32(extendedTiny[0:4], 1)
	copy(extendedTiny[4:8], "moov")
	binary.BigEndian.PutUint64(extendedTiny[8:16], 10)

	truncatedHeader := []byte{0, 0, 0, 32, 'm', 'o', 'o'}
	oversize := []byte{0, 0, 1, 0, 'm', 'o', 'o', 'v', 1, 2, 3, 4}

	for i, data := range [][]byte{extendedHuge, extendedTiny, truncatedHeader, oversize, nil} {
		if w, h, d := ProbeGeneratedVideoMedia(data); w != 0 || h != 0 || d != 0 {
			t.Fatalf("malformed case %d = %d x %d @ %dms", i, w, h, d)
		}
	}
}

func loadQAGrokImagineVideo(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "qa-grok-imagine-720square.mp4"))
	if err != nil || len(data) == 0 {
		t.Fatalf("QA Grok Imagine MP4 fixture is missing: %v", err)
	}
	return data
}

func TestProbeCodecReadsRealFile(t *testing.T) {
	stsd := stsdBoxWithFourcc("hvc1")
	moov := make([]byte, 8+len(stsd))
	binary.BigEndian.PutUint32(moov[0:4], uint32(len(moov)))
	copy(moov[4:8], "moov")
	copy(moov[8:], stsd)
	ftyp := make([]byte, 16)
	binary.BigEndian.PutUint32(ftyp[0:4], 16)
	copy(ftyp[4:8], "ftyp")
	copy(ftyp[8:12], "isom")
	full := append(append([]byte{}, ftyp...), moov...)

	path := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(path, full, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ProbeCodec(path); got != CodecH265 {
		t.Errorf("ProbeCodec = %q, want h265", got)
	}
}

func TestProbeCodecReadsQAGrokImagineFile(t *testing.T) {
	path := filepath.Join("testdata", "qa-grok-imagine-720square.mp4")
	got := ProbeCodec(path)
	if got == "" {
		t.Fatal("QA fixture codec was empty")
	}
}
