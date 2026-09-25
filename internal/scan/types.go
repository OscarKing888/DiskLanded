// Package scan walks local directory trees and records disk usage without
// reading file contents or following links out of the scan roots.
package scan

import "time"

// FileFloor is the smallest allocated size a file must have to be kept in the
// scan result. Directory totals still include every file.
const FileFloor int64 = 1_000_000

type kind uint8

const (
	kindFile kind = iota
	kindDir
	kindSymlink
	kindOther
)

// entry is the platform-neutral metadata of one directory entry, obtained
// without following symlinks and without opening the file.
type entry struct {
	name      string
	kind      kind
	noDescend bool // Windows: junction / mount-point / symlink directory
	logical   int64
	alloc     int64
	birth     int64 // unix seconds; valid when birthOK
	birthOK   bool
	mtime     int64 // unix seconds
	dev       uint64
	ino       uint64
	dedupe    bool // may be reachable through another hard link
	err       error
}

// DirRec is the aggregated usage of one directory subtree.
type DirRec struct {
	Path    string
	Alloc   int64
	Logical int64
}

// FileRec is one file at or above FileFloor.
type FileRec struct {
	Path     string
	Alloc    int64
	Logical  int64
	Appeared int64 // unix seconds: birth time, or mtime when AppearedIsMtime
	Modified int64 // unix seconds
	// AppearedIsMtime is true when the file system did not report a birth
	// time (Linux only) and Appeared falls back to the modification time.
	AppearedIsMtime bool
}

// Failure is one path that could not be read.
type Failure struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Result holds everything one scan produced. Dirs are sorted by Alloc
// descending; Files by Appeared descending.
type Result struct {
	Roots        []string
	Dirs         []DirRec
	Files        []FileRec
	Walked       int64
	Failed       int64
	FailByReason map[string]int64
	FailSamples  []Failure
	Canceled     bool
	Started      time.Time
	Duration     time.Duration
}

// Progress is a snapshot of a running scan.
type Progress struct {
	Walked  int64  `json:"walked"`
	Failed  int64  `json:"failed"`
	Current string `json:"current"`
}
