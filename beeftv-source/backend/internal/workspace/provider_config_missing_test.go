package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProviderConfigMissingPrimaryRecoversEncryptedBackup(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProviderConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"first-secret", "second-secret"} {
		if err := store.SaveLocalModelConfig([]byte(`{"channels":[{"id":"personal","apiKey":"` + secret + `","enabled":true}]}`)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(dir, LocalProviderConfigFile)); err != nil {
		t.Fatal(err)
	}
	effective, health, err := store.LoadEffectiveModelConfig()
	if err != nil {
		t.Fatal(err)
	}
	if health != ConfigHealthRecovered || requireEffectiveChannel(t, effective, "personal")["apiKey"] != "first-secret" {
		t.Fatal("missing primary lost the encrypted backup")
	}
	if err := os.WriteFile(filepath.Join(dir, LocalProviderConfigFile+".bak"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadEffectiveModelConfig(); err == nil {
		t.Fatal("broken backup silently replaced by defaults")
	}
}
