package reveal

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestOpenArgs(t *testing.T) {
	if got := command("/x/y.iso", false).Args; !reflect.DeepEqual(got, []string{"open", "-R", "--", "/x/y.iso"}) {
		t.Error(got)
	}
}

// TestFinderSelectsFile reveals a file through Path and asks Finder which
// item is selected. Opt in with DISKLANDED_GUI=1; needs a GUI session and
// Apple Events permission for the test runner.
func TestFinderSelectsFile(t *testing.T) {
	if os.Getenv("DISKLANDED_GUI") == "" {
		t.Skip("set DISKLANDED_GUI=1")
	}
	name := fmt.Sprintf("reveal-me-%d.bin", time.Now().UnixNano())
	f := filepath.Join(t.TempDir(), name)
	os.WriteFile(f, []byte("x"), 0o644)
	if err := Path(f); err != nil {
		t.Fatal(err)
	}
	var last string
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		out, err := exec.Command("osascript", "-e",
			`tell application "Finder" to get POSIX path of (item 1 of (get selection) as alias)`).CombinedOutput()
		last = strings.TrimSpace(string(out))
		if err == nil && filepath.Base(last) == name {
			t.Logf("Finder selection: %s", last)
			return
		}
	}
	t.Fatalf("Finder did not select %s; last answer: %s", name, last)
}
