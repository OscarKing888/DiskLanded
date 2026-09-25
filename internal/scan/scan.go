package scan

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxFailSamples = 500

// Scanner runs one scan. Create with New, call Run once; Progress may be
// called concurrently from another goroutine.
type Scanner struct {
	walked  atomic.Int64
	failed  atomic.Int64
	current atomic.Pointer[string]

	mu           sync.Mutex
	dirs         []DirRec
	files        []FileRec
	failByReason map[string]int64
	failSamples  []Failure
	hardlinks    map[[2]uint64]struct{}

	sem chan struct{}
}

func New() *Scanner {
	n := runtime.NumCPU() * 2
	if n > 16 {
		n = 16
	}
	if n < 2 {
		n = 2
	}
	return &Scanner{
		failByReason: map[string]int64{},
		hardlinks:    map[[2]uint64]struct{}{},
		sem:          make(chan struct{}, n),
	}
}

func (s *Scanner) Progress() Progress {
	p := Progress{Walked: s.walked.Load(), Failed: s.failed.Load()}
	if c := s.current.Load(); c != nil {
		p.Current = *c
	}
	return p
}

type total struct{ alloc, logical int64 }

func (t *total) add(alloc, logical int64) { t.alloc += alloc; t.logical += logical }

// NormalizeRoots cleans, de-duplicates and resolves roots. A root that lies
// inside another root on the same file system is dropped because the outer
// root already covers it. Unreadable roots are returned as failures.
func NormalizeRoots(roots []string) (keep []string, bad []Failure) {
	type r struct {
		path string
		dev  uint64
	}
	var rs []r
	seen := map[string]bool{}
	for _, raw := range roots {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		abs, err := filepath.Abs(p)
		if err == nil {
			// The user picked this path explicitly, so resolving a symlinked
			// root is what they asked for.
			abs, err = filepath.EvalSymlinks(abs)
		}
		var dev uint64
		if err == nil {
			dev, err = rootDev(abs)
		}
		if err != nil {
			bad = append(bad, Failure{Path: p, Reason: Reason(err)})
			continue
		}
		if seen[abs] {
			continue
		}
		seen[abs] = true
		rs = append(rs, r{abs, dev})
	}
	for i, a := range rs {
		covered := false
		for j, b := range rs {
			if i != j && a.dev == b.dev && isUnder(a.path, b.path) {
				covered = true
				break
			}
		}
		if !covered {
			keep = append(keep, a.path)
		}
	}
	return keep, bad
}

func isUnder(p, parent string) bool {
	rel, err := filepath.Rel(parent, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Run scans the given roots (already normalized) and returns the result.
// When ctx is canceled the partial result is returned with Canceled set.
func (s *Scanner) Run(ctx context.Context, roots []string) *Result {
	start := time.Now()
	for _, root := range roots {
		if ctx.Err() != nil {
			break
		}
		dev, err := rootDev(root)
		if err != nil {
			s.fail(root, err)
			continue
		}
		s.walkDir(ctx, root, dev)
	}
	sort.Slice(s.dirs, func(i, j int) bool {
		if s.dirs[i].Alloc != s.dirs[j].Alloc {
			return s.dirs[i].Alloc > s.dirs[j].Alloc
		}
		return s.dirs[i].Path < s.dirs[j].Path
	})
	sort.Slice(s.files, func(i, j int) bool {
		if s.files[i].Appeared != s.files[j].Appeared {
			return s.files[i].Appeared > s.files[j].Appeared
		}
		return s.files[i].Path < s.files[j].Path
	})
	s.hardlinks = nil
	return &Result{
		Roots:        roots,
		Dirs:         s.dirs,
		Files:        s.files,
		Walked:       s.walked.Load(),
		Failed:       s.failed.Load(),
		FailByReason: s.failByReason,
		FailSamples:  s.failSamples,
		Canceled:     ctx.Err() != nil,
		Started:      start,
		Duration:     time.Since(start),
	}
}

func (s *Scanner) walkDir(ctx context.Context, path string, dev uint64) total {
	var tot total
	if ctx.Err() != nil {
		return tot
	}
	p := path
	s.current.Store(&p)

	ents, err := listDir(path, dev)
	if err != nil {
		s.fail(path, err)
		return tot
	}

	type sub struct {
		path string
		res  total
	}
	var subs []*sub
	for i := range ents {
		e := &ents[i]
		s.walked.Add(1)
		child := filepath.Join(path, e.name)
		if e.err != nil {
			s.fail(child, e.err)
			continue
		}
		switch e.kind {
		case kindDir:
			if e.dev != dev {
				// Another mounted file system: not ours unless chosen as a root.
				continue
			}
			tot.add(e.alloc, e.logical)
			if e.noDescend {
				continue
			}
			subs = append(subs, &sub{path: child})
		case kindFile:
			if e.dedupe && !s.firstLink(e.dev, e.ino) {
				continue // already counted through another hard link
			}
			tot.add(e.alloc, e.logical)
			if e.alloc >= FileFloor {
				fr := FileRec{Path: child, Alloc: e.alloc, Logical: e.logical, Modified: e.mtime}
				if e.birthOK {
					fr.Appeared = e.birth
				} else {
					fr.Appeared = e.mtime
					fr.AppearedIsMtime = true
				}
				s.mu.Lock()
				s.files = append(s.files, fr)
				s.mu.Unlock()
			}
		default:
			// Symlinks and special files: count their own blocks only.
			tot.add(e.alloc, e.logical)
		}
	}
	ents = nil

	var wg sync.WaitGroup
	for _, sb := range subs {
		select {
		case s.sem <- struct{}{}:
			wg.Add(1)
			go func(sb *sub) {
				defer wg.Done()
				sb.res = s.walkDir(ctx, sb.path, dev)
				<-s.sem
			}(sb)
		default:
			sb.res = s.walkDir(ctx, sb.path, dev)
		}
	}
	wg.Wait()
	for _, sb := range subs {
		tot.add(sb.res.alloc, sb.res.logical)
	}

	s.mu.Lock()
	s.dirs = append(s.dirs, DirRec{Path: path, Alloc: tot.alloc, Logical: tot.logical})
	s.mu.Unlock()
	return tot
}

func (s *Scanner) firstLink(dev, ino uint64) bool {
	k := [2]uint64{dev, ino}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.hardlinks[k]; ok {
		return false
	}
	s.hardlinks[k] = struct{}{}
	return true
}

func (s *Scanner) fail(path string, err error) {
	s.failed.Add(1)
	r := Reason(err)
	s.mu.Lock()
	s.failByReason[r]++
	if len(s.failSamples) < maxFailSamples {
		s.failSamples = append(s.failSamples, Failure{Path: path, Reason: r})
	}
	s.mu.Unlock()
}

// Reason maps an error to a short Chinese category.
func Reason(err error) string {
	switch {
	case errors.Is(err, fs.ErrPermission):
		return "无权限"
	case errors.Is(err, fs.ErrNotExist):
		return "已不存在"
	case isBusy(err):
		return "被占用"
	default:
		var pe *os.PathError
		if errors.As(err, &pe) {
			return "其他错误：" + pe.Err.Error()
		}
		return "其他错误：" + err.Error()
	}
}
