package editing

import "testing"

func TestParseProbeSecondsAcceptsFinitePositive(t *testing.T) {
	seconds, err := parseProbeSeconds("1.250")
	if err != nil || seconds != 1.25 {
		t.Fatalf("seconds=%v err=%v", seconds, err)
	}
}

func TestParseProbeSecondsRejectsNonFinite(t *testing.T) {
	for _, raw := range []string{"", "N/A", "n/a", "NaN", "nan", "Inf", "+Inf", "-Inf", "0", "-1", "abc"} {
		if seconds, err := parseProbeSeconds(raw); err == nil {
			t.Fatalf("%q accepted as %v", raw, seconds)
		}
	}
}
