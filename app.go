package main

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"disklanded/internal/reveal"
	"disklanded/internal/scan"
	"disklanded/internal/trash"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const maxRows = 2000

// App is bound to the frontend; its exported methods are callable from JS.
type App struct {
	ctx context.Context

	mu      sync.Mutex
	cancel  context.CancelFunc
	result  *scan.Result
	skipped []scan.Failure // roots that could not be scanned
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// Version is the app version from the VERSION file, e.g. "0.1".
func (a *App) Version() string { return appVersion }

// DefaultRoots is the user's home directory.
func (a *App) DefaultRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{}
	}
	return []string{home}
}

// PickDirectory shows the native folder chooser; "" when cancelled.
func (a *App) PickDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "选择要扫描的目录"})
}

type VolumesResp struct {
	Volumes []scan.Volume  `json:"volumes"`
	Errors  []scan.Failure `json:"errors"`
}

func (a *App) Volumes(roots []string) VolumesResp {
	v, bad := scan.Volumes(roots)
	if v == nil {
		v = []scan.Volume{}
	}
	return VolumesResp{Volumes: v, Errors: bad}
}

// StartScan begins a scan in the background. Progress arrives as
// "scan:progress" events and completion as "scan:done".
func (a *App) StartScan(roots []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		return errors.New("已有扫描在进行")
	}
	keep, bad := scan.NormalizeRoots(roots)
	if len(keep) == 0 {
		return errors.New("没有可扫描的目录")
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.result = nil
	a.skipped = bad
	s := scan.New()

	go func() {
		t := time.NewTicker(150 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				runtime.EventsEmit(a.ctx, "scan:progress", s.Progress())
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		res := s.Run(ctx, keep)
		a.mu.Lock()
		a.result = res
		a.cancel = nil
		a.mu.Unlock()
		cancel()
		runtime.EventsEmit(a.ctx, "scan:done", a.Summary())
	}()
	return nil
}

func (a *App) CancelScan() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
}

type Summary struct {
	HasResult    bool             `json:"hasResult"`
	Roots        []string         `json:"roots"`
	Walked       int64            `json:"walked"`
	Failed       int64            `json:"failed"`
	FailByReason map[string]int64 `json:"failByReason"`
	FailSamples  []scan.Failure   `json:"failSamples"`
	Canceled     bool             `json:"canceled"`
	Seconds      float64          `json:"seconds"`
	FileFloor    int64            `json:"fileFloor"`
}

func (a *App) Summary() Summary {
	a.mu.Lock()
	defer a.mu.Unlock()
	r := a.result
	if r == nil {
		return Summary{FileFloor: scan.FileFloor}
	}
	failed := r.Failed + int64(len(a.skipped))
	samples := append(append([]scan.Failure{}, a.skipped...), r.FailSamples...)
	by := map[string]int64{}
	for k, v := range r.FailByReason {
		by[k] = v
	}
	for _, f := range a.skipped {
		by[f.Reason]++
	}
	return Summary{
		HasResult: true, Roots: r.Roots, Walked: r.Walked, Failed: failed,
		FailByReason: by, FailSamples: samples, Canceled: r.Canceled,
		Seconds: r.Duration.Seconds(), FileFloor: scan.FileFloor,
	}
}

type DirsResp struct {
	Rows  []scan.DirRow `json:"rows"`
	Total int           `json:"total"`
}

// QueryDirs filters by allocated size in bytes.
func (a *App) QueryDirs(minBytes int64) DirsResp {
	a.mu.Lock()
	r := a.result
	a.mu.Unlock()
	if r == nil {
		return DirsResp{Rows: []scan.DirRow{}}
	}
	rows, n := r.QueryDirs(minBytes, maxRows)
	return DirsResp{rows, n}
}

type FilesResp struct {
	Rows  []scan.FileRow `json:"rows"`
	Total int            `json:"total"`
}

// QueryFiles filters by allocated size in bytes and appearance within days.
func (a *App) QueryFiles(minBytes int64, days int) FilesResp {
	a.mu.Lock()
	r := a.result
	a.mu.Unlock()
	if r == nil {
		return FilesResp{Rows: []scan.FileRow{}}
	}
	since := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	rows, n := r.QueryFiles(minBytes, since, maxRows)
	return FilesResp{rows, n}
}

// Reveal shows a path from the current result in the file manager.
func (a *App) Reveal(path string) error {
	a.mu.Lock()
	r := a.result
	a.mu.Unlock()
	if r == nil {
		return errors.New("没有扫描结果")
	}
	if _, ok := r.Contains(path); !ok {
		return errors.New("该路径不在扫描结果中")
	}
	return reveal.Path(path)
}

// TrashFile only accepts files recorded by the completed scan.
func (a *App) TrashFile(path string) error {
	return a.trashFile(path, trash.Path)
}

func (a *App) trashFile(path string, move func(string) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		return errors.New("扫描进行中，请等待扫描结束后再删除")
	}
	r := a.result
	if r == nil {
		return errors.New("没有扫描结果")
	}
	if isDir, ok := r.Contains(path); !ok || isDir {
		return errors.New("只能删除扫描结果中的文件")
	}
	if err := move(path); err != nil {
		return err
	}
	// 查询使用不可变快照：仅在系统回收成功后移除文件，失败时保留结果。
	next := *r
	next.Files = make([]scan.FileRec, 0, len(r.Files)-1)
	for _, file := range r.Files {
		if file.Path != path {
			next.Files = append(next.Files, file)
		}
	}
	a.result = &next
	return nil
}
