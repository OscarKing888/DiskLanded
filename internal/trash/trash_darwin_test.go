package trash

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSystemTrashPreservesFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "回收测试 'quoted' & space.txt")
	content := []byte("temporary trash integration test\n")
	if err := os.WriteFile(file, content, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	destination, err := move(file)
	if err != nil {
		t.Fatal(err)
	}
	if destination == "" {
		t.Fatal("system did not return the trash location")
	}
	defer func() {
		if err := os.Rename(destination, file); err != nil {
			t.Errorf("restore temporary test file: %v", err)
		}
	}()
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("original path still exists: %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != string(content) {
		t.Fatalf("recycled content = %q, error %v", data, err)
	}
	after, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("file modification time changed")
	}
}
