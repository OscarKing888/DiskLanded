package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:     "新占 DiskLanded",
		Width:     1180,
		Height:    820,
		MinWidth:  820,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		Bind:      []interface{}{app},
		Mac: &mac.Options{
			About: &mac.AboutInfo{Title: "新占 DiskLanded", Message: "磁盘空间被谁占着，哪些大文件是新来的。"},
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
