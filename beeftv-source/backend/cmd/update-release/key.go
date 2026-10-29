package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	privateKeyEnv = "BEEFTV_UPDATER_PRIVATE_KEY"
	publicKeyEnv  = "BEEFTV_UPDATER_PUBLIC_KEY"
)

func cmdGenKey(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("gen-key", stderr)
	privatePath := fs.String("private-key", "", "output path for the base64 64-byte private key (required, mode 0600)")
	publicPath := fs.String("public-key", "", "output path for the base64 32-byte public key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*privatePath) == "" {
		return fmt.Errorf("gen-key requires --private-key <path>; refusing to write a private key to the terminal")
	}
	if _, err := os.Stat(*privatePath); err == nil {
		return fmt.Errorf("refusing to overwrite existing private key file %s", *privatePath)
	} else if !os.IsNotExist(err) {
		return err
	}
	if *publicPath != "" {
		if _, err := os.Stat(*publicPath); err == nil {
			return fmt.Errorf("refusing to overwrite existing public key file %s", *publicPath)
		} else if !os.IsNotExist(err) {
			return err
		}
	}

	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate ed25519 key: %w", err)
	}
	if err := writeKeyFile(*privatePath, encodeKey(private), 0o600); err != nil {
		return err
	}
	publicText := encodeKey(public)
	if *publicPath != "" {
		if err := writeKeyFile(*publicPath, publicText, 0o644); err != nil {
			return err
		}
	}
	fmt.Fprintf(stdout, "public_key=%s\n", publicText)
	if *publicPath != "" {
		fmt.Fprintf(stdout, "public_key_file=%s\n", *publicPath)
	}
	fmt.Fprintf(stdout, "private_key_file=%s\n", *privatePath)
	return nil
}

func cmdPublicKey(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("public-key", stderr)
	privatePath := fs.String("private-key", "", "path to the base64 private key file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	private, err := loadPrivateKey(*privatePath)
	if err != nil {
		return err
	}
	fmt.Fprintln(stdout, encodeKey(private.Public().(ed25519.PublicKey)))
	return nil
}

func writeKeyFile(path, contents string, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.WriteString(contents + "\n"); err != nil {
		return err
	}
	if err := file.Chmod(mode); err != nil {
		return err
	}
	return file.Sync()
}

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	raw, err := readKeyMaterial("private key", path, privateKeyEnv)
	if err != nil {
		return nil, err
	}
	return parsePrivateKey(raw)
}

func loadPublicKey(path, inline string) (ed25519.PublicKey, error) {
	if strings.TrimSpace(inline) != "" {
		return parsePublicKey(strings.TrimSpace(inline))
	}
	raw, err := readKeyMaterial("public key", path, publicKeyEnv)
	if err != nil {
		return nil, err
	}
	return parsePublicKey(raw)
}

func readKeyMaterial(label, path, envName string) (string, error) {
	if strings.TrimSpace(path) != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read %s file: %w", label, err)
		}
		return string(data), nil
	}
	value := strings.TrimSpace(os.Getenv(envName))
	if value == "" {
		return "", fmt.Errorf("%s is required via --private-key/--public-key or %s", label, envName)
	}
	return value, nil
}

func parsePrivateKey(text string) (ed25519.PrivateKey, error) {
	raw, err := decodeKey("private key", text)
	if err != nil {
		return nil, err
	}
	switch len(raw) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(raw), nil
	case ed25519.PrivateKeySize:
		seed := raw[:ed25519.SeedSize]
		derived := ed25519.NewKeyFromSeed(seed)
		if !ed25519.PrivateKey(raw).Equal(derived) {
			return nil, fmt.Errorf("private key public half does not match its seed")
		}
		return derived, nil
	default:
		return nil, fmt.Errorf("private key must decode to 32-byte seed or 64-byte Ed25519 private key")
	}
}

func parsePublicKey(text string) (ed25519.PublicKey, error) {
	raw, err := decodeKey("public key", text)
	if err != nil {
		return nil, err
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key must decode to 32 raw Ed25519 bytes")
	}
	return ed25519.PublicKey(raw), nil
}

func decodeKey(label, text string) ([]byte, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("%s is empty", label)
	}
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(text)
	}
	if err != nil {
		return nil, fmt.Errorf("%s must be standard base64 of raw Ed25519 key bytes", label)
	}
	return raw, nil
}

func encodeKey(raw []byte) string {
	return base64.StdEncoding.EncodeToString(raw)
}

func derivedPublicEquals(private ed25519.PrivateKey, public ed25519.PublicKey) bool {
	return private.Public().(ed25519.PublicKey).Equal(public)
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}
