// Package scancache persists scan metadata in the user's local cache directory.
package scancache

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"disklanded/internal/scan"
)

const formatVersion = 1

type Snapshot struct {
	Version int            `json:"version"`
	Result  *scan.Result   `json:"result"`
	Skipped []scan.Failure `json:"skipped"`
}

func DefaultPath() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "DiskLanded", "last-scan.json.gz"), nil
}

func Load(path string) (*Snapshot, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer z.Close()
	var snapshot Snapshot
	decoder := json.NewDecoder(z)
	if err := decoder.Decode(&snapshot); err != nil {
		return nil, err
	}
	// 读到末尾以校验 gzip 校验和，并拒绝截断或附加的 JSON 数据。
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("缓存包含多余数据")
		}
		return nil, err
	}
	if snapshot.Version != formatVersion || snapshot.Result == nil || len(snapshot.Result.Roots) == 0 {
		return nil, errors.New("缓存格式无效或版本不兼容")
	}
	return &snapshot, nil
}

func Save(path string, result *scan.Result, skipped []scan.Failure) error {
	if result == nil || len(result.Roots) == 0 {
		return errors.New("没有可缓存的扫描结果")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// 同目录临时文件写完后才替换旧缓存；失败时保留上次结果。
	f, err := os.CreateTemp(dir, ".last-scan-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	z := gzip.NewWriter(f)
	if err := json.NewEncoder(z).Encode(Snapshot{formatVersion, result, skipped}); err != nil {
		z.Close()
		return err
	}
	if err := z.Close(); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return fmt.Errorf("替换扫描缓存失败：%w", err)
	}
	return nil
}
