package scan

import (
	"os"
	"os/exec"
	"os/user"
	"syscall"
	"testing"
	"time"
)

// denyAccess adds a deny ACE for the current user so listing the directory
// fails with ERROR_ACCESS_DENIED.
func denyAccess(t *testing.T, p string) func() {
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("icacls", p, "/deny", "*"+u.Uid+":(OI)(CI)(RX)").CombinedOutput()
	if err != nil {
		t.Fatalf("icacls deny: %v %s", err, out)
	}
	return func() {
		exec.Command("icacls", p, "/remove:d", "*"+u.Uid).Run()
		os.RemoveAll(p)
	}
}

func times(t *testing.T, p string) [2]time.Time {
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	d := fi.Sys().(*syscall.Win32FileAttributeData)
	return [2]time.Time{time.Unix(0, d.LastAccessTime.Nanoseconds()), time.Unix(0, d.LastWriteTime.Nanoseconds())}
}
