package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/desktopstorage"
	"infinite-canvas/backend/internal/desktopupdate"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

func main() {
	// The updater helper must run before defaultDataDir/runDesktopApp so a
	// replacement never opens the user database or data directory.
	if done, err := desktopupdate.HandleHelperCommand(os.Args); done {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := validateDesktopArgs(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	dataDir, err := defaultDataDir()
	if err != nil {
		log.Fatal(err)
	}
	app := newDesktopApp(dataDir)
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "beeftv:") {
			app.queueSkillLink(arg)
		}
	}
	err = runDesktopApp(app, wails.Run)
	if err != nil {
		log.Fatal(err)
	}
}

func runDesktopApp(app *DesktopApp, run func(*options.App) error) error {
	if err := configureDesktopTemp(app.dataDir); err != nil {
		return err
	}
	// Wails must forward a second launch before the primary instance's workspace
	// lock is acquired. Only OnStartup (or its asset-server fallback) opens it.
	return run(desktopAppOptions(app))
}

func desktopAppOptions(app *DesktopApp) *options.App {
	return &options.App{
		Title:            "BeefTV",
		Width:            1440,
		Height:           960,
		BackgroundColour: &options.RGBA{R: 13, G: 15, B: 18, A: 255},
		Mac: &mac.Options{
			OnUrlOpen: app.queueSkillLink,
			// WKWebView disables element fullscreen by default, including the
			// video player's fullscreen control.
			Preferences: &mac.Preferences{FullscreenEnabled: mac.Enabled},
		},
		Windows: &windows.Options{
			Theme: windows.Dark,
			CustomTheme: &windows.ThemeSettings{
				DarkModeTitleBar:          windows.RGB(13, 15, 18),
				DarkModeTitleBarInactive:  windows.RGB(13, 15, 18),
				DarkModeTitleText:         windows.RGB(244, 244, 245),
				DarkModeTitleTextInactive: windows.RGB(161, 161, 170),
				DarkModeBorder:            windows.RGB(39, 39, 42),
				DarkModeBorderInactive:    windows.RGB(39, 39, 42),
			},
		},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: desktopAssetHandler{app: app},
		},
		OnStartup: app.startup,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: skillInstanceID(app.dataDir),
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				for _, arg := range data.Args {
					if strings.HasPrefix(arg, "beeftv:") {
						app.queueSkillLink(arg)
					}
				}
			},
		},
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	}
}

func prepareDesktopApp(app *DesktopApp) error {
	startupErrorPath := filepath.Join(app.dataDir, "startup-error.log")
	if err := app.start(context.Background()); err != nil {
		_ = os.MkdirAll(app.dataDir, 0o755)
		_ = os.WriteFile(startupErrorPath, []byte(err.Error()+"\n"), 0o600)
		return err
	}
	_ = os.Remove(startupErrorPath)
	return nil
}

func defaultDataDir() (string, error) {
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "--data-dir=") {
			dir := strings.TrimSpace(strings.TrimPrefix(arg, "--data-dir="))
			clean := filepath.Clean(dir)
			if !filepath.IsAbs(dir) || filepath.Dir(clean) == clean {
				return "", fmt.Errorf("--data-dir 需要明确的绝对目录")
			}
			return clean, nil
		}
	}
	if override := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_DATA_DIR")); override != "" {
		return override, nil
	}
	root, err := desktopstorage.DefaultRoot()
	if err != nil {
		return "", fmt.Errorf("定位用户应用数据目录: %w", err)
	}
	return desktopstorage.Resolve(root)
}

func configureDesktopTemp(dataDir string) error {
	path := filepath.Join(dataDir, "cache", "tmp")
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	for _, name := range []string{"TMPDIR", "TEMP", "TMP"} {
		if err := os.Setenv(name, path); err != nil {
			return err
		}
	}
	return nil
}
