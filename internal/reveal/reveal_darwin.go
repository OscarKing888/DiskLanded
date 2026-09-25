package reveal

import "os/exec"

// command uses `open -R` for files and directories alike: it selects the item
// in Finder. Plain `open` on a directory could launch an .app bundle.
func command(path string, isDir bool) *exec.Cmd {
	return exec.Command("open", "-R", "--", path)
}
