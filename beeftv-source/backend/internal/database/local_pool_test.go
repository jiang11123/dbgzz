package database

import (
	"fmt"
	"sync"
	"testing"

	"gorm.io/gorm"
)

type contentionRow struct {
	ID    int `gorm:"primaryKey"`
	Value string
}

func TestSQLitePoolUsesSingleWriterWithoutLockFailures(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := ConfigurePool(db); err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	if got := sqlDB.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("SQLite MaxOpenConnections = %d, want 1", got)
	}
	if err := db.AutoMigrate(&contentionRow{}); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	errorsFound := make(chan error, 32)
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			err := db.Transaction(func(tx *gorm.DB) error {
				return tx.Create(&contentionRow{ID: index + 1, Value: fmt.Sprint(index)}).Error
			})
			if err != nil {
				errorsFound <- err
			}
		}(index)
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Fatalf("concurrent SQLite writer failed: %v", err)
	}
}
