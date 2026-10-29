package operations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/editing"
	"infinite-canvas/backend/internal/model"
)

type mediaDomain struct {
	unusedDomain
	data         []byte
	owner        string
	opens        int
	document     json.RawMessage
	assetPayload string
	mimeType     string
}

func (d *mediaDomain) UserCanvasProject(user, id string) (json.RawMessage, error) {
	if user != d.owner || id != "canvas" {
		return nil, PermissionDenied("foreign_canvas", "foreign")
	}
	if len(d.document) > 0 {
		return d.document, nil
	}
	return json.RawMessage(`{"nodes":[{"id":"node","metadata":{"resourceId":"resource"}}]}`), nil
}
func (d *mediaDomain) OwnedAsset(user, id string) (*model.Asset, error) {
	if user != d.owner || id != "asset" {
		return nil, PermissionDenied("foreign_asset", "foreign")
	}
	if d.assetPayload != "" {
		return &model.Asset{ID: id, PayloadJSON: d.assetPayload}, nil
	}
	return &model.Asset{ID: id, PayloadJSON: `{"resourceId":"resource"}`}, nil
}
func (d *mediaDomain) OwnedReadyResource(user, id string) (*model.Resource, error) {
	if user != d.owner || id != "resource" {
		return nil, PermissionDenied("foreign_resource", "foreign")
	}
	mimeType := d.mimeType
	if mimeType == "" {
		mimeType = "video/mp4"
	}
	return &model.Resource{ID: id, MimeType: mimeType, Size: int64(len(d.data))}, nil
}
func (d *mediaDomain) OpenMediaResource(_ context.Context, user, id string) (io.ReadCloser, error) {
	if _, err := d.OwnedReadyResource(user, id); err != nil {
		return nil, err
	}
	d.opens++
	return io.NopCloser(bytes.NewReader(d.data)), nil
}

func TestMediaScopeAndReferenceCannotBeWidened(t *testing.T) {
	d := &mediaDomain{owner: "owner"}
	ctx := &Context{Context: context.Background(), UserID: "owner", Domain: d}
	for _, args := range []mediaArgs{
		{CanvasID: "foreign", NodeID: "node"}, {CanvasID: "canvas", NodeID: "missing"},
		{CanvasID: "canvas", NodeID: "node", ResourceID: "other"}, {CanvasID: "canvas", AssetID: "foreign"},
		{CanvasID: "canvas", NodeID: "node", AssetID: "asset"},
	} {
		if _, err := resolveMediaResource(ctx, args); err == nil {
			t.Fatalf("accepted %+v", args)
		}
	}
	if d.opens != 0 {
		t.Fatal("unauthorized targets opened bytes")
	}
	if _, err := runMedia(ctx, "media.overview", json.RawMessage(`{"canvasId":"canvas","nodeId":"node","path":"/etc/passwd"}`)); err == nil {
		t.Fatal("accepted model filesystem path")
	}
}

func TestMediaResourceLocatorsUseStrictOwnedReferences(t *testing.T) {
	for _, raw := range []string{
		`{"metadata":{"storageKey":"resource:resource"}}`,
		`{"metadata":{"content":"resource:resource"}}`,
		`{"data":{"storageKey":"resource:resource"}}`,
	} {
		var target any
		_ = json.Unmarshal([]byte(raw), &target)
		ids := map[string]bool{}
		collectMediaResourceIDs(target, ids)
		if len(ids) != 1 || !ids["resource"] {
			t.Fatalf("missed %s: %+v", raw, ids)
		}
	}
	for _, value := range []string{"https://example.com/resource:x", "/tmp/resource", "resource:", "resource:../secret", "resource:https://example.com/x", "resource:foreign?token=x", "reference resource:resource", "resource:resource/file"} {
		ids := map[string]bool{}
		collectMediaResourceIDs(map[string]any{"metadata": map[string]any{"storageKey": value, "content": value}}, ids)
		if len(ids) != 0 {
			t.Fatalf("accepted unsafe locator %q", value)
		}
	}
}

func TestNativeMediaNormalCanvasAndAssetLocators(t *testing.T) {
	data := nativeMediaFixture(t, true, false)
	for _, locator := range []string{"storageKey", "content"} {
		d := &mediaDomain{owner: "owner", data: data, document: json.RawMessage(`{"nodes":[{"id":"node","metadata":{"` + locator + `":"resource:resource"}}]}`), assetPayload: `{"data":{"storageKey":"resource:resource"}}`}
		for _, args := range []mediaArgs{{CanvasID: "canvas", NodeID: "node"}, {CanvasID: "canvas", AssetID: "asset"}} {
			overview, err := mediaTestCall(t, d, "media.overview", args)
			if err != nil {
				t.Fatalf("%s %+v %v", locator, args, err)
			}
			args.ExpectedVersion = overview.Source.Version
			args.Mode = "audio"
			args.EndMs = 1000
			result, err := mediaTestCall(t, d, "media.inspect", args)
			if err != nil || len(result.Content) != 1 {
				t.Fatalf("inspect %s %+v %v", locator, result, err)
			}
			args.ResourceID = "foreign"
			if _, err := mediaTestCall(t, d, "media.inspect", args); AsError(err).Reason != "media_not_referenced" {
				t.Fatalf("foreign accepted %v", err)
			}
		}
	}
}

func TestMediaMeasurementsKeepSourceTime(t *testing.T) {
	intervals, mean, peak := parseMediaChecks("black_start:1.25 black_end:1.75 black_duration:0.5\nmean_volume: -21.1 dB\nmax_volume: -13.7 dB", 3000)
	if len(intervals) != 1 || intervals[0].StartMs != 4250 || intervals[0].EndMs != 4750 || mean == nil || *mean != -21.1 || peak == nil || *peak != -13.7 {
		t.Fatalf("%+v %v %v", intervals, mean, peak)
	}
}

func TestNativeMediaSilenceIntervalsUseBoundedSourceTime(t *testing.T) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Fatal("real ffmpeg required")
	}
	for _, test := range []struct {
		name, expression string
		expected         []MediaInterval
	}{
		{"multiple-leading-trailing", "if(between(t,0.5,1)+between(t,1.4,2)+between(t,2.3,2.9),0.3*sin(2*PI*440*t),0)", []MediaInterval{{200, 500}, {1000, 1400}, {2000, 2300}, {2900, 3300}}},
		{"all-silent", "0", []MediaInterval{{200, 3300}}},
		{"continuous-tone", "0.3*sin(2*PI*440*t)", nil},
		{"gap-under-minimum", "if(between(t,1,1.05),0,0.3*sin(2*PI*440*t))", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			output := filepath.Join(t.TempDir(), "source.wav")
			cmd := exec.Command(bin, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "aevalsrc='"+test.expression+"':s=24000:d=3.5", "-c:a", "pcm_s16le", output)
			if raw, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("fixture %v %s", err, raw)
			}
			data, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			d := &mediaDomain{owner: "owner", data: data, mimeType: "audio/wav"}
			args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
			overview, err := mediaTestCall(t, d, "media.overview", args)
			if err != nil {
				t.Fatal(err)
			}
			args.ExpectedVersion = overview.Source.Version
			args.StartMs = 200
			args.EndMs = 3300
			check, err := mediaTestCall(t, d, "media.check", args)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(check)
			var measured struct {
				SilenceIntervals []MediaInterval `json:"silenceIntervals"`
				SilenceDetection *struct {
					NoiseDB           float64 `json:"noiseDb"`
					MinimumDurationMs int64   `json:"minimumDurationMs"`
					TimestampKind     string  `json:"timestampKind"`
				} `json:"silenceDetection"`
			}
			if err := json.Unmarshal(raw, &measured); err != nil {
				t.Fatal(err)
			}
			if measured.SilenceDetection == nil || measured.SilenceDetection.NoiseDB != -35 || measured.SilenceDetection.MinimumDurationMs != 120 || measured.SilenceDetection.TimestampKind != "source_time" {
				t.Fatalf("missing fixed detection facts %s", raw)
			}
			if len(measured.SilenceIntervals) != len(test.expected) {
				t.Fatalf("intervals %+v want %+v", measured.SilenceIntervals, test.expected)
			}
			for i, interval := range measured.SilenceIntervals {
				want := test.expected[i]
				if interval.StartMs < 200 || interval.EndMs > 3300 || interval.StartMs < want.StartMs-3 || interval.StartMs > want.StartMs+3 || interval.EndMs < want.EndMs-3 || interval.EndMs > want.EndMs+3 {
					t.Fatalf("source interval %+v want %+v", interval, want)
				}
			}
			if check.MeanDB == nil && test.name != "all-silent" {
				t.Fatal("volume behavior lost")
			}
		})
	}
}

func TestMediaSilenceParserClosesAndClampsRequestedEdges(t *testing.T) {
	if got := parseMediaSilence("silence_start: -0.5", 0, 2000); len(got) != 1 || got[0] != (MediaInterval{0, 2000}) {
		t.Fatalf("negative decoder padding lost unclosed leading silence: %+v", got)
	}
	for _, test := range []struct {
		log      string
		expected []MediaInterval
	}{
		{"silence_start: 1.25", []MediaInterval{{4250, 5500}}},
		{"silence_end: 0.75", []MediaInterval{{3000, 3750}}},
		{"silence_end: 7.5e-1", []MediaInterval{{3000, 3750}}},
		{"silence_start: -0.5\nsilence_end: 5", []MediaInterval{{3000, 5500}}},
		{"silence_start: 3\nsilence_end: 4", nil},
		{"mean_volume: -21 dB", nil},
	} {
		got := parseMediaSilence(test.log, 3000, 5500)
		if len(got) != len(test.expected) {
			t.Fatalf("%q: %+v want %+v", test.log, got, test.expected)
		}
		for i := range got {
			if got[i] != test.expected[i] {
				t.Fatalf("%q: %+v want %+v", test.log, got, test.expected)
			}
		}
	}
}

func TestMediaRejectsPlaylistsBeforeDecoder(t *testing.T) {
	d := &mediaDomain{owner: "owner", data: []byte("#EXTM3U\nfile:///etc/passwd")}
	_, err := runMedia(&Context{Context: context.Background(), UserID: "owner", Domain: d}, "media.overview", json.RawMessage(`{"canvasId":"canvas","nodeId":"node"}`))
	if e := AsError(err); e == nil || e.Reason != "media_format_unsupported" {
		t.Fatalf("error=%v", err)
	}
}

func nativeMediaFixture(t *testing.T, audio, black bool) []byte {
	t.Helper()
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable")
	}
	path := filepath.Join(t.TempDir(), "fixture.mp4")
	args := []string{"-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=160x120:r=24:d=2"}
	if audio {
		args = append(args, "-f", "lavfi", "-i", "sine=frequency=1000:duration=2", "-c:a", "aac")
	}
	if black {
		args = append(args, "-vf", "drawbox=enable='between(t,0.5,1)':x=0:y=0:w=iw:h=ih:color=black:t=fill")
	}
	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "2", "-y", path)
	if out, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mediaTestCall(t *testing.T, d *mediaDomain, op string, args mediaArgs) (MediaResult, error) {
	t.Helper()
	raw, _ := json.Marshal(args)
	value, err := runMedia(&Context{Context: context.Background(), UserID: "owner", Domain: d}, op, raw)
	if err != nil {
		return MediaResult{}, err
	}
	return value.(MediaResult), nil
}

func TestNativeMediaReadCheckVersionAndBounds(t *testing.T) {
	d := &mediaDomain{owner: "owner", data: nativeMediaFixture(t, true, true)}
	args := mediaArgs{CanvasID: "canvas", NodeID: "node"}
	overview, err := mediaTestCall(t, d, "media.overview", args)
	if err != nil {
		t.Fatal(err)
	}
	if !overview.HasAudio || !overview.HasVideo || len(overview.Content) != 3 {
		t.Fatalf("overview=%+v", overview)
	}
	for _, part := range overview.Content {
		data, err := base64.StdEncoding.DecodeString(part.Data)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if part.MimeType != "image/jpeg" || part.SHA256 != hex.EncodeToString(sum[:]) || !strings.HasPrefix(string(data), "\xff\xd8") || part.Source.TimestampKind != "requested_seek" {
			t.Fatal("invalid real image payload")
		}
	}
	args.ExpectedVersion = overview.Source.Version
	check, err := mediaTestCall(t, d, "media.check", args)
	if err != nil {
		t.Fatal(err)
	}
	if len(check.BlackIntervals) != 1 || check.BlackIntervals[0].StartMs < 450 || check.BlackIntervals[0].EndMs > 1100 || check.MeanDB == nil || *check.MeanDB > -10 || *check.MeanDB < -30 {
		t.Fatalf("check=%+v", check)
	}
	args.Mode = "audio"
	args.StartMs = 500
	args.EndMs = 1500
	audio, err := mediaTestCall(t, d, "media.inspect", args)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := base64.StdEncoding.DecodeString(audio.Content[0].Data)
	if string(data[:4]) != "RIFF" || audio.Content[0].MimeType != "audio/wav" || audio.Content[0].Source.StartMs != 500 {
		t.Fatal("audio did not retain real bytes/source interval")
	}
	args.Mode = "video"
	video, err := mediaTestCall(t, d, "media.inspect", args)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = base64.StdEncoding.DecodeString(video.Content[0].Data)
	if len(data) < 12 || string(data[4:8]) != "ftyp" || video.Content[0].MimeType != "video/mp4" {
		t.Fatal("video did not retain real MP4 payload")
	}
	args.ExpectedVersion = "stale"
	if _, err := mediaTestCall(t, d, "media.inspect", args); AsError(err).Reason != "stale_media_version" {
		t.Fatalf("stale=%v", err)
	}
	args.ExpectedVersion = ""
	if _, err := mediaTestCall(t, d, "media.inspect", args); AsError(err).Reason != "media_version_required" {
		t.Fatalf("missing version=%v", err)
	}
	args.ExpectedVersion = overview.Source.Version
	args.EndMs = 3000
	if _, err := mediaTestCall(t, d, "media.inspect", args); AsError(err).Reason != "invalid_media_interval" {
		t.Fatalf("bounds=%v", err)
	}
}

func TestNativeMediaCleanNegative(t *testing.T) {
	d := &mediaDomain{owner: "owner", data: nativeMediaFixture(t, false, false)}
	args := mediaArgs{CanvasID: "canvas", AssetID: "asset"}
	overview, err := mediaTestCall(t, d, "media.overview", args)
	if err != nil {
		t.Fatal(err)
	}
	args.ExpectedVersion = overview.Source.Version
	check, err := mediaTestCall(t, d, "media.check", args)
	if err != nil {
		t.Fatal(err)
	}
	if check.HasAudio || check.MeanDB != nil || len(check.BlackIntervals) != 0 || len(check.SilenceIntervals) != 0 || check.SilenceDetection != nil {
		t.Fatalf("false positives=%+v", check)
	}
}

func TestNativeMediaOverviewEvidenceUsesOneOwnedSnapshot(t *testing.T) {
	d := &mediaDomain{owner: "owner", data: nativeMediaFixture(t, true, true)}
	start, end := int64(250), int64(1750)
	result, err := mediaTestCall(t, d, "media.overview", mediaArgs{CanvasID: "canvas", NodeID: "node",
		Evidence: &mediaEvidenceRequest{StartMs: &start, EndMs: &end, Modes: []string{"frames", "video", "audio"}, Checks: true}})
	if err != nil {
		t.Fatal(err)
	}
	if d.opens != 1 || strings.Join(result.Evidence, ",") != "frames,video,audio,check" || len(result.Content) != 6 {
		t.Fatalf("snapshot/evidence: opens=%d modes=%v parts=%d", d.opens, result.Evidence, len(result.Content))
	}
	sum := sha256.Sum256(d.data)
	if result.Source.Version != hex.EncodeToString(sum[:]) || result.Source.StartMs != start || result.Source.EndMs != end {
		t.Fatalf("wrong source snapshot: %+v", result.Source)
	}
	if len(result.BlackIntervals) != 1 || result.BlackIntervals[0].StartMs < 450 || result.BlackIntervals[0].EndMs > 1100 || result.MeanDB == nil || result.SilenceDetection == nil {
		t.Fatalf("objective checks missing: %+v", result)
	}
	seen := map[string]int{}
	for _, part := range result.Content {
		data, err := base64.StdEncoding.DecodeString(part.Data)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		if part.Source.Version != result.Source.Version || part.Source.ResourceID != result.Source.ResourceID || part.SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatal("evidence did not retain actual bytes and one source version")
		}
		seen[part.MimeType]++
		if part.Type == "image" {
			if part.Source.StartMs < start || part.Source.EndMs > end || part.Source.TimestampKind != "requested_seek" {
				t.Fatal("frame outside requested interval")
			}
			continue
		}
		if part.Source.StartMs != start || part.Source.EndMs != end {
			t.Fatal("native interval changed")
		}
		path := filepath.Join(t.TempDir(), "native")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		facts, err := editing.Probe(context.Background(), path)
		if err != nil || !facts.HasAudio || facts.DurationMs < 1450 || facts.DurationMs > 1550 || (part.MimeType == "video/mp4" && !facts.HasVideo) {
			t.Fatalf("not real bounded native media: %s %+v %v", part.MimeType, facts, err)
		}
	}
	if seen["image/jpeg"] != 4 || seen["audio/wav"] != 1 || seen["video/mp4"] != 1 {
		t.Fatalf("requested evidence missing: %v", seen)
	}
}

func TestMediaEvidenceRejectsInvalidRequestsBeforeOpeningSource(t *testing.T) {
	d := &mediaDomain{owner: "owner"}
	for _, raw := range []string{
		`{"evidence":{"endMs":1000,"modes":["audio"]}}`,
		`{"evidence":{"startMs":0,"endMs":1000}}`,
		`{"evidence":{"startMs":0,"endMs":1000,"modes":["audio","audio"]}}`,
		`{"evidence":{"startMs":0,"endMs":1000,"modes":["summary"]}}`,
		`{"evidence":{"startMs":0,"endMs":15001,"modes":["audio"]}}`,
		`{"evidence":{"startMs":-1,"endMs":1000,"modes":["audio"]}}`,
	} {
		var args map[string]any
		_ = json.Unmarshal([]byte(raw), &args)
		args["canvasId"], args["nodeId"] = "canvas", "node"
		params, _ := json.Marshal(args)
		if result, err := runMedia(&Context{Context: context.Background(), UserID: "owner", Domain: d}, "media.overview", params); err == nil || result != nil {
			t.Fatalf("accepted invalid evidence: %s", raw)
		}
	}
	if d.opens != 0 {
		t.Fatal("invalid requests opened source bytes")
	}
	raw := json.RawMessage(`{"canvasId":"canvas","nodeId":"node","expectedVersion":"hash","evidence":{"startMs":0,"endMs":1000,"modes":["audio"]}}`)
	if _, err := runMedia(&Context{Context: context.Background(), UserID: "owner", Domain: d}, "media.inspect", raw); AsError(err).Reason != "invalid_media_evidence" {
		t.Fatalf("evidence widened inspect contract: %v", err)
	}
}

func TestNativeMediaEvidenceNeverReturnsPartialSuccess(t *testing.T) {
	d := &mediaDomain{owner: "owner", data: nativeMediaFixture(t, false, false)}
	raw := json.RawMessage(`{"canvasId":"canvas","nodeId":"node","evidence":{"startMs":0,"endMs":1000,"modes":["frames","audio"],"checks":true}}`)
	result, err := runMedia(&Context{Context: context.Background(), UserID: "owner", Domain: d}, "media.overview", raw)
	if result != nil || AsError(err).Reason != "media_no_audio" || d.opens != 1 {
		t.Fatalf("partial success or repeated read: %v %v opens=%d", result, err, d.opens)
	}
}

func TestMediaDiscoveryExplainsEvidenceAndInspectionModes(t *testing.T) {
	r := NewRegistry(nil, nil)
	registerMediaOps(r)
	seen := map[string]bool{}
	for _, descriptor := range r.List(Caller{Kind: CallerManual}) {
		if seen[descriptor.Summary] {
			t.Fatal("media operations share an ambiguous summary")
		}
		seen[descriptor.Summary] = true
		var schema struct {
			Required   []string `json:"required"`
			Properties map[string]struct {
				Description string   `json:"description"`
				Enum        []string `json:"enum"`
			} `json:"properties"`
		}
		if err := json.Unmarshal(descriptor.Params, &schema); err != nil {
			t.Fatal(err)
		}
		if slices.Contains(schema.Required, "expectedVersion") != (descriptor.ID != "media.overview") {
			t.Fatalf("%s discovery does not match the required media version", descriptor.ID)
		}
		if descriptor.ID == "media.review" {
			if !slices.Contains(schema.Required, "question") || descriptor.Replay != "unsafe" {
				t.Fatal("review must require a question and avoid replaying external charges")
			}
			continue
		}
		mode := schema.Properties["mode"]
		for _, word := range []string{"frames", "静态", "video", "连续", "audio", "声音"} {
			if !strings.Contains(mode.Description, word) {
				t.Fatalf("%s mode omitted %s: %s", descriptor.ID, word, mode.Description)
			}
		}
		if strings.Join(mode.Enum, ",") != "frames,video,audio" {
			t.Fatal("mode behavior contract changed")
		}
		switch descriptor.ID {
		case "media.overview":
			if !strings.Contains(descriptor.Summary, "不能替代") {
				t.Fatal("preview claims full inspection")
			}
		case "media.inspect":
			if !strings.Contains(descriptor.Summary, "15 秒") {
				t.Fatal("inspection interval not discoverable")
			}
		case "media.check":
			if !strings.Contains(descriptor.Summary, "不能判断") {
				t.Fatal("measurements imply sound understanding")
			}
		}
	}
	if len(seen) != 4 {
		t.Fatal("incomplete media discovery")
	}
}
