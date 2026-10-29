package providerpreset

import "strings"

func SeedreamFamily(model string) string {
	for _, item := range []struct{ prefix, family string }{{"dola-seedream-5-0-pro-", "pro"}, {"dola-seedream-5-0-flash-", "flash"}, {"seedream-5-0-", "lite"}, {"seedream-4-5-", "4.5"}, {"seedream-4-0-", "4.0"}} {
		if strings.HasPrefix(model, item.prefix) {
			return item.family
		}
	}
	return ""
}
