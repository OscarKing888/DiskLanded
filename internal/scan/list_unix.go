//go:build linux || darwin

package scan

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// listDir reads the names in path and stats each one relative to the open
// directory descriptor, without following symlinks and without opening any
// file.
func listDir(path string, _ uint64) ([]entry, error) {
	fd, err := openDir(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil && len(names) == 0 {
		return nil, err
	}
	ents := make([]entry, len(names))
	for i, name := range names {
		ents[i].name = name
		if err := statAt(fd, name, &ents[i]); err != nil {
			ents[i].err = &os.PathError{Op: "stat", Path: name, Err: err}
		}
	}
	return ents, nil
}

func rootDev(path string) (uint64, error) {
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		return 0, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return 0, &os.PathError{Op: "stat", Path: path, Err: unix.ENOTDIR}
	}
	return uint64(st.Dev), nil
}

func kindOf(mode uint32) kind {
	switch mode & unix.S_IFMT {
	case unix.S_IFREG:
		return kindFile
	case unix.S_IFDIR:
		return kindDir
	case unix.S_IFLNK:
		return kindSymlink
	}
	return kindOther
}

func isBusy(err error) bool { return errors.Is(err, unix.EBUSY) || errors.Is(err, unix.ETXTBSY) }
