package scan

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, p string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i) | 1 // non-zero so nothing is stored sparse
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func run(t *testing.T, roots ...string) *Result {
	t.Helper()
	keep, bad := NormalizeRoots(roots)
	if len(bad) > 0 {
		t.Fatalf("bad roots: %v", bad)
	}
	return New().Run(context.Background(), keep)
}

func dirOf(r *Result, p string) (DirRec, bool) {
	for _, d := range r.Dirs {
		if d.Path == p {
			return d, true
		}
	}
	return DirRec{}, false
}

func resolved(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestTreeTotalsLinksAndFiles(t *testing.T) {
	base := resolved(t, t.TempDir())
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	write(t, filepath.Join(root, "a", "big.bin"), 3_000_000)
	write(t, filepath.Join(root, "a", "b", "c.bin"), 2_000_000)
	write(t, filepath.Join(root, "small.txt"), 10)
	write(t, filepath.Join(outside, "huge.bin"), 5_000_000)
	if err := os.Symlink(outside, filepath.Join(root, "link-to-outside")); err != nil {
		t.Logf("symlink not supported here: %v", err)
	}
	hardlinked := os.Link(filepath.Join(root, "a", "big.bin"), filepath.Join(root, "a", "hard.bin")) == nil

	r := run(t, root)
	if r.Failed != 0 || r.Canceled {
		t.Fatalf("failed=%d canceled=%v samples=%v", r.Failed, r.Canceled, r.FailSamples)
	}
	d, ok := dirOf(r, root)
	if !ok {
		t.Fatalf("root dir not recorded; dirs=%v", r.Dirs)
	}
	// Content: 3 MB + 2 MB + 10 B; the symlink itself adds at most a few
	// bytes, the hard link adds nothing, the outside 5 MB must not appear.
	if d.Logical < 5_000_010 || d.Logical > 5_000_010+65536 {
		t.Errorf("root logical = %d, want ~5000010", d.Logical)
	}
	if d.Alloc < 5_000_000 || d.Alloc > 5_000_000+1<<20 {
		t.Errorf("root alloc = %d, want ~5 MB (outside link not followed, hard link once)", d.Alloc)
	}
	if a, _ := dirOf(r, filepath.Join(root, "a")); a.Alloc < 5_000_000 {
		t.Errorf("dir a alloc = %d", a.Alloc)
	}
	if _, ok := dirOf(r, filepath.Join(root, "link-to-outside")); ok {
		t.Error("symlink target was entered")
	}
	var names []string
	for _, f := range r.Files {
		names = append(names, filepath.Base(f.Path))
		if strings.HasPrefix(f.Path, outside) || filepath.Base(f.Path) == "huge.bin" {
			t.Errorf("file outside root recorded: %s", f.Path)
		}
		if f.Logical < 2_000_000 {
			t.Errorf("small file recorded: %+v", f)
		}
		if age := time.Since(time.Unix(f.Appeared, 0)); age < -time.Hour || age > 24*time.Hour {
			t.Errorf("appeared %v for new file %s", time.Unix(f.Appeared, 0), f.Path)
		}
		t.Logf("file %s alloc=%d logical=%d appearedIsMtime=%v", f.Path, f.Alloc, f.Logical, f.AppearedIsMtime)
	}
	want := 2
	if len(r.Files) != want {
		t.Errorf("files = %v, want %d (hardlinked=%v)", names, want, hardlinked)
	}
}

func TestPermissionDeniedIsSkippedAndCounted(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, filepath.Join(root, "ok", "f.bin"), 2_000_000)
	locked := filepath.Join(root, "locked")
	write(t, filepath.Join(locked, "secret.bin"), 2_000_000)
	undo := denyAccess(t, locked)
	defer undo()

	r := run(t, root)
	if r.Canceled {
		t.Fatal("scan canceled")
	}
	if r.Failed < 1 || r.FailByReason["无权限"] < 1 {
		t.Fatalf("failed=%d byReason=%v samples=%v", r.Failed, r.FailByReason, r.FailSamples)
	}
	if r.FailSamples[0].Path != locked {
		t.Errorf("failure path = %s, want %s", r.FailSamples[0].Path, locked)
	}
	if d, _ := dirOf(r, filepath.Join(root, "ok")); d.Alloc < 2_000_000 {
		t.Errorf("readable sibling not counted: %+v", d)
	}
	if len(r.Files) != 1 {
		t.Errorf("files = %+v", r.Files)
	}
}

func TestScanDoesNotChangeTimestamps(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, filepath.Join(root, "d1", "d2", "f.bin"), 2_000_000)
	write(t, filepath.Join(root, "d1", "g.txt"), 100)
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	var paths []string
	filepath.WalkDir(root, func(p string, _ os.DirEntry, _ error) error { paths = append(paths, p); return nil })
	for i := len(paths) - 1; i >= 0; i-- { // children first so parents keep their times
		if err := os.Chtimes(paths[i], old, old); err != nil {
			t.Fatal(err)
		}
	}
	before := map[string][2]time.Time{}
	for _, p := range paths {
		before[p] = times(t, p)
	}
	for i := 0; i < 2; i++ {
		run(t, root)
	}
	for _, p := range paths {
		if got := times(t, p); got != before[p] {
			t.Errorf("%s: atime/mtime changed from %v to %v", p, before[p], got)
		}
	}
}

func TestCancel(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, filepath.Join(root, "a", "f.bin"), 10)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := New().Run(ctx, []string{root})
	if !r.Canceled {
		t.Fatal("not marked canceled")
	}
}

func TestNormalizeRoots(t *testing.T) {
	root := resolved(t, t.TempDir())
	inner := filepath.Join(root, "inner")
	os.MkdirAll(inner, 0o755)
	keep, bad := NormalizeRoots([]string{inner, root, root + string(filepath.Separator), " ", filepath.Join(root, "missing")})
	if len(keep) != 1 || keep[0] != root {
		t.Errorf("keep = %v", keep)
	}
	if len(bad) != 1 || bad[0].Reason != "已不存在" {
		t.Errorf("bad = %v", bad)
	}
}

func TestQueries(t *testing.T) {
	now := time.Now().Unix()
	day := int64(86400)
	r := &Result{
		Dirs: []DirRec{{"/a", 5e9, 5e9}, {"/b", 1e9, 1e9}, {"/c", 999_999_999, 1e9}},
		Files: []FileRec{
			{Path: "/new-big", Alloc: 600e6, Appeared: now - day},
			{Path: "/new-small", Alloc: 400e6, Appeared: now - 2*day},
			{Path: "/mid-big", Alloc: 2e9, Appeared: now - 30*day, AppearedIsMtime: true},
			{Path: "/old-big", Alloc: 3e9, Appeared: now - 61*day},
		},
	}
	rows, n := r.QueryDirs(1e9, 10)
	if n != 2 || rows[0].Path != "/a" || rows[1].Path != "/b" {
		t.Errorf("dirs >=1GB: %v", rows)
	}
	if _, n := r.QueryDirs(2e9, 10); n != 1 {
		t.Errorf("dirs >=2GB: %d", n)
	}
	if rows, n := r.QueryDirs(0, 1); n != 3 || len(rows) != 1 {
		t.Errorf("limit: %d %d", n, len(rows))
	}
	f, n := r.QueryFiles(500e6, now-60*day, 10)
	if n != 2 || f[0].Path != "/new-big" || f[1].Path != "/mid-big" || !f[1].AppearedIsMtime {
		t.Errorf("files default: %v", f)
	}
	if f, _ := r.QueryFiles(100e6, now-7*day, 10); len(f) != 2 || f[1].Path != "/new-small" {
		t.Errorf("files 100MB/7d: %v", f)
	}
	if f, _ := r.QueryFiles(500e6, now-90*day, 10); len(f) != 3 {
		t.Errorf("files 90d: %v", f)
	}
	if isDir, ok := r.Contains("/b"); !ok || !isDir {
		t.Error("Contains dir")
	}
	if isDir, ok := r.Contains("/old-big"); !ok || isDir {
		t.Error("Contains file")
	}
	if _, ok := r.Contains("/etc/passwd"); ok {
		t.Error("Contains foreign path")
	}
}

func TestVolumes(t *testing.T) {
	home, _ := os.UserHomeDir()
	v, bad := Volumes([]string{home, home})
	if len(bad) != 0 || len(v) != 1 {
		t.Fatalf("volumes=%v bad=%v", v, bad)
	}
	x := v[0]
	if x.Total <= 0 || x.Used < 0 || x.Free < 0 || x.Used > x.Total || x.Percent < 0 || x.Percent > 100 {
		t.Errorf("volume %+v", x)
	}
	t.Logf("volume %s total=%.1fGB used=%.1fGB free=%.1fGB %.1f%%", x.Mount, float64(x.Total)/1e9, float64(x.Used)/1e9, float64(x.Free)/1e9, x.Percent)
}

// TestHomeScan scans the real home directory. Opt in with
// DISKLANDED_HOME_SCAN=1 because it can take minutes.
func TestHomeScan(t *testing.T) {
	if os.Getenv("DISKLANDED_HOME_SCAN") == "" {
		t.Skip("set DISKLANDED_HOME_SCAN=1")
	}
	home, _ := os.UserHomeDir()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	keep, _ := NormalizeRoots([]string{home})
	r := New().Run(ctx, keep)
	if r.Canceled {
		t.Fatalf("home scan did not finish in time: walked=%d", r.Walked)
	}
	if len(r.Dirs) == 0 || r.Walked == 0 {
		t.Fatal("empty result")
	}
	t.Logf("home %s: walked=%d dirs=%d files>=1MB=%d failed=%d %v in %v",
		home, r.Walked, len(r.Dirs), len(r.Files), r.Failed, r.FailByReason, r.Duration)
	top, n := r.QueryDirs(1e9, 5)
	t.Logf("dirs >= 1 GB: %d, top: %+v", n, top)
	f, n := r.QueryFiles(500e6, time.Now().Add(-60*24*time.Hour).Unix(), 5)
	t.Logf("files >= 500 MB in 60 days: %d, newest: %+v", n, f)
}
