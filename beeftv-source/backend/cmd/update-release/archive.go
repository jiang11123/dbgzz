package main

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	platformDarwinARM64  = "darwin-arm64"
	platformDarwinAMD64  = "darwin-amd64"
	platformWindowsAMD64 = "windows-amd64"
	platformLinuxAMD64   = "linux-amd64"
	linuxBundleName      = "BeefTV-linux"
	macExecutableRel     = "Contents/MacOS/BeefTV"
	windowsExecutable    = "BeefTV.exe"
	pluginDirName        = "plugin-packages"
	pluginSuffix         = ".beeftv-plugin"
)

func cmdPackage(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("package", stderr)
	platform := fs.String("platform", "", "darwin-arm64, darwin-amd64, windows-amd64, or linux-amd64")
	input := fs.String("input", "", "BeefTV.app, BeefTV-linux, or a Windows bin directory with BeefTV.exe")
	output := fs.String("output", "", "output zip path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := packageBundle(*platform, *input, *output); err != nil {
		return err
	}
	sum, size, err := fileSHA256AndSize(*output)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "path=%s\nsha256=%s\nsize=%d\n", *output, sum, size)
	return nil
}

func packageBundle(platform, input, output string) error {
	if err := validatePlatform(platform); err != nil {
		return err
	}
	if strings.TrimSpace(input) == "" {
		return fmt.Errorf("package requires --input")
	}
	if strings.TrimSpace(output) == "" {
		return fmt.Errorf("package requires --output")
	}
	root, err := resolveBundleRoot(platform, input)
	if err != nil {
		return err
	}
	if err := rejectUserDataDir(root); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(output), ".beeftv-update-*.zip")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	zw := zip.NewWriter(tmp)
	visited := map[string]struct{}{}
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64:
		if err := addTree(zw, root, root, filepath.Base(root), visited); err != nil {
			_ = zw.Close()
			return err
		}
	case platformLinuxAMD64:
		if err := addTree(zw, root, root, linuxBundleName, visited); err != nil {
			_ = zw.Close()
			return err
		}
	case platformWindowsAMD64:
		if err := addWindowsLayout(zw, root, visited); err != nil {
			_ = zw.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := validateArchive(platform, tmpName); err != nil {
		return err
	}
	if err := os.Rename(tmpName, output); err != nil {
		return err
	}
	return nil
}

func resolveBundleRoot(platform, input string) (string, error) {
	abs, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return "", fmt.Errorf("package input: %w", err)
	}
	switch platform {
	case platformLinuxAMD64:
		if info.IsDir() && info.Mode()&os.ModeSymlink == 0 && filepath.Base(abs) == linuxBundleName {
			return abs, nil
		}
		return "", fmt.Errorf("Linux package input must be a real %s directory", linuxBundleName)
	case platformDarwinARM64, platformDarwinAMD64:
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("package input must be a real directory, not a symlink")
		}
		if info.IsDir() && filepath.Base(abs) == "BeefTV.app" {
			return abs, nil
		}
		candidate := filepath.Join(abs, "BeefTV.app")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate, nil
		}
		return "", fmt.Errorf("macOS package input must be BeefTV.app or a directory containing BeefTV.app")
	case platformWindowsAMD64:
		if info.Mode().IsRegular() && strings.EqualFold(filepath.Base(abs), windowsExecutable) {
			return filepath.Dir(abs), nil
		}
		if info.IsDir() {
			exe := filepath.Join(abs, windowsExecutable)
			if st, err := os.Stat(exe); err == nil && st.Mode().IsRegular() {
				return abs, nil
			}
		}
		return "", fmt.Errorf("Windows package input must contain BeefTV.exe")
	default:
		return "", fmt.Errorf("unsupported platform %q", platform)
	}
}

func addWindowsLayout(zw *zip.Writer, root string, visited map[string]struct{}) error {
	exe := filepath.Join(root, windowsExecutable)
	if err := addTree(zw, root, exe, windowsExecutable, visited); err != nil {
		return err
	}
	pluginDir := filepath.Join(root, pluginDirName)
	st, err := os.Stat(pluginDir)
	if err != nil {
		return fmt.Errorf("Windows bundle missing %s: %w", pluginDirName, err)
	}
	if !st.IsDir() {
		return fmt.Errorf("Windows bundle %s is not a directory", pluginDirName)
	}
	if err := addTree(zw, root, pluginDir, pluginDirName, visited); err != nil {
		return err
	}
	if err := addTree(zw, root, filepath.Join(root, "cli"), "cli", visited); err != nil {
		return err
	}
	if err := addTree(zw, root, filepath.Join(root, "agent-host"), "agent-host", visited); err != nil {
		return err
	}
	media := filepath.Join(root, "media-runtime")
	if _, err := os.Lstat(media); os.IsNotExist(err) {
		return nil // Historical bundles did not carry a media runtime.
	} else if err != nil {
		return err
	}
	return addTree(zw, root, media, "media-runtime", visited)
}

func addTree(zw *zip.Writer, bundleParent, absPath, zipName string, visited map[string]struct{}) error {
	absPath = filepath.Clean(absPath)
	resolved, info, err := lstatDeref(bundleParent, absPath)
	if err != nil {
		return err
	}
	if isExcludedName(absPath) {
		return nil
	}
	zipName = path.Clean(filepath.ToSlash(zipName))
	if err := rejectUnsafeZipName(zipName); err != nil {
		return err
	}

	if info.IsDir() {
		if _, seen := visited[resolved]; seen {
			return nil
		}
		visited[resolved] = struct{}{}
		if !strings.HasSuffix(zipName, "/") {
			if err := addDirectoryEntry(zw, zipName, info.Mode()); err != nil {
				return err
			}
		}
		entries, err := os.ReadDir(resolved)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childAbs := filepath.Join(absPath, entry.Name())
			childZip := path.Join(zipName, entry.Name())
			if err := addTree(zw, bundleParent, childAbs, childZip, visited); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsupported file type for %s", absPath)
	}
	return addRegularFile(zw, resolved, zipName, info.Mode())
}

func lstatDeref(jailRoot, absPath string) (string, os.FileInfo, error) {
	info, err := os.Lstat(absPath)
	if err != nil {
		return "", nil, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		resolved, err := filepath.Abs(absPath)
		if err != nil {
			return "", nil, err
		}
		return resolved, info, nil
	}
	target, err := os.Readlink(absPath)
	if err != nil {
		return "", nil, err
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(absPath), target)
	}
	target = filepath.Clean(target)
	if err := withinRoot(filepath.Clean(jailRoot), target); err != nil {
		return "", nil, fmt.Errorf("refusing symlink %s: %w", absPath, err)
	}
	info, err = os.Stat(absPath)
	if err != nil {
		return "", nil, fmt.Errorf("dereference symlink %s: %w", absPath, err)
	}
	resolved, err := filepath.Abs(target)
	if err != nil {
		return "", nil, err
	}
	return resolved, info, nil
}

func addDirectoryEntry(zw *zip.Writer, name string, mode os.FileMode) error {
	if !strings.HasSuffix(name, "/") {
		name += "/"
	}
	header := &zip.FileHeader{
		Name:   name,
		Method: zip.Store,
	}
	header.SetMode(mode | os.ModeDir)
	_, err := zw.CreateHeader(header)
	return err
}

func addRegularFile(zw *zip.Writer, absPath, zipName string, mode os.FileMode) error {
	file, err := os.Open(absPath)
	if err != nil {
		return err
	}
	defer file.Close()
	header := &zip.FileHeader{
		Name:   zipName,
		Method: zip.Deflate,
	}
	header.SetMode(mode &^ os.ModeSymlink)
	writer, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(writer, file)
	return err
}

func validateArchive(platform, zipPath string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open packaged zip: %w", err)
	}
	defer reader.Close()
	if len(reader.File) == 0 {
		return fmt.Errorf("packaged zip is empty")
	}
	hasMacExec := false
	hasWinExec := false
	hasLinuxExec := false
	hasCLI := false
	requiredMedia := map[string]map[string]bool{}
	cliPath := "cli/beeftv.exe"
	if strings.HasPrefix(platform, "darwin-") {
		cliPath = "BeefTV.app/Contents/MacOS/cli/beeftv"
	}
	if platform == platformLinuxAMD64 {
		cliPath = linuxBundleName + "/cli/beeftv"
	}
	pluginCount := 0
	agentPrefix := "agent-host/"
	nodeRelative := "runtime/node.exe"
	if strings.HasPrefix(platform, "darwin-") {
		agentPrefix = "BeefTV.app/Contents/Resources/agent-host/"
		nodeRelative = "runtime/bin/node"
	}
	if platform == platformLinuxAMD64 {
		agentPrefix = linuxBundleName + "/agent-host/"
		nodeRelative = "runtime/bin/node"
	}
	requiredAgent := map[string]bool{"server.mjs": false, "session-identity.mjs": false, "package.json": false, nodeRelative: false, "node_modules/@earendil-works/pi-coding-agent/package.json": false}
	for _, file := range reader.File {
		name := filepath.ToSlash(file.Name)
		if platform == platformWindowsAMD64 {
			for _, prefix := range []string{"agent-host/media-runtime/", "media-runtime/"} {
				if rel, found := strings.CutPrefix(name, prefix); found {
					if requiredMedia[prefix] == nil {
						requiredMedia[prefix] = map[string]bool{"ffmpeg.exe": false, "LICENSE": false, "README.txt": false, "manifest.json": false}
					}
					if _, required := requiredMedia[prefix][rel]; required && file.Mode().IsRegular() && file.UncompressedSize64 > 0 {
						requiredMedia[prefix][rel] = true
					}
				}
			}
		}
		if name == cliPath {
			if !file.Mode().IsRegular() || file.UncompressedSize64 == 0 {
				return fmt.Errorf("bundled CLI must be a nonempty regular file: %s", cliPath)
			}
			if platform != platformWindowsAMD64 && file.Mode()&0o111 == 0 {
				return fmt.Errorf("bundled CLI must retain executable mode: %s", cliPath)
			}
			hasCLI = true
		}
		if rel, ok := strings.CutPrefix(name, agentPrefix); ok {
			if _, required := requiredAgent[rel]; required && file.Mode().IsRegular() && file.UncompressedSize64 > 0 {
				requiredAgent[rel] = true
				if rel == nodeRelative && platform != platformWindowsAMD64 && file.Mode()&0o111 == 0 {
					return fmt.Errorf("bundled Node must retain executable mode")
				}
			}
		}
		if err := rejectUnsafeZipName(strings.TrimSuffix(name, "/")); err != nil {
			return err
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("zip entry %s is a symlink; updater archives must materialize file contents", name)
		}
		base := path.Base(strings.TrimSuffix(name, "/"))
		if isExcludedName(base) {
			return fmt.Errorf("zip entry %s looks like secret or user data and cannot ship in an updater archive", name)
		}
		if strings.Contains(name, "open_ai_canvas.db") {
			return fmt.Errorf("zip entry %s is user database data and cannot ship in an updater archive", name)
		}
		switch {
		case name == linuxBundleName+"/BeefTV":
			hasLinuxExec = file.Mode().IsRegular() && file.UncompressedSize64 > 0 && file.Mode()&0o111 != 0
		case strings.HasPrefix(name, linuxBundleName+"/"+pluginDirName+"/") && strings.HasSuffix(name, pluginSuffix) && file.Mode().IsRegular():
			pluginCount++
		case name == "BeefTV.app/"+macExecutableRel || name == "BeefTV.app/"+macExecutableRel+"/":
			hasMacExec = true
			if file.Mode()&0o111 == 0 {
				return fmt.Errorf("BeefTV.app/%s must retain executable mode", macExecutableRel)
			}
		case name == windowsExecutable:
			hasWinExec = true
		case strings.HasPrefix(name, pluginDirName+"/") && strings.HasSuffix(name, pluginSuffix) && file.Mode().IsRegular():
			pluginCount++
		case strings.HasPrefix(name, "BeefTV.app/Contents/Resources/"+pluginDirName+"/") && strings.HasSuffix(name, pluginSuffix) && file.Mode().IsRegular():
			pluginCount++
		}
	}
	if !hasCLI {
		return fmt.Errorf("archive missing bundled CLI: %s", cliPath)
	}
	for prefix, resources := range requiredMedia {
		for name, found := range resources {
			if !found {
				return fmt.Errorf("archive missing media-runtime resource: %s%s", prefix, name)
			}
		}
	}
	for name, found := range requiredAgent {
		if !found {
			return fmt.Errorf("archive missing agent-host resource: %s%s", agentPrefix, name)
		}
	}
	switch platform {
	case platformLinuxAMD64:
		if !hasLinuxExec || hasWinExec || hasMacExec || pluginCount == 0 {
			return fmt.Errorf("Linux archive must contain executable %s/BeefTV and official plugins only for Linux", linuxBundleName)
		}
		for _, file := range reader.File {
			if file.Name != linuxBundleName+"/" && !strings.HasPrefix(file.Name, linuxBundleName+"/") {
				return fmt.Errorf("Linux archive contains files outside %s", linuxBundleName)
			}
		}
	case platformDarwinARM64, platformDarwinAMD64:
		if hasWinExec {
			return fmt.Errorf("macOS archive must not contain %s", windowsExecutable)
		}
		if !hasMacExec {
			return fmt.Errorf("macOS archive must contain BeefTV.app/%s", macExecutableRel)
		}
		if pluginCount == 0 {
			return fmt.Errorf("macOS archive must contain Contents/Resources/%s/*%s", pluginDirName, pluginSuffix)
		}
	case platformWindowsAMD64:
		if hasMacExec {
			return fmt.Errorf("Windows archive must not contain BeefTV.app")
		}
		if !hasWinExec {
			return fmt.Errorf("Windows archive must contain %s at the zip root", windowsExecutable)
		}
		if pluginCount == 0 {
			return fmt.Errorf("Windows archive must contain %s/*%s", pluginDirName, pluginSuffix)
		}
	}
	return nil
}

func rejectUnsafeZipName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || name == "." {
		return fmt.Errorf("zip entry name is empty")
	}
	if strings.Contains(name, "\\") {
		return fmt.Errorf("zip entry %q uses backslashes", name)
	}
	if path.IsAbs(name) || strings.HasPrefix(name, "/") {
		return fmt.Errorf("zip entry %q is absolute", name)
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return fmt.Errorf("zip entry %q contains ..", name)
		}
	}
	return nil
}

func rejectUserDataDir(root string) error {
	markers := []string{"open_ai_canvas.db", ".settings-key", "local-model-config.json"}
	for _, marker := range markers {
		if _, err := os.Stat(filepath.Join(root, marker)); err == nil {
			return fmt.Errorf("refusing to package user data directory %s", root)
		}
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	slash := filepath.ToSlash(abs)
	if strings.Contains(slash, "/Application Support/BeefTV") && !strings.Contains(slash, "BeefTV.app") {
		return fmt.Errorf("refusing to package the macOS user data directory")
	}
	if runtime.GOOS == "windows" && strings.Contains(strings.ToLower(slash), "/appdata/roaming/beeftv") {
		return fmt.Errorf("refusing to package the Windows user data directory")
	}
	return nil
}

func withinRoot(root, candidate string) error {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("path escapes package root")
	}
	return nil
}

func isExcludedName(pathName string) bool {
	base := filepath.Base(pathName)
	switch {
	case base == ".env" || strings.HasPrefix(base, ".env."):
		return true
	case base == ".settings-key" || base == "beefapi-connection.json":
		return true
	case base == ".DS_Store" || base == "Thumbs.db" || strings.HasPrefix(base, "._"):
		return true
	case base == ".git":
		return true
	case strings.HasSuffix(base, ".db") || strings.HasSuffix(base, ".sqlite") || strings.HasSuffix(base, ".sqlite3"):
		return true
	case strings.HasSuffix(base, ".db-wal") || strings.HasSuffix(base, ".db-shm"):
		return true
	default:
		return false
	}
}

func validatePlatform(platform string) error {
	switch platform {
	case platformDarwinARM64, platformDarwinAMD64, platformWindowsAMD64, platformLinuxAMD64:
		return nil
	case "":
		return fmt.Errorf("platform is required")
	default:
		return fmt.Errorf("unsupported platform %q (want darwin-arm64, darwin-amd64, windows-amd64, or linux-amd64)", platform)
	}
}

func fileSHA256AndSize(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if info.Size() <= 0 {
		return "", 0, fmt.Errorf("%s is empty", path)
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", 0, err
	}
	return fmt.Sprintf("%x", sum.Sum(nil)), info.Size(), nil
}

func artifactFileName(version, platform string) string {
	return fmt.Sprintf("BeefTV-%s-%s.zip", version, platform)
}
