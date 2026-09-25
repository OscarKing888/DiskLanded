package reveal

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCmdLine(t *testing.T) {
	if got := CmdLine(`C:\Users\a b\x.iso`, false); got != `explorer.exe /select,"C:\Users\a b\x.iso"` {
		t.Error(got)
	}
	if got := CmdLine(`C:\Users\a b`, true); got != `explorer.exe "C:\Users\a b"` {
		t.Error(got)
	}
}

// TestExplorerSelectsFile reveals a file through Path and asks every open
// Explorer window, through the Shell.Application COM object, which items are
// selected. Opt in with DISKLANDED_GUI=1; needs an interactive desktop.
func TestExplorerSelectsFile(t *testing.T) {
	if os.Getenv("DISKLANDED_GUI") == "" {
		t.Skip("set DISKLANDED_GUI=1")
	}
	name := fmt.Sprintf("reveal-me-%d.bin", time.Now().UnixNano())
	f := filepath.Join(t.TempDir(), name)
	os.WriteFile(f, []byte("x"), 0o644)
	if err := Path(f); err != nil {
		t.Fatal(err)
	}
	const ps = `$sh = New-Object -ComObject Shell.Application
foreach ($w in $sh.Windows()) { try { foreach ($i in $w.Document.SelectedItems()) { $i.Path } } catch {} }`
	var last string
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		out, _ := exec.Command("powershell", "-NoProfile", "-Command", ps).CombinedOutput()
		last = string(out)
		if strings.Contains(strings.ToLower(last), strings.ToLower(name)) {
			t.Logf("Explorer selection: %s", strings.TrimSpace(last))
			return
		}
	}
	t.Fatalf("Explorer did not select %s; selections: %q", name, last)
}
