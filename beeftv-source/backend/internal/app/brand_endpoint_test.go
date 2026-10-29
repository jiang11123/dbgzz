package app

import (
	"context"
	"testing"
)

func TestBothDesktopBrandsKeepSeedanceContracts(t *testing.T) {
	for _, origin := range []string{"https://beeftv.app", "https://enterprise.beefapi.com"} {
		config := providerConfig{BaseURL: origin, Model: "seedance-2.0", InterfaceType: "newapi"}
		if !isBeefAPIVideoConfig(context.Background(), config) || !isBeefAPISeedancePreuploadConfig(context.Background(), config) {
			t.Fatalf("missing video or preupload contract for %s", origin)
		}
		if got := providerDownloadURL(origin, "https://beefapi.com/v1/videos/task/content"); got != origin+"/v1/videos/task/content" {
			t.Fatalf("download origin = %s", got)
		}
	}
}
