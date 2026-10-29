package bootstrap

import (
	"context"
	"testing"
)

func TestDesktopSchemaExcludesHostedTables(t *testing.T) {
	runtime, err := Open(context.Background(), Config{Profile: ProfileDesktop, DataDir: t.TempDir(), ListenAddr: "127.0.0.1:0", AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	for _, table := range []string{
		"auth_sessions", "user_identities", "oauth_states", "email_verification_codes",
		"credit_accounts", "credit_ledger_entries", "billing_orders", "payment_orders",
		"payment_provider_configs", "redeem_codes", "user_oss_settings", "storage_locations",
		"announcements", "canvas_shares", "admin_audit_events",
	} {
		if runtime.db.Migrator().HasTable(table) {
			t.Fatalf("desktop schema contains hosted table %s", table)
		}
	}
}
