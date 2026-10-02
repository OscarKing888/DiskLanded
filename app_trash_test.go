package main

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"disklanded/internal/scan"
)

func trashFixture() *App {
	return &App{result: &scan.Result{
		Dirs: []scan.DirRec{{Path: "directory", Alloc: 4_000_000}},
		Files: []scan.FileRec{
			{Path: "first", Alloc: 2_000_000, Appeared: time.Now().Unix()},
			{Path: "second", Alloc: 2_000_000, Appeared: time.Now().Unix()},
		},
	}}
}

func TestTrashOnlyScannedFiles(t *testing.T) {
	for _, path := range []string{"directory", "unscanned"} {
		app := trashFixture()
		called := false
		err := app.trashFile(path, func(string) error { called = true; return nil })
		if err == nil || called {
			t.Fatalf("unsafe target %q: error=%v called=%v", path, err, called)
		}
	}
	app := trashFixture()
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	app.cancel = cancel
	if err := app.trashFile("first", func(string) error { t.Fatal("deleted during scan"); return nil }); err == nil {
		t.Fatal("accepted deletion during scan")
	}
	if err := NewApp().trashFile("first", func(string) error { t.Fatal("deleted without results"); return nil }); err == nil {
		t.Fatal("accepted deletion without results")
	}
}

func TestTrashUpdatesOnlyAfterSuccess(t *testing.T) {
	app := trashFixture()
	original := app.result
	failure := errors.New("recycle bin unavailable")
	if err := app.trashFile("first", func(string) error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("lost system error: %v", err)
	}
	if app.result != original {
		t.Fatal("failed operation changed the result")
	}
	if err := app.trashFile("first", func(path string) error {
		if path != "first" {
			t.Fatalf("unexpected target: %q", path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(original.Files) != 2 {
		t.Fatal("modified a snapshot still in use by queries")
	}
	if got := app.QueryFiles(1, 60); got.Total != 1 || got.Rows[0].Path != "second" {
		t.Fatalf("query after delete: %+v", got)
	}
	if !reflect.DeepEqual(original.Dirs, app.result.Dirs) {
		t.Fatal("changed directory snapshot without rescanning")
	}
	if err := app.trashFile("first", func(string) error { t.Fatal("deleted same file twice"); return nil }); err == nil {
		t.Fatal("accepted duplicate deletion")
	}
}

func TestQueryDirFilesOnlyForScannedDirectories(t *testing.T) {
	app := &App{result: &scan.Result{
		Dirs: []scan.DirRec{{Path: filepath.Join("root", "dir"), Alloc: 3_000_000}},
		Files: []scan.FileRec{
			{Path: filepath.Join("root", "dir", "big"), Alloc: 2_000_000},
			{Path: filepath.Join("root", "dir", "tiny"), Alloc: 500_000},
			{Path: filepath.Join("root", "elsewhere"), Alloc: 9_000_000},
		},
	}}
	got, err := app.QueryDirFiles(filepath.Join("root", "dir"), 0)
	if err != nil || got.Total != 1 || got.Rows[0].Path != filepath.Join("root", "dir", "big") {
		t.Fatalf("dir files: %+v %v", got, err)
	}
	for _, path := range []string{filepath.Join("root", "dir", "big"), "unscanned"} {
		if _, err := app.QueryDirFiles(path, 0); err == nil {
			t.Errorf("accepted non-directory %q", path)
		}
	}
	if _, err := NewApp().QueryDirFiles("root", 0); err == nil {
		t.Error("accepted query without results")
	}
}
