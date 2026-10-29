package main

import "testing"

func TestSkillLinkOnlyQueuesExactVersion(t *testing.T) {
	link := "beeftv://skills/install?id=official-storyboard-text&version=r_123"
	route, err := skillLinkRoute(link)
	if err != nil || route != "/skills?releaseId=r_123&skillId=official-storyboard-text" {
		t.Fatalf("%q %v", route, err)
	}
	app := newDesktopApp(t.TempDir())
	app.queueSkillLink(link)
	if got := app.ConsumeSkillLink(); got != route {
		t.Fatalf("lost startup link: %s", got)
	}
	if app.ConsumeSkillLink() != "" {
		t.Fatal("link consumed twice")
	}
	if app.runtime() != nil {
		t.Fatal("link started backend or installed a package")
	}
	if err := validateDesktopArgs([]string{link}); err != nil {
		t.Fatal(err)
	}
}

func TestSkillLinkRejectsAmbiguousOrExecutableInput(t *testing.T) {
	for _, raw := range []string{"https://skills/install?id=a&version=b", "beeftv://evil/install?id=a&version=b", "beeftv://skills/install?id=a", "beeftv://skills/install?id=a&version=b&version=c", "beeftv://skills/install?id=a&version=b&install=true", "beeftv://skills/install?id=..%2fa&version=b", "beeftv://skills/install?id=a&version=b#auto", "beeftv://user@skills/install?id=a&version=b", "beeftv://skills/install?id=a&version=", "beeftv://skills/install?id=a&version=b%00"} {
		if _, err := skillLinkRoute(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	if skillInstanceID("one") == skillInstanceID("two") {
		t.Fatal("isolated data directories share lock")
	}
}

func TestSkillWebsiteLinksStayOnTheSkillSite(t *testing.T) {
	for _, raw := range []string{"https://beeftv.app/skills/mine", "https://beeftv.app/skills/authorize?user_code=ABCDE", "http://127.0.0.1:4186/skills/submissions/d_1"} {
		if !validSkillWebsite(raw) {
			t.Errorf("rejected %q", raw)
		}
	}
	for _, raw := range []string{"https://evil.test/skills", "https://beeftv.app.evil.test/skills", "https://beeftv.app/account", "javascript:alert(1)", "https://user@beeftv.app/skills", "file:///skills", "https://beeftv.app/skills/../account", "https://beeftv.app/skills/%2e%2e/account", "https://beeftv.app/skills/%5c..%5caccount"} {
		if validSkillWebsite(raw) {
			t.Errorf("accepted %q", raw)
		}
	}
}
