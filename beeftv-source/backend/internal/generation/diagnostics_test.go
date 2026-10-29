package generation

import (
	"strings"
	"testing"
)

func TestDiagnosticSummaryHidesMountedAndNetworkPaths(t *testing.T) {
	for _, path := range []string{`/Volumes/PrivateDrive/customer-A/image.png`, `/Volumes/External Work/customer-A/image.png`, `C:\Private User\customer-A\image.png`, `\\Private Server\Private Share\customer-A\image.png`, `/mnt/PrivateDrive/customer-A/image.png`, `/media/PrivateDrive/customer-A/image.png`, `\\PrivateServer\PrivateShare\customer-A\image.png`} {
		got := DiagnosticSummary("open " + path + ": permission denied")
		if strings.Contains(got, "Private") || strings.Contains(got, "customer-A") || !strings.Contains(got, "permission denied") {
			t.Fatalf("unsafe summary %q", got)
		}
	}
}
