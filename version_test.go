package main

import (
	"regexp"
	"testing"
)

func TestVersionFormat(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+(\.\d+)?$`).MatchString(appVersion) {
		t.Fatalf("VERSION %q is not like 0.1 or 0.1.2", appVersion)
	}
}
