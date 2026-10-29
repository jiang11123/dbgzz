package generation

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSpeechAudioEventsRequireCompletion(t *testing.T) {
	delta := `data: {"type":"speech.audio.delta","audio":"` + base64.StdEncoding.EncodeToString([]byte("ID3music")) + `"}` + "\n\n"
	done := "data: {\"type\":\"speech.audio.done\"}\n\n"
	for _, body := range []string{": PING\n\n", delta, done, delta + "data: {\"error\":{\"message\":\"failed\"}}\n\n", delta + done + delta, delta + done + done} {
		if _, _, err := readSpeechAudioEvents(context.Background(), []byte(body)); err == nil {
			t.Fatalf("accepted incomplete/invalid stream: %s", body)
		}
	}
	got, mime, err := readSpeechAudioEvents(context.Background(), []byte(": PING\n\n"+delta+done))
	if err != nil || string(got) != "ID3music" || mime != "audio/mpeg" {
		t.Fatalf("audio=%q mime=%s err=%v", got, mime, err)
	}
}

func TestRunMusicNormalizesOldFormatAndSendsSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["response_format"] != "mp3" || body["stream_format"] != "sse" {
			t.Errorf("invalid music request %v", body)
		}
		setting := body["metadata"].(map[string]interface{})["audio_setting"].(map[string]interface{})
		if setting["bitrate"] != float64(256000) {
			t.Errorf("missing high quality default: %v", setting)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(": PING\n\ndata: {\"type\":\"speech.audio.delta\",\"audio\":\"SUQzbXVzaWM=\"}\n\ndata: {\"type\":\"speech.audio.done\"}\n\n"))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", server.URL)
	for _, withPlugin := range []bool{false, true} {
		ctx := context.Background()
		config := Config{Model: "minimax-music-v3.0", BaseURL: server.URL, AudioFormat: "flac"}
		if withPlugin {
			config.InterfaceType = "openai-audio"
			registry := LoadOfficialFallbackRegistry()
			if _, ok := registry.Resolve("openai-audio"); !ok {
				t.Fatal("official audio plugin missing; build plugin-packages first")
			}
			ctx = WithProtocolRegistry(ctx, registry)
		}
		result, err := RunAudioTask(ctx, Input{Mode: "audio", Config: config, Prompt: "piano"})
		if err != nil {
			t.Fatal(err)
		}
		audio := result["audio"].(map[string]interface{})
		if (audio["format"] != nil && audio["format"] != "mp3") || !strings.HasPrefix(audio["dataUrl"].(string), "data:audio/mpeg;base64,") {
			t.Fatal(audio)
		}
	}
}

func TestMusicSSEEndpointUsesExactProductionOrExplicitLoopback(t *testing.T) {
	t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", "http://127.0.0.1:33419")
	for _, endpoint := range []string{"https://beeftv.app", "https://enterprise.beefapi.com/v1", "http://127.0.0.1:33419/v1"} {
		if !isBeefAPIHostFromURL(endpoint) {
			t.Errorf("rejected endpoint %s", endpoint)
		}
	}
	for _, endpoint := range []string{"http://127.0.0.1:33418", "https://beeftv.app.attacker.example", "https://user@beeftv.app", "https://beeftv.app:444", "https://api.beefapi.com", "http://192.168.1.4:33419"} {
		if isBeefAPIHostFromURL(endpoint) {
			t.Errorf("accepted endpoint %s", endpoint)
		}
	}
	t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", "https://attacker.example")
	if isBeefAPIHostFromURL("https://attacker.example") {
		t.Fatal("accepted invalid test origin")
	}
}

func TestMusicPluginRejectsIncompleteOrNonAudioResponses(t *testing.T) {
	registry := LoadOfficialFallbackRegistry()
	if _, ok := registry.Resolve("openai-audio"); !ok {
		t.Fatal("official audio plugin missing")
	}
	for _, tc := range []struct{ name, mime, body string }{
		{"incomplete", "text/event-stream", ": PING\n\n"},
		{"non-audio-complete", "text/event-stream", "data: {\"type\":\"speech.audio.delta\",\"audio\":\"bm90IGF1ZGlv\"}\n\ndata: {\"type\":\"speech.audio.done\"}\n\n"},
		{"json-error", "application/json", `{"error":{"message":"upstream rejected"}}`},
		{"html-error", "text/html", "<html>failed</html>"},
		{"sse-error", "text/event-stream", "event: error\ndata: {\"error\":{\"message\":\"failed\"}}\n\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.mime)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", server.URL)
			_, err := RunAudioTask(WithProtocolRegistry(context.Background(), registry), Input{Mode: "audio", Config: Config{InterfaceType: "openai-audio", Model: "minimax-music-v3.0", BaseURL: server.URL, AudioFormat: "flac"}, Prompt: "piano"})
			if err == nil {
				t.Fatal("accepted invalid audio result")
			}
		})
	}
}

func TestMusicChannelNameDoesNotEnableSSEForCustomOrigin(t *testing.T) {
	t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if _, ok := body["stream_format"]; ok {
			t.Errorf("custom origin received enterprise SSE extension: %v", body)
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3music"))
	}))
	defer server.Close()
	for _, withPlugin := range []bool{false, true} {
		ctx := context.Background()
		config := Config{ChannelID: "beefapi", Model: "minimax-music-v3.0", BaseURL: server.URL}
		if withPlugin {
			config.InterfaceType = "openai-audio"
			ctx = WithProtocolRegistry(ctx, LoadOfficialFallbackRegistry())
		}
		if _, err := RunAudioTask(ctx, Input{Mode: "audio", Config: config, Prompt: "piano"}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMusicSignedResultDownloadsWithoutModelCredential(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	downloads := 0
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads++
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "" {
			t.Error("signed media download must be an unauthenticated GET")
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3music"))
	}))
	defer media.Close()
	done := "data: {\"type\":\"speech.audio.done\",\"audio_url\":\"" + media.URL + "/music.mp3?signature=test-fixture\"}\n\n"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer model-key-fixture" {
			t.Error("provider request did not carry its model credential")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(done))
	}))
	defer provider.Close()
	t.Setenv("BEEFTV_ENTERPRISE_TEST_ORIGIN", provider.URL)
	for _, withPlugin := range []bool{false, true} {
		ctx := context.Background()
		config := Config{Model: "minimax-music-v3.0", BaseURL: provider.URL, APIKey: "model-key-fixture"}
		if withPlugin {
			config.InterfaceType = "openai-audio"
			ctx = WithProtocolRegistry(ctx, LoadOfficialFallbackRegistry())
		}
		if _, err := RunAudioTask(ctx, Input{Mode: "audio", Config: config, Prompt: "piano"}); err != nil {
			t.Fatal(err)
		}
	}
	if downloads != 2 {
		t.Fatalf("signed media downloads = %d, want 2", downloads)
	}
	delta := "data: {\"type\":\"speech.audio.delta\",\"audio\":\"SUQzbXVzaWM=\"}\n\n"
	for _, body := range []string{
		delta + done,
		"data: {\"type\":\"speech.audio.done\",\"audio_url\":\"http://user:secret@" + strings.TrimPrefix(media.URL, "http://") + "/music.mp3\"}\n\n",
		"data: {\"type\":\"speech.audio.done\",\"audio_url\":\"file:///music.mp3\"}\n\n",
	} {
		if _, _, err := readSpeechAudioEvents(context.Background(), []byte(body)); err == nil {
			t.Fatal("accepted mixed or invalid signed result")
		}
	}
	if downloads != 2 {
		t.Fatalf("invalid result unexpectedly fetched media: %d", downloads)
	}
}
