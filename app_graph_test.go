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
	view, err := a.QueryGraph(root)
	if err != nil || view.Root.Alloc != 2_000_000 || len(view.Root.Children) != 1 || view.Root.Children[0].Path != file {
		t.Fatalf("before delete: %+v %v", view, err)
	}
	if err := a.trashFile(file, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	view, err = a.QueryGraph(root)
	if err != nil || view.Root.Alloc != 2_000_000 {
		t.Fatal("directory snapshot was silently changed")
	}
	for _, child := range view.Root.Children {
		if child.Path == file {
			t.Fatalf("deleted file remained in cached graph: %+v", view)
		}
	}
	if _, err := NewApp().QueryGraph(""); err == nil {
		t.Fatal("accepted missing scan result")
	}
}
