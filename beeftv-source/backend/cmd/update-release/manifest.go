package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	payloadSchema       = 1
	defaultFeedURL      = "https://updates.beefapi.com/beeftv/desktop-update.json"
	defaultDownloadHost = "https://updates.beefapi.com/beeftv"
	updaterImportPath   = "infinite-canvas/backend/internal/desktopupdate"
)

type payload struct {
	Schema    int                      `json:"schema"`
	Version   string                   `json:"version"`
	Commit    string                   `json:"commit"`
	Notes     string                   `json:"notes"`
	Platforms map[string]platformAsset `json:"platforms"`
}

type platformAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

func cmdSign(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("sign", stderr)
	version := fs.String("version", "", "stable version such as v1.6.0")
	commit := fs.String("commit", "", "full Git SHA of the released commit")
	notes := fs.String("notes", "", "release notes text")
	notesFile := fs.String("notes-file", "", "file containing release notes")
	changelog := fs.String("changelog", "", "CHANGELOG.md used when --notes and --notes-file are omitted")
	privatePath := fs.String("private-key", "", "path to the base64 private key file")
	expectPublic := fs.String("expect-public-key", "", "base64 public key that must match the private key")
	output := fs.String("output", "", "output path for desktop-update.json")
	downloadBase := fs.String("download-base", defaultDownloadHost, "prefix for per-version asset URLs")
	requirePlatforms := fs.String("require-platforms", "", "comma-separated platforms that must all be present")
	var assets assetFlags
	fs.Var(&assets, "asset", "platform=path, repeatable (example: darwin-arm64=/tmp/BeefTV-v1.6.0-darwin-arm64.zip)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	parsedVersion, err := parseStableVersion(*version)
	if err != nil {
		return err
	}
	commitSHA, err := parseCommitSHA(*commit)
	if err != nil {
		return err
	}
	noteText, err := resolveNotes(*notes, *notesFile, *changelog, parsedVersion.String())
	if err != nil {
		return err
	}
	private, err := loadPrivateKey(*privatePath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*expectPublic) != "" {
		public, err := parsePublicKey(*expectPublic)
		if err != nil {
			return err
		}
		if !derivedPublicEquals(private, public) {
			return fmt.Errorf("private key does not match --expect-public-key / BEEFTV_UPDATER_PUBLIC_KEY")
		}
	}

	required, err := parsePlatformList(*requirePlatforms)
	if err != nil {
		return err
	}
	built, err := buildPlatformAssets(parsedVersion.String(), strings.TrimRight(*downloadBase, "/"), assets.values)
	if err != nil {
		return err
	}
	for _, platform := range required {
		if _, ok := built[platform]; !ok {
			return fmt.Errorf("signed feed requires platform %s", platform)
		}
	}

	body := payload{
		Schema:    payloadSchema,
		Version:   parsedVersion.String(),
		Commit:    commitSHA,
		Notes:     noteText,
		Platforms: built,
	}
	payloadBytes, err := marshalCanonical(body)
	if err != nil {
		return err
	}
	env := envelope{
		Payload:   base64.StdEncoding.EncodeToString(payloadBytes),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, payloadBytes)),
	}
	outBytes, err := marshalCanonical(env)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*output) == "" {
		return fmt.Errorf("sign requires --output")
	}
	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(*output, append(outBytes, '\n'), 0o644); err != nil {
		return err
	}
	sum, size, err := fileSHA256AndSize(*output)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "path=%s\nsha256=%s\nsize=%d\nplatforms=%d\n", *output, sum, size, len(built))
	return nil
}

func cmdVerify(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("verify", stderr)
	envelopePath := fs.String("envelope", "", "path to desktop-update.json")
	publicPath := fs.String("public-key", "", "path to the base64 public key file")
	publicInline := fs.String("public-key-text", "", "base64 public key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*envelopePath) == "" {
		return fmt.Errorf("verify requires --envelope")
	}
	public, err := loadPublicKey(*publicPath, *publicInline)
	if err != nil {
		return err
	}
	body, err := verifyEnvelopeFile(*envelopePath, public)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "version=%s\ncommit=%s\nplatforms=%d\n", body.Version, body.Commit, len(body.Platforms))
	return nil
}

func cmdPrintLdflags(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("print-ldflags", stderr)
	publicInline := fs.String("public-key", "", "base64 32-byte public key")
	feedURL := fs.String("feed-url", defaultFeedURL, "HTTPS updater feed URL baked into release binaries")
	if err := fs.Parse(args); err != nil {
		return err
	}
	publicText := strings.TrimSpace(*publicInline)
	if publicText == "" {
		publicText = strings.TrimSpace(os.Getenv(publicKeyEnv))
	}
	if _, err := parsePublicKey(publicText); err != nil {
		return fmt.Errorf("print-ldflags: %w; unsigned desktop builds cannot publish an updater feed", err)
	}
	feed := strings.TrimSpace(*feedURL)
	if envFeed := strings.TrimSpace(os.Getenv("BEEFTV_UPDATER_FEED_URL")); envFeed != "" && feed == defaultFeedURL {
		feed = envFeed
	}
	if !strings.HasPrefix(feed, "https://") {
		return fmt.Errorf("feed URL must be HTTPS")
	}
	fmt.Fprintln(stdout, formatLdflags(feed, publicText))
	return nil
}

func formatLdflags(feedURL, publicKey string) string {
	return fmt.Sprintf("-X %s.FeedURL=%s -X %s.PublicKey=%s", updaterImportPath, feedURL, updaterImportPath, publicKey)
}

func verifyEnvelopeFile(path string, public ed25519.PublicKey) (payload, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return payload{}, err
	}
	return verifyEnvelope(data, public)
}

func verifyEnvelope(data []byte, public ed25519.PublicKey) (payload, error) {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return payload{}, fmt.Errorf("envelope JSON: %w", err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(env.Payload))
	if err != nil {
		return payload{}, fmt.Errorf("envelope payload is not base64")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(env.Signature))
	if err != nil {
		return payload{}, fmt.Errorf("envelope signature is not base64")
	}
	if !ed25519.Verify(public, payloadBytes, signature) {
		return payload{}, fmt.Errorf("updater signature verification failed")
	}
	var body payload
	if err := json.Unmarshal(payloadBytes, &body); err != nil {
		return payload{}, fmt.Errorf("payload JSON: %w", err)
	}
	if body.Schema != payloadSchema {
		return payload{}, fmt.Errorf("unsupported updater payload schema %d", body.Schema)
	}
	if _, err := parseStableVersion(body.Version); err != nil {
		return payload{}, err
	}
	if _, err := parseCommitSHA(body.Commit); err != nil {
		return payload{}, err
	}
	if strings.TrimSpace(body.Notes) == "" {
		return payload{}, fmt.Errorf("payload notes are empty")
	}
	if len(body.Platforms) == 0 {
		return payload{}, fmt.Errorf("payload has no platforms")
	}
	for platform, asset := range body.Platforms {
		if err := validatePlatform(platform); err != nil {
			return payload{}, err
		}
		if !strings.HasPrefix(asset.URL, "https://") {
			return payload{}, fmt.Errorf("platform %s url must be HTTPS", platform)
		}
		if len(asset.SHA256) != 64 {
			return payload{}, fmt.Errorf("platform %s sha256 must be 64 hex characters", platform)
		}
		if asset.Size <= 0 {
			return payload{}, fmt.Errorf("platform %s size must be positive", platform)
		}
	}
	return body, nil
}

func resolveNotes(inline, notesFile, changelog, version string) (string, error) {
	switch {
	case strings.TrimSpace(inline) != "":
		return strings.TrimSpace(inline), nil
	case strings.TrimSpace(notesFile) != "":
		data, err := os.ReadFile(notesFile)
		if err != nil {
			return "", fmt.Errorf("read notes file: %w", err)
		}
		notes := strings.TrimSpace(string(data))
		if notes == "" {
			return "", fmt.Errorf("notes file is empty")
		}
		return notes, nil
	case strings.TrimSpace(changelog) != "":
		return extractChangelogNotes(changelog, version)
	default:
		return "", fmt.Errorf("sign requires --notes, --notes-file, or --changelog")
	}
}

func buildPlatformAssets(version, downloadBase string, assets map[string]string) (map[string]platformAsset, error) {
	if len(assets) == 0 {
		return nil, fmt.Errorf("sign requires at least one --asset platform=path")
	}
	if !strings.HasPrefix(downloadBase, "https://") {
		return nil, fmt.Errorf("download base must be HTTPS")
	}
	built := make(map[string]platformAsset, len(assets))
	for platform, path := range assets {
		if err := validatePlatform(platform); err != nil {
			return nil, err
		}
		if _, exists := built[platform]; exists {
			return nil, fmt.Errorf("duplicate --asset for %s", platform)
		}
		if err := validateArchive(platform, path); err != nil {
			return nil, fmt.Errorf("%s: %w", platform, err)
		}
		sum, size, err := fileSHA256AndSize(path)
		if err != nil {
			return nil, err
		}
		name := artifactFileName(version, platform)
		if filepath.Base(path) != name {
			return nil, fmt.Errorf("%s artifact must be named %s", platform, name)
		}
		built[platform] = platformAsset{
			URL:    downloadBase + "/" + version + "/" + name,
			SHA256: sum,
			Size:   size,
		}
	}
	return built, nil
}

func parsePlatformList(text string) ([]string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	parts := strings.Split(text, ",")
	out := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		platform := strings.TrimSpace(part)
		if platform == "" {
			continue
		}
		if err := validatePlatform(platform); err != nil {
			return nil, err
		}
		if _, ok := seen[platform]; ok {
			return nil, fmt.Errorf("duplicate required platform %s", platform)
		}
		seen[platform] = struct{}{}
		out = append(out, platform)
	}
	return out, nil
}

func marshalCanonical(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

type assetFlags struct {
	values map[string]string
}

func (a *assetFlags) String() string {
	if a == nil || len(a.values) == 0 {
		return ""
	}
	parts := make([]string, 0, len(a.values))
	for platform, path := range a.values {
		parts = append(parts, platform+"="+path)
	}
	return strings.Join(parts, ",")
}

func (a *assetFlags) Set(value string) error {
	platform, path, ok := strings.Cut(value, "=")
	if !ok || strings.TrimSpace(platform) == "" || strings.TrimSpace(path) == "" {
		return fmt.Errorf("--asset must be platform=path")
	}
	if a.values == nil {
		a.values = map[string]string{}
	}
	platform = strings.TrimSpace(platform)
	if _, exists := a.values[platform]; exists {
		return fmt.Errorf("duplicate --asset for %s", platform)
	}
	a.values[platform] = strings.TrimSpace(path)
	return nil
}
