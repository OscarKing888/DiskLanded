package trash

import (
	"fmt"
	"os/exec"
	"strings"
)

func move(path string) (string, error) {
	// gio uses the desktop trash service and fails when trashing is unavailable.
	out, err := exec.Command("gio", "trash", "--", path).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("gio trash：%w %s", err, strings.TrimSpace(string(out)))
	}
	return "", nil
}
