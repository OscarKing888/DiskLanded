package main

import (
	_ "embed"
	"strings"
)

// VERSION at the repository root is the single source of the app version.
// Release tags are "v" + this value (e.g. v0.1); CI checks they match.
//
//go:embed VERSION
var versionFile string

var appVersion = strings.TrimSpace(versionFile)
