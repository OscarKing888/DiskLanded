package trash

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRejectUnsafeTargets(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(file, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", "relative.txt", file + "\x00extra", filepath.Join(dir, "missing"), dir} {
		if err := Path(path); err == nil {
			t.Fatalf("accepted invalid target %q", path)
		}
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("invalid requests affected the file:", err)
	}
}

func TestRejectSymlink(t *testing.T) {
	dir := t.TempDir()
	file, link := filepath.Join(dir, "original.txt"), filepath.Join(dir, "link.txt")
	if err := os.WriteFile(file, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(file, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := Path(link); err == nil {
		t.Fatal("accepted symlink")
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatal("symlink changed:", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("symlink target changed:", err)
	}
}
