package reveal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTarget(t *testing.T) {
	if got := Target("/a/b/file.iso", false); got != "/a/b" {
		t.Errorf("file target = %s", got)
	}
	if got := Target("/a/b", true); got != "/a/b" {
		t.Errorf("dir target = %s", got)
	}
}

// TestXdgOpenReceivesDirectory puts a fake xdg-open first on PATH and checks
// the argument it is launched with.
func TestXdgOpenReceivesDirectory(t *testing.T) {
	bin := t.TempDir()
	log := filepath.Join(bin, "args")
	os.WriteFile(filepath.Join(bin, "xdg-open"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > "+log+"\n"), 0o755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	data := t.TempDir()
	f := filepath.Join(data, "movie.mkv")
	os.WriteFile(f, []byte("x"), 0o644)
	if err := Path(f); err != nil {
		t.Fatal(err)
	}
	var got []byte
	for i := 0; i < 50; i++ {
		if got, _ = os.ReadFile(log); len(got) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if strings.TrimSpace(string(got)) != data {
		t.Errorf("xdg-open args = %q, want %q", got, data)
	}
}
