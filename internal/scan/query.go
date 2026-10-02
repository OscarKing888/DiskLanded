package scan

import (
	"os"
	"sort"
	"strings"
)

// DirRow and FileRow are the rows sent to the UI.
type DirRow struct {
	Path    string `json:"path"`
	Alloc   int64  `json:"alloc"`
	Logical int64  `json:"logical"`
}

type FileRow struct {
	Path            string `json:"path"`
	Alloc           int64  `json:"alloc"`
	Logical         int64  `json:"logical"`
	Appeared        int64  `json:"appeared"`
	Modified        int64  `json:"modified"`
	AppearedIsMtime bool   `json:"appearedIsMtime"`
}

// QueryDirs returns directories whose allocated size is at least minAlloc,
// largest first, at most limit rows, plus the total number of matches.
func (r *Result) QueryDirs(minAlloc int64, limit int) ([]DirRow, int) {
	rows := []DirRow{}
	n := 0
	for _, d := range r.Dirs { // sorted by Alloc desc
		if d.Alloc < minAlloc {
			break
		}
		n++
		if len(rows) < limit {
			rows = append(rows, DirRow{d.Path, d.Alloc, d.Logical})
		}
	}
	return rows, n
}

// QueryFiles returns files whose allocated size is at least minAlloc and
// whose appearance time is at or after since (unix seconds), newest first.
func (r *Result) QueryFiles(minAlloc, since int64, limit int) ([]FileRow, int) {
	rows := []FileRow{}
	n := 0
	for _, f := range r.Files { // sorted by Appeared desc
		if f.Appeared < since {
			break
		}
		if f.Alloc < minAlloc {
			continue
		}
		n++
		if len(rows) < limit {
			rows = append(rows, FileRow{f.Path, f.Alloc, f.Logical, f.Appeared, f.Modified, f.AppearedIsMtime})
		}
	}
	return rows, n
}

// QueryFilesUnder returns files at any depth inside dir whose allocated size
// is at least minAlloc, largest first, at most limit rows, plus the total
// number of matches. The directory itself is never part of the result.
func (r *Result) QueryFilesUnder(dir string, minAlloc int64, limit int) ([]FileRow, int) {
	prefix := dir
	if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
		prefix += string(os.PathSeparator)
	}
	matches := []FileRec{}
	for _, f := range r.Files {
		if f.Alloc >= minAlloc && strings.HasPrefix(f.Path, prefix) {
			matches = append(matches, f)
		}
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].Alloc > matches[j].Alloc })
	rows := []FileRow{}
	for _, f := range matches {
		if len(rows) == limit {
			break
		}
		rows = append(rows, FileRow{f.Path, f.Alloc, f.Logical, f.Appeared, f.Modified, f.AppearedIsMtime})
	}
	return rows, len(matches)
}

// Contains reports whether path is a directory or recorded file of this
// result. Used to restrict "reveal" to paths the scan actually produced.
func (r *Result) Contains(path string) (isDir, ok bool) {
	for _, d := range r.Dirs {
		if d.Path == path {
			return true, true
		}
	}
	for _, f := range r.Files {
		if f.Path == path {
			return false, true
		}
	}
	return false, false
}
