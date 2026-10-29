package bootstrap

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestDesktopDependencyBoundary keeps hosted infrastructure out of the local
// desktop binary.  The test intentionally inspects the compiler dependency
// graph instead of source text so optional tooling can evolve independently.
func TestDesktopDependencyBoundary(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate backend module")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	command := exec.Command("go", "list", "-deps", "./cmd/desktop")
	command.Dir = moduleRoot
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("go list desktop dependencies: %v\n%s", err, output)
	}

	dependencies := "\n" + string(output) + "\n"
	for _, forbidden := range []string{
		"gorm.io/driver/postgres",
		"github.com/redis/go-redis/v9",
		"github.com/aws/aws-sdk-go/aws",
		"github.com/qiniu/go-sdk/v7",
		"github.com/tencentyun/cos-go-sdk-v5",
		"infinite-canvas/backend/internal/payment",
		"infinite-canvas/backend/payment-sdk",
		"infinite-canvas/backend/internal/auth",
		"infinite-canvas/backend/internal/hostupdate",
		"infinite-canvas/backend/internal/updaterclient",
	} {
		if strings.Contains(dependencies, "\n"+forbidden+"\n") {
			t.Errorf("desktop dependency graph contains hosted infrastructure %q", forbidden)
		}
	}
}

func TestDesktopBinaryExcludesTaskBillingRuntime(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate backend module")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	binaryPath := filepath.Join(t.TempDir(), "beeftv-desktop")
	build := exec.Command("go", "build", "-o", binaryPath, "./cmd/desktop")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build desktop binary: %v\n%s", err, output)
	}
	nm := exec.Command("go", "tool", "nm", binaryPath)
	nm.Dir = moduleRoot
	output, err := nm.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect desktop binary: %v\n%s", err, output)
	}
	for _, forbidden := range []string{"taskBillingCoordinator", "localTaskBillingLifecycle"} {
		if strings.Contains(string(output), forbidden) {
			t.Errorf("desktop binary contains removed task billing runtime %q", forbidden)
		}
	}
	if _, err := os.Stat(binaryPath); err != nil {
		t.Fatalf("desktop binary missing after inspection: %v", err)
	}
}

func TestDesktopBinaryExcludesHostedStorageControlPlane(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate backend module")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	binaryPath := filepath.Join(t.TempDir(), "beeftv-desktop")
	build := exec.Command("go", "build", "-o", binaryPath, "./cmd/desktop")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build desktop binary: %v\n%s", err, output)
	}
	nm := exec.Command("go", "tool", "nm", binaryPath)
	nm.Dir = moduleRoot
	output, err := nm.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect desktop binary: %v\n%s", err, output)
	}
	for _, forbidden := range []string{
		"(*Service).AdminOSSSetting",
		"(*Service).UpdateOSSSetting",
		"(*Service).UpdateUserOSSSetting",
		"(*Service).TestAdminOSSSetting",
		"(*Service).TestUserOSSSetting",
		"(*Service).ossSettingForResource",
		"signedAliyunOSSObjectURL",
	} {
		if strings.Contains(string(output), forbidden) {
			t.Errorf("desktop binary contains hosted storage control plane %q", forbidden)
		}
	}
}

func TestDesktopBinaryExcludesHostedBillingControlPlane(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate backend module")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	binaryPath := filepath.Join(t.TempDir(), "beeftv-desktop")
	build := exec.Command("go", "build", "-o", binaryPath, "./cmd/desktop")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build desktop binary: %v\n%s", err, output)
	}
	nm := exec.Command("go", "tool", "nm", binaryPath)
	nm.Dir = moduleRoot
	output, err := nm.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect desktop binary: %v\n%s", err, output)
	}
	for _, forbidden := range []string{
		"(*Service).Wallet", "(*Service).RedeemCredits", "(*Service).AdminAdjustCredits",
		"(*Service).AdminBillingOrderPage", "(*Service).ReserveProxyBilling",
		"(*Service).MarkBillingRunning", "(*Service).SettleBilling", "(*Service).RefundBilling",
		"(*Service).AuditBillingReview", "(*Service).taskBillingOrder",
	} {
		if strings.Contains(string(output), forbidden) {
			t.Errorf("desktop binary contains hosted billing control plane %q", forbidden)
		}
	}
}

func TestDesktopBinaryExcludesHostedAdminSurface(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate backend module")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	binaryPath := filepath.Join(t.TempDir(), "beeftv-desktop")
	build := exec.Command("go", "build", "-o", binaryPath, "./cmd/desktop")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build desktop binary: %v\n%s", err, output)
	}
	nm := exec.Command("go", "tool", "nm", binaryPath)
	nm.Dir = moduleRoot
	output, err := nm.CombinedOutput()
	if err != nil {
		t.Fatalf("inspect desktop binary: %v\n%s", err, output)
	}
	for _, forbidden := range []string{
		"(*Service).AdminUsers", "(*Service).AdminAnalytics",
		"(*Service).AdminAnalyticsCSV", "(*Service).AdminStorageStats",
	} {
		if strings.Contains(string(output), forbidden) {
			t.Errorf("desktop binary contains hosted admin surface %q", forbidden)
		}
	}
}

func TestLocalSourceExcludesHostedContentVerticals(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate backend module")
	}
	moduleRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	for _, relative := range []string{
		"internal/canvas/canvas_share.go",
		"internal/repository/announcement.go",
		"internal/repository/announcement_image.go",
		"internal/app/settings.go",
		"internal/app/storage_location.go",
		"internal/app/storage_s3.go",
		"internal/app/admin_storage.go",
		"internal/app/admin_storage_delete.go",
		"internal/app/analytics.go",
		"internal/handler/admin_storage.go",
		"internal/repository/oauth.go",
		"internal/database/schema.go",
		"internal/database/migrations.go",
		"internal/app/admin_bulk_user_test.go",
		"internal/handler/admin_system_performance.go",
		"internal/handler/logical_models.go",
		"internal/handler/response_interception.go",
		"internal/handler/channel_order.go",
	} {
		if _, err := os.Stat(filepath.Join(moduleRoot, relative)); err == nil {
			t.Errorf("local-only source still contains hosted content vertical %q", relative)
		} else if !os.IsNotExist(err) {
			t.Fatalf("inspect %s: %v", relative, err)
		}
	}

	modelSource, err := os.ReadFile(filepath.Join(moduleRoot, "internal/model/models_project.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"type CanvasShare struct",
		"type Announcement struct",
		"type AnnouncementImageDraft struct",
		"type UserAnnouncementRead struct",
		"type BannerAnnouncement struct",
	} {
		if strings.Contains(string(modelSource), forbidden) {
			t.Errorf("local-only models still contain hosted type %q", forbidden)
		}
	}

	platformSource, err := os.ReadFile(filepath.Join(moduleRoot, "internal/model/models_platform.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"type UserOSSSetting struct", "type StorageLocation struct"} {
		if strings.Contains(string(platformSource), forbidden) {
			t.Errorf("local-only models still contain hosted storage type %q", forbidden)
		}
	}

	resourceSource, err := os.ReadFile(filepath.Join(moduleRoot, "internal/app/resource.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"func putOSSObject", "func getOSSObjectRange", "func signedOSSObjectURL", "func newOSSRequest"} {
		if strings.Contains(string(resourceSource), forbidden) {
			t.Errorf("local resource kernel still contains cloud storage implementation %q", forbidden)
		}
	}

	identitySource, err := os.ReadFile(filepath.Join(moduleRoot, "internal/model/models_identity.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"PasswordHash", "LastLoginAt", "type AuthSession struct", "type UserIdentity struct",
		"type OAuthState struct", "type EmailVerificationCode struct",
	} {
		if strings.Contains(string(identitySource), forbidden) {
			t.Errorf("local identity compatibility model still contains hosted member %q", forbidden)
		}
	}
}
