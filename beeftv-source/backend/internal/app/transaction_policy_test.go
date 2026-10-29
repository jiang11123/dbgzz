package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestCanvasHostSkipsStorageMutexInsideTransactionAndStillSeesTxQuota(t *testing.T) {
	s, db := newTimelineTaskTestService(t)
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	pool.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = pool.Close() })

	s.storageMu.Lock()
	held := true
	t.Cleanup(func() {
		if held {
			s.storageMu.Unlock()
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Create(&model.CanvasProject{ID: "quota-tx-canvas", UserID: "user", Title: "tx", PayloadJSON: "abcd"}).Error; err != nil {
				return err
			}
			repo := s.repo.WithTx(tx)
			if !repoHoldsTransaction(repo) {
				return errors.New("WithTx repo must be a TxCommitter")
			}
			host := newCanvasHostWithRepo(s, repo)
			txUsage, err := repo.UserStorageUsage("user")
			if err != nil {
				return err
			}
			if txUsage.CanvasCount != 1 || txUsage.CanvasBytes < 4 {
				return fmt.Errorf("tx usage must see uncommitted canvas, tx=%#v", txUsage)
			}
			policy, err := s.runtimePolicyWithRepo(repo)
			if err != nil {
				return err
			}
			delta := megabytes(policy.Resource.StructuredDataMB)
			if err := host.WithStorageLock(func() error {
				return host.StructuredQuota("user", "canvas", false, delta)
			}); err == nil {
				return errors.New("structured quota ignored in-transaction usage")
			}
			return nil
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("事务内 WithStorageLock 仍在等根 storageMu")
	}
	s.storageMu.Unlock()
	held = false
}

func TestCanvasQuotaReadsPolicyFromItsTransaction(t *testing.T) {
	s, db := newTimelineTaskTestService(t)
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.repo = repository.New(db.WithContext(ctx))
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Only this transaction sees the invalid policy. Returning a root/default
		// policy would either permit this write or wait for our own connection.
		if err := tx.Create(&model.SystemSetting{Key: "runtime_policy", ValueJSON: "{"}).Error; err != nil {
			return err
		}
		repo := s.repo.WithTx(tx)
		host := newCanvasHostWithRepo(s, repo)
		for _, check := range []func() error{
			func() error { return host.StructuredQuota("user", "canvas", false, 1) },
			func() error { return host.StructuredBatchQuota("user", "asset", 1, 1) },
			func() error { return host.StructuredReplacementQuota("user", "asset", 1, 1) },
			func() error { return (creationQuotaAdapter{s}).ValidateCanvas("user", repo, false, 1) },
		} {
			if err := check(); err == nil || !strings.Contains(err.Error(), "配置格式无效") {
				t.Fatalf("expected in-transaction policy rejection, got %v", err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
