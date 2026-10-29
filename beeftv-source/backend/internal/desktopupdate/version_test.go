package desktopupdate

import "testing"

func TestCompareStableRejectsEqualAndDowngrade(t *testing.T) {
	cmp, err := compareStable("v1.5.1", "v1.5.1")
	if err != nil || cmp != 0 {
		t.Fatalf("equal = %d %v", cmp, err)
	}
	cmp, err = compareStable("v1.5.1", "v1.4.0")
	if err != nil || cmp <= 0 {
		t.Fatalf("downgrade = %d %v", cmp, err)
	}
	cmp, err = compareStable("v1.5.1", "v1.6.0")
	if err != nil || cmp >= 0 {
		t.Fatalf("upgrade = %d %v", cmp, err)
	}
	cmp, err = compareStable("dev", "v1.6.0")
	if err != nil || cmp >= 0 {
		t.Fatalf("dev = %d %v", cmp, err)
	}
}
