package trash

import "testing"

func TestRejectPermanentDelete(t *testing.T) {
	sink := &recycleSink{}
	if hr := preDelete(sink, 0, 0); hr != eFail || sink.blocked.Load() == 0 {
		t.Fatal("permanent delete was not blocked")
	}
	if hr := preDelete(&recycleSink{}, recycleTransferFlag, 0); hr != 0 {
		t.Fatal("recycling was blocked")
	}
}

func TestHRESULT(t *testing.T) {
	for _, hr := range []uintptr{0, 1} {
		if err := hresult(hr); err != nil {
			t.Fatalf("success HRESULT: %v", err)
		}
	}
	if hresult(eFail) == nil {
		t.Fatal("failure HRESULT was accepted")
	}
}
