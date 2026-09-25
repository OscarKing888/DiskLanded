//go:build linux || darwin

package scan

import (
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func denyAccess(t *testing.T, p string) func() {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses permission checks; run as a normal user")
	}
	if err := os.Chmod(p, 0); err != nil {
		t.Fatal(err)
	}
	return func() { os.Chmod(p, 0o755) }
}

func times(t *testing.T, p string) [2]time.Time {
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		t.Fatal(err)
	}
	return [2]time.Time{time.Unix(unix.TimespecToNsec(st.Atim)/1e9, unix.TimespecToNsec(st.Atim)%1e9),
		time.Unix(unix.TimespecToNsec(st.Mtim)/1e9, unix.TimespecToNsec(st.Mtim)%1e9)}
}
