package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"infinite-canvas/backend/internal/depthruntime"
)

func cmdDepthManifest(command string, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet(command, stderr)
	input := fs.String("input", "", "manifest path")
	output := fs.String("output", "", "signed manifest output (sign-depth only)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	public, err := loadPublicKey("", "")
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	if command == "sign-depth" {
		private, err := loadPrivateKey("")
		if err != nil {
			return err
		}
		if !derivedPublicEquals(private, public) {
			return fmt.Errorf("depth signing key mismatch")
		}
		raw, err = json.Marshal(envelope{Payload: base64.StdEncoding.EncodeToString(raw), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, raw))})
		if err != nil {
			return err
		}
	}
	manifest, err := depthruntime.VerifyManifest(raw, public)
	if err != nil {
		return err
	}
	for _, variant := range []string{"cpu", "cuda"} {
		artifact, ok := manifest.Runtimes["windows-amd64/"+variant]
		if !ok || artifact.Size <= 0 || artifact.Files <= 0 || artifact.ExpandedSize <= 0 || len(artifact.SHA256) != 64 || (len(artifact.URLs) == 0 && len(artifact.Parts) == 0) {
			return fmt.Errorf("incomplete Windows %s runtime", variant)
		}
	}
	if command == "sign-depth" {
		if err := os.WriteFile(*output, raw, 0o644); err != nil {
			return err
		}
	}
	fmt.Fprintln(stdout, "Verified signed Windows CPU and CUDA depth manifest")
	return nil
}
