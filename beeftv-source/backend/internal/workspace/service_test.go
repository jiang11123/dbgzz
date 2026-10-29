package workspace

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestProviderConfigIsAtomicPrivateAndPreservesRedactedSecrets(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	initial := []byte(`{"channels":[{"id":"direct","name":"Direct","apiKey":"secret-key"}]}`)
	if err := store.SaveLocalModelConfig(initial); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(dir, LocalProviderConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("provider config mode = %o, want 600", got)
	}

	redacted, err := store.ReadRedactedModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(redacted, []byte("secret-key")) || !bytes.Contains(redacted, []byte(RedactedSecret)) {
		t.Fatal("redacted config leaks or drops secret marker")
	}
	var view map[string]any
	if err := json.Unmarshal(redacted, &view); err != nil {
		t.Fatal(err)
	}
	view["label"] = "updated"
	updated, _ := json.Marshal(view)
	if err := store.SaveLocalModelConfig(updated); err != nil {
		t.Fatal(err)
	}
	raw, err := store.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("secret-key")) || !bytes.Contains(raw, []byte("updated")) {
		t.Fatal("secret-preserving update failed")
	}

	if err := store.SaveLocalModelConfig([]byte(`{"channels":`)); err == nil {
		t.Fatal("invalid JSON was accepted")
	}
	afterInvalid, err := store.ReadLocalModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, afterInvalid) {
		t.Fatal("invalid update changed the last valid provider config")
	}
}

func TestProviderConfigRejectsMissingDataDirectory(t *testing.T) {
	if _, err := NewProviderConfig(""); err == nil {
		t.Fatal("empty data directory was accepted")
	}
}
