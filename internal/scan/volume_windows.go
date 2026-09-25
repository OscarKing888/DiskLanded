package scan

import (
	"os"

	"golang.org/x/sys/windows"
)

func volumeOf(path string) (Volume, error) {
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return Volume{}, err
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	mount := path
	if windows.GetVolumePathName(p16, &buf[0], uint32(len(buf))) == nil {
		mount = windows.UTF16ToString(buf)
	}
	var avail, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p16, &avail, &total, &free); err != nil {
		return Volume{}, &os.PathError{Op: "GetDiskFreeSpaceEx", Path: path, Err: err}
	}
	return Volume{
		Mount: mount,
		Total: int64(total),
		Used:  int64(total - free),
		Free:  int64(avail),
	}, nil
}
