package workspace

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderConfigMigratesLegacyBeefAPIStateWithoutLosingLocalChoices(t *testing.T) {
	dir := t.TempDir()
	legacy := `{
        "channels":[{"id":"beefapi","name":"BeefAPI old","baseUrl":"https://old.invalid","apiKey":"local-secret","headers":[{"name":"X-Site","value":"desktop"}],"enabled":false,"models":["legacy-model"],"modelProfiles":[{"model":"seedance-2.0-fast","protocol":"newapi-channel-1","capability":"video"}]}],
        "imageModel":"beefapi::gpt-image-2","videoModel":"beefapi::seedance-2.0-fast","textModel":"beefapi::gpt-5.6-sol","audioModel":"beefapi::minimax-music-v3.0"
    }`
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}

	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthMigrated {
		t.Fatalf("health = %q", health)
	}
	channel := requireEffectiveChannel(t, effective, "beefapi")
	if channel["name"] != "BeefTV" || channel["baseUrl"] != "https://beeftv.app" {
		t.Fatal("preset-owned identity was not repaired")
	}
	if channel["apiKey"] != "local-secret" || channel["enabled"] != false {
		t.Fatal("local channel state was not preserved")
	}
	headers, _ := channel["headers"].([]any)
	if len(headers) != 1 {
		t.Fatalf("local headers were not preserved: %#v", channel["headers"])
	}
	profiles, _ := channel["modelProfiles"].([]any)
	if len(profiles) != 1 {
		t.Fatalf("fetched model profiles were not preserved: %#v", profiles)
	}
	models, _ := channel["models"].([]string)
	if len(models) != 1 || models[0] != "legacy-model" {
		t.Fatalf("fetched model catalog was not preserved: %#v", models)
	}
	for key, want := range map[string]string{
		"imageModel": "beefapi::gpt-image-2", "videoModel": "beefapi::seedance-2.0-fast",
		"textModel": "beefapi::gpt-5.6-sol", "audioModel": "beefapi::minimax-music-v3.0",
	} {
		if effective.Config[key] != want {
			t.Fatalf("%s = %#v", key, effective.Config[key])
		}
	}
}

func TestProviderConfigSeedsBeefAPIWhenLocalStateIsMissing(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthDefault {
		t.Fatalf("health = %q", health)
	}
	channel := requireEffectiveChannel(t, effective, "beefapi")
	if channel["apiKey"] != "" || channel["enabled"] != true {
		t.Fatal("unexpected seeded local state")
	}
}

func TestProviderConfigRecoversLastValidBackup(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"first-secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"second-secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile), []byte(`{"schemaVersion":`), 0o600); err != nil {
		t.Fatal(err)
	}

	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthRecovered {
		t.Fatalf("health = %q", health)
	}
	if got := requireEffectiveChannel(t, effective, "beefapi")["apiKey"]; got != "first-secret" {
		t.Fatal("recovered credential does not match the last valid backup")
	}
}

func TestProviderConfigCommittedRevisionOnlyAdvancesAfterValidWrite(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"beefapi","apiKey":"secret","enabled":true}]}`)); err != nil {
		t.Fatal(err)
	}
	first, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":`)); err == nil {
		t.Fatal("invalid config was accepted")
	}
	second, _, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || second.Revision != first.Revision {
		t.Fatalf("revisions = %d then %d", first.Revision, second.Revision)
	}
}

func TestProviderConfigIdenticalSaveKeepsRevision(t *testing.T) {
	store, err := NewProviderConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"channels":[{"id":"custom","apiKey":"test-secret","enabled":true}]}`)
	revision, err := store.SaveLocalModelConfigRevision(body, 0)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := store.SaveLocalModelConfigRevision([]byte(`{"channels":[{"enabled":true,"apiKey":"__BEEFTV_REDACTED__","id":"custom"}]}`), revision)
	if err != nil {
		t.Fatal(err)
	}
	if repeated != revision {
		t.Fatalf("unchanged settings advanced revision: %d -> %d", revision, repeated)
	}
	if err := store.SaveCatalogWithAssistantDefault(body, "connection", ""); err != nil {
		t.Fatal(err)
	}
	doc, err := store.loadPrimaryDocument()
	if err != nil {
		t.Fatal(err)
	}
	if doc.Revision != revision || doc.AssistantDefaultAuthorization != "connection" {
		t.Fatalf("no-op catalog lost initialization or changed revision: revision=%d marker=%q", doc.Revision, doc.AssistantDefaultAuthorization)
	}
	if err := store.SaveCatalogWithAssistantDefault(body, "connection", ""); err != nil {
		t.Fatal(err)
	}
	doc, err = store.loadPrimaryDocument()
	if err != nil {
		t.Fatal(err)
	}
	if doc.Revision != revision {
		t.Fatalf("repeated catalog advanced revision: %d -> %d", revision, doc.Revision)
	}
}

func TestProviderConfigSeparateHandlesSharePathMutexAndCAS(t *testing.T) {
	dir := t.TempDir()
	first, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewProviderConfig(filepath.Join(dir, "."))
	if err != nil {
		t.Fatal(err)
	}
	if first.mu == nil || first.mu != second.mu {
		t.Fatal("handles for one workspace path must share a mutex")
	}
	if err := first.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	effective, _, err := first.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	revision := effective.Revision

	var (
		wg       sync.WaitGroup
		success  atomic.Int32
		conflict atomic.Int32
		other    atomic.Int32
	)
	start := make(chan struct{})
	for _, store := range []*ProviderConfig{first, second} {
		store := store
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, saveErr := store.SaveLocalModelConfigRevision([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret","label":"updated"}]}`), revision)
			switch {
			case saveErr == nil:
				success.Add(1)
			case errors.Is(saveErr, ErrProviderConfigRevisionConflict):
				conflict.Add(1)
			default:
				other.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if success.Load() != 1 || conflict.Load() != 1 || other.Load() != 0 {
		t.Fatalf("concurrent CAS results: success=%d conflict=%d other=%d", success.Load(), conflict.Load(), other.Load())
	}
	raw, err := first.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("kept-secret")) {
		t.Fatal("committed config dropped the credential")
	}
}

func TestProviderConfigRedactedUpdatePreservesCredentialsAcrossHandles(t *testing.T) {
	dir := t.TempDir()
	writer, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	reader, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	redacted, err := reader.ReadRedactedModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(redacted, []byte("kept-secret")) || !bytes.Contains(redacted, []byte(RedactedSecret)) {
		t.Fatal("redacted view leaked or dropped the secret marker")
	}
	var view map[string]any
	if err := json.Unmarshal(redacted, &view); err != nil {
		t.Fatal(err)
	}
	view["label"] = "from-other-handle"
	updated, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.SaveLocalModelConfig(updated); err != nil {
		t.Fatal(err)
	}
	raw, err := writer.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("kept-secret")) || !bytes.Contains(raw, []byte("from-other-handle")) {
		t.Fatal("redacted update did not preserve the credential")
	}
}

func TestProviderConfigCorruptExistingFileIsUnchanged(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret","label":"second"}]}`)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LocalProviderConfigFile)
	corrupt := []byte(`{"schemaVersion":`)
	if err := os.WriteFile(path, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"replacement"}]}`)); err == nil {
		t.Fatal("corrupt existing file was replaced")
	}
	other, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.SaveLocalModelConfigRevision([]byte(`{"channels":[]}`), 1); err == nil {
		t.Fatal("corrupt existing file accepted a revision write")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, corrupt) {
		t.Fatal("corrupt existing file was modified")
	}
}

func TestProviderConfigMalformedRevisionRejectsMutation(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LocalProviderConfigFile)
	malformed := []byte(`{"schemaVersion":1,"revision":-1,"config":{"channels":[]}}`)
	if err := os.WriteFile(path, malformed, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadEffectiveModelConfig(); err == nil {
		t.Fatal("negative revision was accepted")
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[]}`)); err == nil {
		t.Fatal("malformed revision was overwritten")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, malformed) {
		t.Fatal("malformed revision file was modified")
	}
}

func TestProviderConfigCrossWorkspaceSavesAreIndependent(t *testing.T) {
	leftDir := t.TempDir()
	rightDir := t.TempDir()
	left, err := NewProviderConfig(leftDir)
	if err != nil {
		t.Fatal(err)
	}
	right, err := NewProviderConfig(rightDir)
	if err != nil {
		t.Fatal(err)
	}
	if left.mu == right.mu {
		t.Fatal("distinct workspace paths must not share a mutex")
	}

	left.mu.Lock()
	done := make(chan error, 1)
	go func() {
		done <- right.SaveLocalModelConfig([]byte(`{"channels":[{"id":"right","apiKey":"right-secret"}]}`))
	}()
	select {
	case err := <-done:
		left.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		left.mu.Unlock()
		t.Fatal("save on another workspace blocked behind an unrelated mutex")
	}

	if err := left.SaveLocalModelConfig([]byte(`{"channels":[{"id":"left","apiKey":"left-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	leftRaw, err := left.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	rightRaw, err := right.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(leftRaw, []byte("left-secret")) || bytes.Contains(leftRaw, []byte("right-secret")) {
		t.Fatal("left workspace mixed credentials")
	}
	if !bytes.Contains(rightRaw, []byte("right-secret")) || bytes.Contains(rightRaw, []byte("left-secret")) {
		t.Fatal("right workspace mixed credentials")
	}
}

func TestProviderConfigInterruptedTempDoesNotReplaceLiveFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(dir, LocalProviderConfigFile)
	before, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(dir, ".local-model-config-interrupted")
	if err := os.WriteFile(leftover, []byte(`{"schemaVersion":1,"revision":99,"config":{"channels":[{"id":"direct","apiKey":"replacement"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := store.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("kept-secret")) {
		t.Fatal("live config was not retained")
	}
	after, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("leftover temp replaced the live config")
	}
}

func TestProviderConfigRemoveChannelDoesNotCopySecretToNewID(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"channel-a","apiKey":"secret-a"}]}`)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LocalProviderConfigFile)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	redacted := []byte(`{"channels":[{"id":"channel-b","apiKey":"` + RedactedSecret + `"}]}`)
	err = store.SaveLocalModelConfig(redacted)
	requireSafeError(t, err, ErrUnmatchedRedactedSecret, "secret-a")
	requireFileUnchanged(t, path, before)

	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"channel-b","apiKey":"secret-b"}]}`)); err != nil {
		t.Fatal(err)
	}
	raw, err := store.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("secret-a")) || !bytes.Contains(raw, []byte("secret-b")) {
		t.Fatal("new channel inherited another channel's credential")
	}
}

func TestProviderConfigReorderedIDsPreserveOwnSecrets(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"channel-a","apiKey":"secret-a"},{"id":"channel-b","apiKey":"secret-b"}]}`)); err != nil {
		t.Fatal(err)
	}
	reordered := []byte(`{"channels":[{"id":"channel-b","apiKey":"` + RedactedSecret + `"},{"id":"channel-a","apiKey":"` + RedactedSecret + `"}]}`)
	if err := store.SaveLocalModelConfig(reordered); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, LocalProviderConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	document, _, err := store.decodeStoredDocument(body)
	if err != nil {
		t.Fatal(err)
	}
	channels, _ := document.Config["channels"].([]any)
	if len(channels) != 2 {
		t.Fatalf("stored channel count = %d", len(channels))
	}
	first, _ := channels[0].(map[string]any)
	second, _ := channels[1].(map[string]any)
	if first["id"] != "channel-b" || first["apiKey"] != "secret-b" {
		t.Fatal("reordered channel-b lost its own credential")
	}
	if second["id"] != "channel-a" || second["apiKey"] != "secret-a" {
		t.Fatal("reordered channel-a lost its own credential")
	}
}

func TestProviderConfigDuplicateAndInvalidIDsDoNotAlias(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"channel-a","apiKey":"secret-a"},{"id":"channel-b","apiKey":"secret-b"}]}`)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LocalProviderConfigFile)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	duplicate := []byte(`{"channels":[{"id":"channel-a","apiKey":"` + RedactedSecret + `"},{"id":"channel-a","apiKey":"` + RedactedSecret + `"}]}`)
	requireSafeError(t, store.SaveLocalModelConfig(duplicate), ErrInvalidProviderIdentity, "secret-a", "secret-b")
	requireFileUnchanged(t, path, before)

	for _, body := range [][]byte{
		[]byte(`{"channels":[{"id":1,"apiKey":"` + RedactedSecret + `"}]}`),
		[]byte(`{"channels":[{"id":"","apiKey":"` + RedactedSecret + `"}]}`),
		[]byte(`{"channels":[{"id":null,"apiKey":"` + RedactedSecret + `"}]}`),
		[]byte(`{"channels":[{"id":{"nested":true},"apiKey":"` + RedactedSecret + `"}]}`),
	} {
		requireSafeError(t, store.SaveLocalModelConfig(body), ErrInvalidProviderIdentity, "secret-a", "secret-b")
		requireFileUnchanged(t, path, before)
	}

	storedDuplicate := []byte(`{"schemaVersion":1,"revision":2,"config":{"channels":[{"id":"channel-a","apiKey":"secret-a"},{"id":"channel-a","apiKey":"secret-other"}]},"presetVersions":{}}`)
	if err := os.WriteFile(path, storedDuplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	incoming := []byte(`{"channels":[{"id":"channel-a","apiKey":"` + RedactedSecret + `"}]}`)
	requireSafeError(t, store.SaveLocalModelConfig(incoming), ErrInvalidProviderIdentity, "secret-a", "secret-other")
	requireFileUnchanged(t, path, storedDuplicate)
}

func TestProviderConfigNullPrimaryUnchangedWhenBackupExists(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"first-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"second-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LocalProviderConfigFile)
	if err := os.WriteFile(path, []byte("null"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireSafeError(t, store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"replacement"}]}`)), ErrProviderConfigNotObject, "first-secret", "second-secret", "replacement")
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(bytes.TrimSpace(after)) != "null" {
		t.Fatal("null primary was modified")
	}
	if _, err := os.Stat(filepath.Join(dir, LocalProviderConfigFile+".bak")); err != nil {
		t.Fatal(err)
	}

	envelope := []byte(`{"schemaVersion":1,"revision":1,"config":null}`)
	if err := os.WriteFile(path, envelope, 0o600); err != nil {
		t.Fatal(err)
	}
	requireSafeError(t, store.SaveLocalModelConfig([]byte(`{"channels":[]}`)), ErrMalformedProviderConfig)
	requireFileUnchanged(t, path, envelope)
}

func TestProviderConfigRejectsNullIncomingWithoutReplacingSecrets(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"direct","apiKey":"kept-secret"}]}`)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, LocalProviderConfigFile)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	requireSafeError(t, store.SaveLocalModelConfig([]byte("null")), ErrProviderConfigNotObject, "kept-secret")
	requireSafeError(t, store.SaveLocalModelConfig([]byte(`["channels"]`)), ErrProviderConfigNotObject, "kept-secret")
	requireFileUnchanged(t, path, before)
	raw, err := store.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("kept-secret")) {
		t.Fatal("null incoming replaced stored credentials")
	}
}

func TestProviderConfigSymlinkAliasSharesLock(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(real, alias); err != nil {
		t.Fatal(err)
	}
	first, err := NewProviderConfig(real)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewProviderConfig(alias)
	if err != nil {
		t.Fatal(err)
	}
	if first.mu == nil || first.mu != second.mu || first.dataDir != second.dataDir {
		t.Fatal("symlink alias did not share the canonical workspace lock")
	}
	nested, err := NewProviderConfig(filepath.Join(alias, "child"))
	if err != nil {
		t.Fatal(err)
	}
	otherNested, err := NewProviderConfig(filepath.Join(real, "child"))
	if err != nil {
		t.Fatal(err)
	}
	if nested.mu != otherNested.mu {
		t.Fatal("missing suffix under a symlink alias used a different lock")
	}
}

func TestProviderConfigSymlinkLoopFailsSafely(t *testing.T) {
	dir := t.TempDir()
	left := filepath.Join(dir, "left")
	right := filepath.Join(dir, "right")
	if err := os.Symlink(right, left); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(left, right); err != nil {
		t.Fatal(err)
	}
	_, err := NewProviderConfig(left)
	if err == nil {
		t.Fatal("symlink loop was accepted")
	}
	if strings.Contains(err.Error(), RedactedSecret) || strings.Contains(err.Error(), "apiKey") {
		t.Fatal("path error exposed a credential")
	}

	blocked := filepath.Join(dir, "file")
	if err := os.WriteFile(blocked, []byte("not-a-dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = NewProviderConfig(filepath.Join(blocked, "child"))
	if err == nil {
		t.Fatal("path through a file was accepted")
	}
}

func requireSafeError(t *testing.T, err, want error, secrets ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected error")
	}
	if want != nil && !errors.Is(err, want) {
		t.Fatalf("error type mismatch")
	}
	text := err.Error()
	if strings.Contains(text, RedactedSecret) {
		t.Fatal("error exposed the redaction marker")
	}
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatal("error exposed a credential")
		}
	}
}

func requireFileUnchanged(t *testing.T, path string, before []byte) {
	t.Helper()
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Fatal("existing config file was modified")
	}
}

func requireEffectiveChannel(t *testing.T, effective EffectiveModelConfig, id string) map[string]any {
	t.Helper()
	raw, ok := effective.Config["channels"].([]any)
	if !ok {
		body, _ := json.Marshal(effective.Config["channels"])
		t.Fatalf("channels are not an array: %s", body)
	}
	for _, item := range raw {
		channel, _ := item.(map[string]any)
		if channel["id"] == id {
			return channel
		}
	}
	t.Fatalf("channel %q missing", id)
	return nil
}
