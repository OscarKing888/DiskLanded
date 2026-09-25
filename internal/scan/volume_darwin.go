package scan

import "golang.org/x/sys/unix"

func mountPoint(path string, fs *unix.Statfs_t) string {
	if m := unix.ByteSliceToString(fs.Mntonname[:]); m != "" {
		return m
	}
	return mountPointByDev(path)
}
