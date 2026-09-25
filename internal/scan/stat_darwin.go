package scan

import "golang.org/x/sys/unix"

func openDir(path string) (int, error) {
	for {
		fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
		if err == unix.EINTR {
			continue
		}
		return fd, err
	}
}

func statAt(dirfd int, name string, e *entry) error {
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	e.kind = kindOf(uint32(st.Mode))
	e.logical = st.Size
	e.alloc = st.Blocks * 512
	e.mtime = st.Mtim.Sec
	e.birth, e.birthOK = st.Btim.Sec, true
	e.dev = uint64(st.Dev)
	e.ino = st.Ino
	e.dedupe = st.Nlink > 1
	return nil
}
