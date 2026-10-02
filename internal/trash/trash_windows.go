package trash

import (
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32              = windows.NewLazySystemDLL("ole32.dll")
	createInstance     = ole32.NewProc("CoCreateInstance")
	createShellItem    = windows.NewLazySystemDLL("shell32.dll").NewProc("SHCreateItemFromParsingName")
	classFileOperation = guid("{3AD05575-8857-4850-9277-11B85BDB8E09}")
	iidFileOperation   = guid("{947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8}")
	iidShellItem       = guid("{43826D1E-E718-42EE-BC55-A1E261C37BFE}")
	iidUnknown         = guid("{00000000-0000-0000-C000-000000000046}")
	iidProgressSink    = guid("{04B0F1A7-9490-44BC-96E1-4296A31252E2}")
)

func guid(value string) windows.GUID {
	id, err := windows.GUIDFromString(value)
	if err != nil {
		panic(err)
	}
	return id
}

// IFileOperation and IShellItem both start with an IUnknown vtable.
type shellObject struct{ table *[23]uintptr }

func (o *shellObject) call(slot int, args ...uintptr) uintptr {
	params := append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)
	hr, _, _ := syscall.SyscallN(o.table[slot], params...)
	return hr
}

func hresult(hr uintptr) error {
	if int32(hr) < 0 {
		return fmt.Errorf("Windows 回收站操作失败（HRESULT 0x%08X）", uint32(hr))
	}
	return nil
}

const (
	// 强制回收、加入撤销记录；不显示错误/UAC，不处理关联 HTML 目录。
	recycleFlags        = 0x00080000 | 0x20000000 | 0x00100000 | 0x0400 | 0x0010 | 0x0004 | 0x2000
	recycleTransferFlag = 0x80 // TSF_DELETE_RECYCLE_IF_POSSIBLE
	eFail               = 0x80004005
	eNoInterface        = 0x80004002
)

func move(path string) (string, error) {
	// Shell COM operations must stay on one initialized apartment thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	err := windows.CoInitializeEx(0, 2)        // COINIT_APARTMENTTHREADED
	if err != nil && err != syscall.Errno(1) { // S_FALSE also requires CoUninitialize
		return "", err
	}
	defer windows.CoUninitialize()
	var sink *recycleSink
	// Keep the callback object alive until after IFileOperation releases it.
	defer func() { runtime.KeepAlive(sink) }()

	var operation *shellObject
	hr, _, _ := createInstance.Call(uintptr(unsafe.Pointer(&classFileOperation)), 0, 1,
		uintptr(unsafe.Pointer(&iidFileOperation)), uintptr(unsafe.Pointer(&operation)))
	if err := hresult(hr); err != nil {
		return "", err
	}
	defer operation.call(2) // Release
	if err := hresult(operation.call(5, recycleFlags)); err != nil {
		return "", err
	}

	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	var item *shellObject
	hr, _, _ = createShellItem.Call(uintptr(unsafe.Pointer(p)), 0,
		uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&item)))
	runtime.KeepAlive(p)
	if err := hresult(hr); err != nil {
		return "", err
	}
	defer item.call(2)

	sink = &recycleSink{table: &sinkTable}
	sink.refs.Store(1)
	hr, _, _ = syscall.SyscallN(operation.table[18], uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(item)), uintptr(unsafe.Pointer(sink)))
	if err := hresult(hr); err != nil {
		return "", err
	}
	err = hresult(operation.call(21)) // PerformOperations
	if sink.blocked.Load() != 0 {
		return "", errors.New("该位置无法使用回收站，已取消删除")
	}
	if err != nil {
		return "", err
	}
	var aborted int32
	hr, _, _ = syscall.SyscallN(operation.table[22], uintptr(unsafe.Pointer(operation)), uintptr(unsafe.Pointer(&aborted)))
	if err := hresult(hr); err != nil {
		return "", err
	}
	if aborted != 0 {
		return "", errors.New("回收站操作已取消，文件未删除")
	}
	if sink.finished.Load() == 0 {
		return "", errors.New("系统未确认文件已移入回收站")
	}
	return "", hresult(uintptr(sink.deleteHR.Load()))
}

// PreDeleteItem prevents the Shell from falling back to a permanent delete.
// The remaining callbacks preserve COM's exact vtable order and signatures.
type recycleSink struct {
	table    *[19]uintptr
	refs     atomic.Int32
	blocked  atomic.Uint32
	finished atomic.Uint32
	deleteHR atomic.Uint32
}

var sinkTable = [19]uintptr{
	syscall.NewCallback(func(s *recycleSink, iid *windows.GUID, out **recycleSink) uintptr {
		*out = nil
		if *iid != iidUnknown && *iid != iidProgressSink {
			return eNoInterface
		}
		*out = s
		s.refs.Add(1)
		return 0
	}),
	syscall.NewCallback(func(s *recycleSink) uintptr { return uintptr(s.refs.Add(1)) }),
	syscall.NewCallback(func(s *recycleSink) uintptr { return uintptr(s.refs.Add(-1)) }),
	syscall.NewCallback(func(s *recycleSink) uintptr { return 0 }),                            // StartOperations
	syscall.NewCallback(func(s *recycleSink, hr uintptr) uintptr { return 0 }),                // FinishOperations
	syscall.NewCallback(func(s *recycleSink, flags, item, name uintptr) uintptr { return 0 }), // PreRenameItem
	syscall.NewCallback(func(s *recycleSink, flags, item, name, hr, created uintptr) uintptr { return 0 }),
	syscall.NewCallback(func(s *recycleSink, flags, item, destination, name uintptr) uintptr { return 0 }), // PreMoveItem
	syscall.NewCallback(func(s *recycleSink, flags, item, destination, name, hr, created uintptr) uintptr { return 0 }),
	syscall.NewCallback(func(s *recycleSink, flags, item, destination, name uintptr) uintptr { return 0 }), // PreCopyItem
	syscall.NewCallback(func(s *recycleSink, flags, item, destination, name, hr, created uintptr) uintptr { return 0 }),
	syscall.NewCallback(preDelete),
	syscall.NewCallback(func(s *recycleSink, flags, item, hr, created uintptr) uintptr {
		s.deleteHR.Store(uint32(hr))
		s.finished.Store(1)
		return 0
	}),
	syscall.NewCallback(func(s *recycleSink, flags, destination, name uintptr) uintptr { return 0 }), // PreNewItem
	syscall.NewCallback(func(s *recycleSink, flags, destination, name, template, attrs, hr, created uintptr) uintptr { return 0 }),
	syscall.NewCallback(func(s *recycleSink, total, complete uintptr) uintptr { return 0 }), // UpdateProgress
	syscall.NewCallback(func(s *recycleSink) uintptr { return 0 }),                          // ResetTimer
	syscall.NewCallback(func(s *recycleSink) uintptr { return 0 }),                          // PauseTimer
	syscall.NewCallback(func(s *recycleSink) uintptr { return 0 }),                          // ResumeTimer
}

func preDelete(s *recycleSink, flags, item uintptr) uintptr {
	if flags&recycleTransferFlag == 0 {
		s.blocked.Store(1)
		return eFail
	}
	return 0
}
