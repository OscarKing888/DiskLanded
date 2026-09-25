package scan

import (
	"errors"
	"sync/atomic"

	"golang.org/x/sys/unix"
)

// openDir opens a directory with O_NOATIME so reading it does not update the
// directory's access time. O_NOATIME is only allowed for the owner, so fall
// back to a plain open for directories owned by someone else.
func openDir(path string) (int, error) {
	const flags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NONBLOCK
	for {
		fd, err := unix.Open(path, flags|unix.O_NOATIME, 0)
		if err == unix.EPERM {
			fd, err = unix.Open(path, flags, 0)
		}
		if err == unix.EINTR {
			continue
		}
		return fd, err
	}
}

var noStatx atomic.Bool

func statAt(dirfd int, name string, e *entry) error {
	if !noStatx.Load() {
		var sx unix.Statx_t
		err := unix.Statx(dirfd, name,
			unix.AT_SYMLINK_NOFOLLOW|unix.AT_STATX_DONT_SYNC|unix.AT_NO_AUTOMOUNT,
			unix.STATX_BASIC_STATS|unix.STATX_BTIME, &sx)
		if err == nil {
			e.kind = kindOf(uint32(sx.Mode))
			e.logical = int64(sx.Size)
			e.alloc = int64(sx.Blocks) * 512
			e.mtime = sx.Mtime.Sec
			if sx.Mask&unix.STATX_BTIME != 0 && sx.Btime.Sec != 0 {
				e.birth, e.birthOK = sx.Btime.Sec, true
			}
			e.dev = unix.Mkdev(sx.Dev_major, sx.Dev_minor)
			e.ino = sx.Ino
			e.dedupe = sx.Nlink > 1
			return nil
		}
		if !errors.Is(err, unix.ENOSYS) {
			return err
		}
		noStatx.Store(true)
	}
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	e.kind = kindOf(st.Mode)
	e.logical = st.Size
	e.alloc = st.Blocks * 512
	e.mtime = st.Mtim.Sec
	e.dev = st.Dev
	e.ino = st.Ino
	e.dedupe = st.Nlink > 1
	return nil
}
