// Package trash moves individual files to the system trash, without a
// permanent-delete fallback.
package trash

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Path accepts only an existing regular file with an absolute path.
func Path(path string) error {
	if err := validate(path); err != nil {
		return err
	}
	_, err := move(path)
	if err != nil {
		return fmt.Errorf("移入回收站失败：%w", err)
	}
	return nil
}

func validate(path string) error {
	if !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || !utf8.ValidString(path) {
		return errors.New("文件路径无效")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("无法读取文件：%w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("只能将普通文件移入回收站，不支持目录、符号链接或特殊文件")
	}
	return nil
}
