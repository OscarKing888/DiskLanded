//go:build linux || darwin

package scan

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func volumeOf(path string) (Volume, error) {
	var fs unix.Statfs_t
	if err := unix.Statfs(path, &fs); err != nil {
		return Volume{}, &os.PathError{Op: "statfs", Path: path, Err: err}
	}
	bs := int64(fs.Bsize)
	total := int64(fs.Blocks) * bs
	return Volume{
		Mount: mountPoint(path, &fs),
		Total: total,
		Used:  total - int64(fs.Bfree)*bs,
		Free:  int64(fs.Bavail) * bs,
	}, nil
}

// mountPointByDev climbs parents until the device changes.
func mountPointByDev(path string) string {
	var st unix.Stat_t
	if unix.Stat(path, &st) != nil {
		return path
	}
	cur := path
	for {
		parent := filepath.Dir(cur)
		if parent == cur {
			return cur
		}
		var pst unix.Stat_t
		if unix.Stat(parent, &pst) != nil || pst.Dev != st.Dev {
			return cur
		}
		cur = parent
	}
}
