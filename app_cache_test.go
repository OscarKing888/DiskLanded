package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"disklanded/internal/scan"
)

func TestScanCacheRestoresSummaryAndQueries(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(t.TempDir(), "cache.gz")
	result := &scan.Result{
		Roots: []string{root}, Dirs: []scan.DirRec{{Path: root, Alloc: 4_000_000}},
		Files: []scan.FileRec{{Path: filepath.Join(root, "文件.bin"), Alloc: 4_000_000,
			Appeared: time.Now().Unix()}},
		Walked: 5, Failed: 1, FailByReason: map[string]int64{"无权限": 1},
		FailSamples: []scan.Failure{{Path: "private", Reason: "无权限"}},
		Canceled:    true, Started: time.Now().UTC(), Duration: time.Second,
	}
	app := &App{cachePath: path, skipped: []scan.Failure{{Path: "missing", Reason: "已不存在"}}}
	want := app.finishScan(result)
	if !want.HasResult || want.Restored || want.CacheError != "" {
		t.Fatalf("completion: %+v", want)
	}
	next := &App{cachePath: path}
	next.startup(context.Background())
	got := next.Summary()
	want.Restored = true
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restored summary: %+v; want %+v", got, want)
	}
	if !reflect.DeepEqual(next.QueryDirs(1), app.QueryDirs(1)) ||
		!reflect.DeepEqual(next.QueryFiles(1, 60), app.QueryFiles(1, 60)) {
		t.Fatal("restored queries differ")
	}
	for _, mode := range []string{"dirs", "files"} {
		wantGraph, err := app.QueryGraph(root, mode, 1_000_000, 60)
		if err != nil {
			t.Fatal(err)
		}
		gotGraph, err := next.QueryGraph(root, mode, 1_000_000, 60)
		if err != nil || !reflect.DeepEqual(gotGraph, wantGraph) {
			t.Fatalf("restored %s graph differs: %v", mode, err)
		}
	}
	if err := next.trashFile(result.Files[0].Path, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	reopened := &App{cachePath: path}
	reopened.startup(context.Background())
	if reopened.QueryFiles(1, 60).Total != 0 || reopened.QueryDirs(1).Total != 1 {
		t.Fatal("reopened cache did not preserve successful trash update")
	}
	if graph, err := reopened.QueryGraph(root, "files", 1_000_000, 60); err != nil || graph.Root.Alloc != 0 {
		t.Fatalf("deleted file remained in reopened graph: %+v %v", graph, err)
	}
	result.Canceled = false
	if summary := next.finishScan(result); summary.Restored || summary.Canceled || summary.CacheError != "" {
		t.Fatalf("new scan did not replace restored state: %+v", summary)
	}
}

func TestCacheErrorsDoNotLoseScanResults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.gz")
	if err := os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	app := &App{cachePath: path}
	app.startup(context.Background())
	if summary := app.Summary(); summary.HasResult || summary.CacheError == "" {
		t.Fatalf("corrupt cache: %+v", summary)
	}
	result := &scan.Result{Roots: []string{t.TempDir()}}
	if summary := app.finishScan(result); !summary.HasResult || summary.CacheError != "" {
		t.Fatalf("rescan did not recover cache: %+v", summary)
	}
	app.cachePath = filepath.Join(path, "blocked.gz")
	if summary := app.finishScan(result); !summary.HasResult || summary.CacheError == "" {
		t.Fatalf("write failure lost scan result: %+v", summary)
	}
	app.result.Files = []scan.FileRec{{Path: "file", Alloc: 2_000_000}}
	if err := app.trashFile("file", func(string) error { return nil }); err != nil || len(app.result.Files) != 0 {
		t.Fatalf("cache failure changed trash outcome: %v", err)
	}
	missing := &App{cachePath: filepath.Join(t.TempDir(), "missing.gz")}
	missing.startup(context.Background())
	if summary := missing.Summary(); summary.HasResult || summary.CacheError != "" {
		t.Fatalf("missing cache: %+v", summary)
	}
}
