package trash

/*
#cgo LDFLAGS: -framework Foundation
#include <stdlib.h>
int disklanded_trash(const char *path, char **destination, char **message);
*/
import "C"

import (
	"errors"
	"unsafe"
)

func move(path string) (string, error) {
	p := C.CString(path)
	defer C.free(unsafe.Pointer(p))
	var destination, message *C.char
	ok := C.disklanded_trash(p, &destination, &message)
	defer C.free(unsafe.Pointer(destination))
	defer C.free(unsafe.Pointer(message))
	if ok == 0 {
		return "", errors.New(C.GoString(message))
	}
	return C.GoString(destination), nil
}
