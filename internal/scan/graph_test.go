package scan

import (
	"fmt"
	"path/filepath"
	"testing"
)

func graphFixture(t *testing.T) *Result {
	root := filepath.Join(t.TempDir(), "root")
	sub := filepath.Join(root, "sub")
	return &Result{Roots: []string{root}, Dirs: []DirRec{
		{Path: root, Alloc: 100, Logical: 110}, {Path: sub, Alloc: 60, Logical: 70},
	}, Files: []FileRec{
		{Path: filepath.Join(sub, "new.bin"), Alloc: 40, Logical: 50, Appeared: 200, Modified: 190},
		{Path: filepath.Join(root, "old.bin"), Alloc: 20, Logical: 20, Appeared: 100},
	}}
}

func assertGraphTotals(t *testing.T, n GraphNode) int {
	t.Helper()
	count := 1
	if len(n.Children) == 0 {
		return count
	}
	var total int64
	for _, c := range n.Children {
		total += c.Alloc
		count += assertGraphTotals(t, c)
	}
	if total != n.Alloc {
		t.Fatalf("%s children sum %d != %d", n.Path, total, n.Alloc)
	}
	return count
}

func TestGraphHierarchyDoesNotDoubleCount(t *testing.T) {
	r := graphFixture(t)
	g := r.GraphIndex(false, 0, 0)
	view, err := g.View("")
	if err != nil {
		t.Fatal(err)
	}
	if view.Root.Alloc != 100 {
		t.Fatalf("counted nested directories twice: %d", view.Root.Alloc)
	}
	assertGraphTotals(t, view.Root)
	sub := r.Dirs[1].Path
	view, err = g.View(sub)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Breadcrumbs) != 3 || view.Breadcrumbs[2].Path != sub {
		t.Fatalf("breadcrumbs: %+v", view.Breadcrumbs)
	}
	if view.Root.Alloc != 60 {
		t.Fatal("subtree weight is incorrect")
	}
	assertGraphTotals(t, view.Root)
	for _, path := range []string{"unscanned", r.Files[0].Path} {
		if _, err := g.View(path); err == nil {
			t.Fatalf("accepted non-directory %q", path)
		}
	}
}

func TestNewFilesGraphFiltersAndKeepsAncestors(t *testing.T) {
	r := graphFixture(t)
	view, err := r.GraphIndex(true, 30, 150).View("")
	if err != nil {
		t.Fatal(err)
	}
	if view.Root.Alloc != 40 {
		t.Fatalf("new file total: %d", view.Root.Alloc)
	}
	file := view.Root.Children[0].Children[0].Children[0]
	if file.Path != r.Files[0].Path || file.Kind != "file" || file.Appeared != 200 {
		t.Fatalf("file metadata lost: %+v", file)
	}
	assertGraphTotals(t, view.Root)
	empty, err := r.GraphIndex(true, 1000, 150).View(r.Roots[0])
	if err != nil || empty.Root.Alloc != 0 || len(empty.Root.Children) != 0 {
		t.Fatalf("empty filter result: %+v, %v", empty, err)
	}
}

func TestGraphBeyondListLimitAndBoundedPayload(t *testing.T) {
	r := graphFixture(t)
	r.Files = nil
	for i := 0; i < 5000; i++ {
		r.Files = append(r.Files, FileRec{Path: filepath.Join(r.Roots[0], fmt.Sprintf("file-%04d", i)), Alloc: 10, Appeared: 200})
	}
	view, err := r.GraphIndex(true, 1, 0).View(r.Roots[0])
	if err != nil {
		t.Fatal(err)
	}
	if view.Root.Alloc != 50000 {
		t.Fatal("graph truncated to the list row limit")
	}
	if len(view.Root.Children) > 37 {
		t.Fatal("unbounded sibling count")
	}
	if view.Root.Children[len(view.Root.Children)-1].Kind != "other" {
		t.Fatal("overflow weight is not represented")
	}
	if count := assertGraphTotals(t, view.Root); count > 2500 {
		t.Fatalf("unbounded graph payload: %d", count)
	}
}

func TestGraphMultipleRoots(t *testing.T) {
	r := graphFixture(t)
	other := filepath.Join(t.TempDir(), "other")
	r.Roots = append(r.Roots, other)
	r.Dirs = append(r.Dirs, DirRec{Path: other, Alloc: 50})
	view, err := r.GraphIndex(false, 0, 0).View("")
	if err != nil || len(view.Root.Children) != 2 || view.Root.Alloc != 150 {
		t.Fatalf("multiple roots: %+v %v", view.Root, err)
	}
	assertGraphTotals(t, view.Root)
}

func TestGraphBudgetPreservesTopLevelBranches(t *testing.T) {
	root := t.TempDir()
	r := &Result{Roots: []string{root}, Dirs: []DirRec{{Path: root, Alloc: 30 * 36 * 2}}}
	for i := 0; i < 30; i++ {
		branch := filepath.Join(root, fmt.Sprintf("branch-%02d", i))
		r.Dirs = append(r.Dirs, DirRec{Path: branch, Alloc: 36 * 2})
		for j := 0; j < 36; j++ {
			sub := filepath.Join(branch, fmt.Sprintf("sub-%02d", j))
			r.Dirs = append(r.Dirs, DirRec{Path: sub, Alloc: 2})
			for k := 0; k < 2; k++ {
				r.Files = append(r.Files, FileRec{Path: filepath.Join(sub, fmt.Sprint(k)), Alloc: 1})
			}
		}
	}
	view, err := r.GraphIndex(false, 0, 0).View(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Root.Children) != 30 {
		t.Fatal("expanding the first branch hid later top-level directories")
	}
	if count := assertGraphTotals(t, view.Root); count > 2500 {
		t.Fatalf("nested graph exceeded payload budget: %d", count)
	}
}
