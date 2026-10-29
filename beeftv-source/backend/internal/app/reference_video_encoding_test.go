package app

import (
	"encoding/binary"
	"math"
	"os"
	"testing"
)

func TestReferenceVideoEncodingRealClip(t *testing.T) {
	codec, fps := referenceVideoEncoding(loadQAGrokImagineVideo(t))
	if codec != "avc1" || math.Abs(fps-24) > 0.001 {
		t.Fatalf("codec=%s fps=%f", codec, fps)
	}
}

func TestReferenceVideoEncodingFragmented(t *testing.T) {
	data, err := os.ReadFile("testdata/reference-fragmented-30fps.mp4")
	if err != nil {
		t.Fatal(err)
	}
	codec, fps := referenceVideoEncoding(data)
	if codec != "avc1" || math.Abs(fps-30) > 1e-6 {
		t.Fatalf("codec=%s fps=%f", codec, fps)
	}
	for n := 0; n < len(data); n += 17 {
		referenceVideoEncoding(data[:n])
	}
}

func TestReferenceVideoEncodingMixedSamples(t *testing.T) {
	data := loadQAGrokImagineVideo(t)
	moov := firstMP4Payload(data, 0, len(data), "moov")
	var video []byte
	for _, track := range mp4Payloads(moov, "trak") {
		if trakHandlerType(track) == "vide" {
			video = track
			break
		}
	}
	tkhd := firstMP4Payload(video, 0, len(video), "tkhd")
	mdia := firstMP4Payload(video, 0, len(video), "mdia")
	mdhd := firstMP4Payload(mdia, 0, len(mdia), "mdhd")
	scale := binary.BigEndian.Uint32(mdhd[12:16])
	duration := float64(binary.BigEndian.Uint32(mdhd[16:20])) / float64(scale)
	tfhd := make([]byte, 12)
	tfhd[3] = 8
	copy(tfhd[4:8], tkhd[12:16])
	binary.BigEndian.PutUint32(tfhd[8:12], scale/48)
	trun := make([]byte, 8)
	binary.BigEndian.PutUint32(trun[4:8], 48)
	data = append(data, mp4Box("moof", mp4Box("traf", append(mp4Box("tfhd", tfhd), mp4Box("trun", trun)...)))...)
	_, fps := referenceVideoEncoding(data)
	if math.Abs(fps-(duration*24+48)/(duration+1)) > 1e-6 {
		t.Fatalf("mixed fps=%f", fps)
	}
}

func TestReferenceVideoEncodingTracksAndTiming(t *testing.T) {
	for _, tc := range []struct {
		codec        string
		scale, delta uint32
		want         float64
	}{
		{"avc1", 24000, 1001, 24000.0 / 1001}, {"hvc1", 60000, 1001, 60000.0 / 1001}, {"av01", 120000, 1000, 120}, {"zzzz", 30000, 1000, 30}, {"avc1", 0, 1000, 0}, {"avc1", 24000, 0, 0},
	} {
		mdhd := make([]byte, 24)
		binary.BigEndian.PutUint32(mdhd[12:16], tc.scale)
		hdlr := make([]byte, 24)
		copy(hdlr[8:12], "vide")
		stsd := make([]byte, 16)
		binary.BigEndian.PutUint32(stsd[4:8], 1)
		binary.BigEndian.PutUint32(stsd[8:12], 8)
		copy(stsd[12:16], tc.codec)
		stts := make([]byte, 16)
		binary.BigEndian.PutUint32(stts[4:8], 1)
		binary.BigEndian.PutUint32(stts[8:12], 100)
		binary.BigEndian.PutUint32(stts[12:16], tc.delta)
		stbl := mp4Box("stbl", append(mp4Box("stsd", stsd), mp4Box("stts", stts)...))
		mdia := append(append(mp4Box("hdlr", hdlr), mp4Box("mdhd", mdhd)...), mp4Box("minf", stbl)...)
		data := mp4Box("moov", append(syntheticTrack("soun", 0, 0, 9000), mp4Box("trak", mp4Box("mdia", mdia))...))
		codec, fps := referenceVideoEncoding(data)
		if codec != tc.codec || math.Abs(fps-tc.want) > 1e-6 {
			t.Fatalf("%+v got codec=%s fps=%f", tc, codec, fps)
		}
	}
}

func TestReferenceVideoFrameRateScope(t *testing.T) {
	for _, host := range []string{"https://whatstoken.ai", "https://www.whatstoken.ai/v1", "https://enterprise.beefapi.com", "https://ark.cn-beijing.volces.com/api/v3"} {
		for _, fps := range []float64{0, 23.976, 24, 30, 59.94, 60, 120} {
			err := referenceVideoFrameRateError(providerConfig{BaseURL: host}, 0, fps)
			want := (host == "https://whatstoken.ai" || host == "https://www.whatstoken.ai/v1") && (fps < 24 || fps > 60)
			if (err != nil) != want {
				t.Fatalf("host=%s fps=%f error=%v", host, fps, err)
			}
		}
	}
}

func TestNativeArkSeedanceFrameRateScope(t *testing.T) {
	ark := providerConfig{InterfaceType: "volcengine-ark-video", Model: "seedance-2.0", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}
	custom := providerConfig{InterfaceType: "newapi", Model: "seedance-2.0", BaseURL: "https://example.com"}
	for _, fps := range []float64{0, 23.976, 24, 30, 59.94, 60, 120} {
		err := referenceVideoFrameRateError(ark, 0, fps)
		want := fps < 24 || fps > 60
		if (err != nil) != want {
			t.Fatalf("ark fps=%f error=%v", fps, err)
		}
		if err := referenceVideoFrameRateError(custom, 0, fps); err != nil {
			t.Fatalf("custom newapi fps=%f gated: %v", fps, err)
		}
	}
	other := providerConfig{InterfaceType: "volcengine-ark-video", Model: "other-video", BaseURL: "https://ark.cn-beijing.volces.com/api/v3"}
	if err := referenceVideoFrameRateError(other, 0, 23.976); err != nil {
		t.Fatalf("non-Seedance Ark fps gated: %v", err)
	}
}
