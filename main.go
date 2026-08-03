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
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
