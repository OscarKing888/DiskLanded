package main

import (
	"path/filepath"
	"testing"
	"time"

	"disklanded/internal/scan"
)

func TestGraphCacheInvalidatesAfterTrash(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.bin")
	a := NewApp()
	a.result = &scan.Result{Roots: []string{root}, Dirs: []scan.DirRec{{Path: root, Alloc: 2_000_000}}, Files: []scan.FileRec{{Path: file, Alloc: 2_000_000, Appeared: time.Now().Unix()}}}
	view, err := a.QueryGraph(root, "files", 1_000_000, 60)
	if err != nil || view.Root.Alloc != 2_000_000 {
		t.Fatalf("before delete: %+v %v", view, err)
	}
	if err := a.trashFile(file, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	view, err = a.QueryGraph(root, "files", 1_000_000, 60)
	if err != nil || view.Root.Alloc != 0 {
		t.Fatalf("deleted file remained in cached graph: %+v %v", view, err)
	}
	view, err = a.QueryGraph(root, "dirs", 1_000_000, 60)
	if err != nil || view.Root.Alloc != 2_000_000 {
		t.Fatal("directory snapshot was silently changed")
	}
	if _, err := a.QueryGraph(root, "unknown", 0, 0); err == nil {
		t.Fatal("accepted invalid graph mode")
	}
	if _, err := NewApp().QueryGraph("", "dirs", 0, 0); err == nil {
		t.Fatal("accepted missing scan result")
	}
}
