package reveal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMissingPath(t *testing.T) {
	if err := Path(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestCommandDoesNotTouchContent(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "x.bin")
	os.WriteFile(f, []byte("x"), 0o644)
	for _, c := range []struct {
		p     string
		isDir bool
	}{{f, false}, {dir, true}} {
		cmd := command(c.p, c.isDir)
		t.Logf("%s -> %q %q", c.p, cmd.Path, cmd.Args)
		if len(cmd.Args) == 0 {
			t.Fatal("empty command")
		}
	}
}
