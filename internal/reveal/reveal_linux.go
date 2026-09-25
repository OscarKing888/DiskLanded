package reveal

import (
	"os/exec"
	"path/filepath"
)

// command opens the directory itself, or the directory that contains the
// file. xdg-open only ever receives a directory, so it cannot launch an
// application for the file.
func command(path string, isDir bool) *exec.Cmd {
	return exec.Command("xdg-open", Target(path, isDir))
}

// Target is the directory handed to xdg-open.
func Target(path string, isDir bool) string {
	if isDir {
		return path
	}
	return filepath.Dir(path)
}
