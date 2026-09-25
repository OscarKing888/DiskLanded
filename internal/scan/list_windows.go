package scan

import (
	"encoding/binary"
	"errors"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Offsets inside FILE_ID_BOTH_DIR_INFO (MS-FSCC 2.4.17).
const (
	offNext        = 0
	offCreation    = 8
	offLastWrite   = 24
	offEndOfFile   = 40
	offAllocation  = 48
	offAttributes  = 56
	offNameLength  = 60
	offEaSize      = 64 // holds the reparse tag when the reparse attribute is set
	offFileID      = 96
	offFileName    = 104
	fileIDBothInfo = windows.FileIdBothDirectoryInfo
)

// LongPath adds the \\?\ prefix so paths longer than MAX_PATH work.
func LongPath(p string) string {
	if strings.HasPrefix(p, `\\?\`) || len(p) < 240 {
		return p
	}
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	return `\\?\` + p
}

// listDir enumerates a directory through one handle opened for listing
// only. FILE_ID_BOTH_DIR_INFO carries creation time, allocation size, file
// ID and reparse tag for every entry, so no file is opened. dev is the volume
// serial of the scan root; volumes mounted below it are reparse points and
// are never entered, so every entry shares it.
func listDir(path string, dev uint64) ([]entry, error) {
	p16, err := windows.UTF16PtrFromString(LongPath(path))
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p16, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer windows.CloseHandle(h)

	buf := make([]uint64, 8192) // 64 KiB, 8-byte aligned
	b := unsafe.Slice((*byte)(unsafe.Pointer(&buf[0])), len(buf)*8)
	var ents []entry
	for {
		err := windows.GetFileInformationByHandleEx(h, fileIDBothInfo, &b[0], uint32(len(b)))
		if err != nil {
			if err == windows.ERROR_NO_MORE_FILES {
				break
			}
			if len(ents) == 0 {
				return nil, &os.PathError{Op: "readdir", Path: path, Err: err}
			}
			break
		}
		off := 0
		for {
			rec := b[off:]
			nameLen := int(binary.LittleEndian.Uint32(rec[offNameLength:]))
			name16 := unsafe.Slice((*uint16)(unsafe.Pointer(&rec[offFileName])), nameLen/2)
			name := windows.UTF16ToString(name16)
			if name != "." && name != ".." {
				attrs := binary.LittleEndian.Uint32(rec[offAttributes:])
				e := entry{
					name:    name,
					logical: int64(binary.LittleEndian.Uint64(rec[offEndOfFile:])),
					alloc:   int64(binary.LittleEndian.Uint64(rec[offAllocation:])),
					birth:   filetimeUnix(binary.LittleEndian.Uint64(rec[offCreation:])),
					birthOK: true,
					mtime:   filetimeUnix(binary.LittleEndian.Uint64(rec[offLastWrite:])),
					dev:     dev,
					ino:     binary.LittleEndian.Uint64(rec[offFileID:]),
				}
				// The link count is not in this record. Deduplicate recorded
				// (large) files by file ID; small hard links may count twice.
				e.dedupe = e.alloc >= FileFloor
				reparse := attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
				tag := binary.LittleEndian.Uint32(rec[offEaSize:])
				linkLike := reparse && (tag == windows.IO_REPARSE_TAG_SYMLINK || tag == windows.IO_REPARSE_TAG_MOUNT_POINT)
				switch {
				case attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0:
					e.kind = kindDir
					// Junctions, directory symlinks and volume mount points are
					// never entered. Other reparse directories (e.g. cloud
					// sync folders) are ordinary directories on this volume.
					e.noDescend = linkLike
				case linkLike:
					e.kind = kindSymlink
				default:
					e.kind = kindFile
				}
				ents = append(ents, e)
			}
			next := int(binary.LittleEndian.Uint32(rec[offNext:]))
			if next == 0 {
				break
			}
			off += next
		}
	}
	return ents, nil
}

func filetimeUnix(ft uint64) int64 {
	if ft == 0 {
		return 0
	}
	// 100-ns intervals since 1601-01-01.
	return int64(ft/10_000_000) - 11644473600
}

func rootDev(path string) (uint64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if !fi.IsDir() {
		return 0, &os.PathError{Op: "stat", Path: path, Err: windows.ERROR_DIRECTORY}
	}
	vol := make([]uint16, windows.MAX_LONG_PATH)
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	if err := windows.GetVolumePathName(p16, &vol[0], uint32(len(vol))); err != nil {
		return 0, &os.PathError{Op: "GetVolumePathName", Path: path, Err: err}
	}
	var serial uint32
	if err := windows.GetVolumeInformation(&vol[0], nil, 0, &serial, nil, nil, nil, 0); err != nil {
		return 0, &os.PathError{Op: "GetVolumeInformation", Path: path, Err: err}
	}
	return uint64(serial), nil
}

func isBusy(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}
