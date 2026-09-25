package reveal

import (
	"os/exec"
	"syscall"
)

// command runs `explorer /select,"path"` for files and `explorer "path"` for
// directories. Explorer parses its own command line, so it is passed raw.
func command(path string, isDir bool) *exec.Cmd {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: CmdLine(path, isDir)}
	return cmd
}

// CmdLine is the full explorer command line.
func CmdLine(path string, isDir bool) string {
	if isDir {
		return `explorer.exe "` + path + `"`
	}
	return `explorer.exe /select,"` + path + `"`
}
