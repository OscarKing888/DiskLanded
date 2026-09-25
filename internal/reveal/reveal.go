// Package reveal shows a path in the system file manager. It only passes the
// path to the platform tool; it never opens or reads the file itself.
package reveal

import (
	"fmt"
	"os"
)

// Path reveals path. Whether it is a directory is taken from disk now, since
// it may have changed after the scan.
func Path(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("路径已不存在或无法访问：%w", err)
	}
	cmd := command(path, fi.IsDir())
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法启动文件管理器：%w", err)
	}
	go cmd.Wait() // reap; exit codes of file managers are not meaningful
	return nil
}
