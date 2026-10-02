package scancache

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"disklanded/internal/scan"
)

func fixture() *scan.Result {
	root := filepath.Join(os.TempDir(), "中文 扫描目录")
	return &scan.Result{
		Roots: []string{root},
		Dirs:  []scan.DirRec{{Path: root, Alloc: 3_000_000, Logical: 4_000_000}},
		Files: []scan.FileRec{{Path: filepath.Join(root, "文件.bin"), Alloc: 3_000_000,
			Logical: 4_000_000, Appeared: 100, Modified: 90, AppearedIsMtime: true}},
		Walked: 12, Failed: 1, FailByReason: map[string]int64{"无权限": 1},
		FailSamples: []scan.Failure{{Path: filepath.Join(root, "私有"), Reason: "无权限"}},
		Canceled:    true, Started: time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC),
		Duration: 1500 * time.Millisecond,
	}
}

func TestRoundTripAndReplace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "含 空格", "last-scan.json.gz")
	skipped := []scan.Failure{{Path: "缺失目录", Reason: "已不存在"}}
	result := fixture()
	for i := 0; i < 2; i++ {
		if err := Save(path, result, skipped); err != nil {
			t.Fatal(err)
		}
		got, err := Load(path)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.Result, result) || !reflect.DeepEqual(got.Skipped, skipped) {
			t.Fatalf("snapshot lost metadata: %+v", got)
		}
		wantRows, wantTotal := result.QueryFiles(1_000_000, 0, 2000)
		rows, total := got.Result.QueryFiles(1_000_000, 0, 2000)
		if total != wantTotal || !reflect.DeepEqual(rows, wantRows) {
			t.Fatal("restored query differs")
		}
		result.Canceled = false
		result.Files = nil
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(path) {
		t.Fatalf("temporary files left behind: %v, %v", entries, err)
	}
}

func TestMissingAndInvalidCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.gz")
	if got, err := Load(path); got != nil || err != nil {
		t.Fatalf("missing cache: %v, %v", got, err)
	}
	for _, content := range []string{"broken gzip", "", "{\"version\":1,\"result\":null}",
		"{\"version\":999,\"result\":{\"Roots\":[\"root\"]}}", "{\"version\":1,\"result\":{}}",
		"{\"version\":1,\"result\":{\"Roots\":[\"root\"]}} {}"} {
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		z := gzip.NewWriter(f)
		if _, err := z.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		if err := z.Close(); err != nil {
			t.Fatal(err)
		}
		f.Close()
		if got, err := Load(path); got != nil || err == nil {
			t.Fatalf("accepted invalid cache %q: %v, %v", content, got, err)
		}
	}
	if err := Save(path, fixture(), nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, broken := range [][]byte{data[:len(data)-4], append(append([]byte{}, data[:len(data)-8]...), make([]byte, 8)...)} {
		if err := os.WriteFile(path, broken, 0600); err != nil {
			t.Fatal(err)
		}
		if got, err := Load(path); got != nil || err == nil {
			t.Fatalf("accepted incomplete/corrupt gzip: %v, %v", got, err)
		}
	}
}

func TestFailedSavePreservesPreviousSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.gz")
	result := fixture()
	if err := Save(path, result, nil); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []*scan.Result{nil, {}} {
		if err := Save(path, invalid, nil); err == nil {
			t.Fatal("accepted invalid snapshot")
		}
		got, err := Load(path)
		if err != nil || !reflect.DeepEqual(got.Result, result) {
			t.Fatalf("overwrote previous snapshot: %v", err)
		}
	}
	blocked := filepath.Join(path, "cache.gz")
	if err := Save(blocked, result, nil); err == nil {
		t.Fatal("accepted a file as the cache directory")
	}
}

func TestFailedReplacementCleansTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "destination")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, fixture(), nil); err == nil {
		t.Fatal("replaced a directory with a cache file")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "destination" {
		t.Fatalf("failed save left temporary files: %v, %v", entries, err)
	}
}

func TestUnknownVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	z := gzip.NewWriter(f)
	if err := json.NewEncoder(z).Encode(Snapshot{Version: formatVersion + 1, Result: fixture()}); err != nil {
		t.Fatal(err)
	}
	z.Close()
	f.Close()
	if got, err := Load(path); got != nil || err == nil {
		t.Fatalf("accepted newer format: %v, %v", got, err)
	}
}
