package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// appIcon is hoverdeck's own icon — the same wire/pin visual language as the
// canvas (an "H" drawn as a schematic trace with via and terminal dots) —
// rather than the default Wails logo. Windows picks up build/windows/icon.ico
// automatically at build time; GTK does not do the equivalent for Linux, so
// the PNG is embedded and handed to linux.Options.Icon below.
//
//go:embed build/appicon.png
var appIcon []byte

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "hoverdeck",
		Width:     1440,
		Height:    900,
		MinWidth:  980,
		MinHeight: 620,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// Matches --bg in the stylesheet so the window never flashes light
		// during startup or resize.
		BackgroundColour: &options.RGBA{R: 13, G: 15, B: 20, A: 1},
		OnStartup:        app.startup,
		Windows: &windows.Options{
			Theme: windows.Dark,
		},
		Linux: &linux.Options{
			WindowIsTranslucent: false,
			ProgramName:         "hoverdeck",
			Icon:                appIcon,
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
