package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:            "BulkAI",
		Width:            1024,
		Height:           768,
		WindowStartState: options.Normal,
		StartHidden:      false, // Luôn hiện cửa sổ ngay khi start
		DisableResize:    false,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewUserDataPath:  `.\webview_data`, // Path riêng, tránh conflict với Grok Chrome
			WebviewGpuIsDisabled: true,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}

