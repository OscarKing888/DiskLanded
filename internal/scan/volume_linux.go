package scan

import "golang.org/x/sys/unix"

func mountPoint(path string, _ *unix.Statfs_t) string { return mountPointByDev(path) }
