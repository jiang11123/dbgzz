package legacyimport

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestImporterSuccessIdempotencyAndRollback(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "legacy.db")
	destination := filepath.Join(dir, "workspace.db")
	original := []byte("legacy-database")
	if err := os.WriteFile(source, original, 0o600); err != nil {
		t.Fatal(err)
	}
	importer := Importer{Validate: func(path string) error {
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(body, original) {
			return errors.New("unexpected copy")
		}
		return nil
	}}
	result, err := importer.Import(source, destination)
	if err != nil || !result.Imported {
		t.Fatalf("first import = (%+v, %v)", result, err)
	}
	result, err = importer.Import(source, destination)
	if err != nil || result.Imported {
		t.Fatalf("idempotent import = (%+v, %v)", result, err)
	}

	failedDestination := filepath.Join(dir, "failed.db")
	failing := Importer{Validate: func(string) error { return errors.New("invalid legacy database") }}
	if _, err := failing.Import(source, failedDestination); err == nil {
		t.Fatal("invalid import succeeded")
	}
	if _, err := os.Stat(failedDestination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed destination was published: %v", err)
	}
	got, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("source changed after failed import: %q %v", got, err)
	}
}
