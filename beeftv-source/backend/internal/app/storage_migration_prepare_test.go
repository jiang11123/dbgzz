package app

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestBusyMigrationKeepsOriginalWorkspaceAndTasksUsable(t *testing.T) {
	s, db := retiredAgentProductService(t)
	workers := s.backgroundWorkers()
	ctx, _ := workers.Start()
	release := make(chan struct{})
	defer func() {
		close(release)
		stop, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = workers.Stop(stop)
	}()
	workers.GoTask(func() { <-release })
	resume, err := s.PrepareStorageMigration(context.Background())
	if err == nil || resume != nil || !strings.Contains(err.Error(), "画布任务面板") {
		t.Fatalf("busy preflight=%v", err)
	}
	if workers.IsDraining() || ctx.Err() != nil {
		t.Fatal("rejected migration stopped the original worker")
	}
	if err := db.Exec("SELECT 1").Error; err != nil {
		t.Fatal("rejected migration closed original DB", err)
	}
}

func TestMigrationPreparationCanResumeWithoutKillingWorkers(t *testing.T) {
	s, _ := retiredAgentProductService(t)
	workers := s.backgroundWorkers()
	ctx, _ := workers.Start()
	resume, err := s.PrepareStorageMigration(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if workers.GoTask(func() {}) || ctx.Err() != nil {
		t.Fatal("migration must fence new work without cancelling loops")
	}
	resume()
	if workers.IsDraining() || !workers.GoTask(func() {}) {
		t.Fatal("failed preparation could not resume")
	}
	stop, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := workers.Stop(stop); err != nil {
		t.Fatal(err)
	}
}
