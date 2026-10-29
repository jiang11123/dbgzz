package project

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestChapterApplyReceiptSamePayloadReplayDoesNotOverwriteLaterEdits(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-storyboard-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})

	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{},
		ExpectedRevision: revision,
		Shots:            storyboardReplaceShots("SC.01", "生成画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("created = %d, want 1", len(created))
	}
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, created[0].ID, ShotRevisionInput{PlotDescription: "用户后来改的画面", DurationMs: 3200}); err != nil {
		t.Fatal(err)
	}

	replayed, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{created[0].ID},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            storyboardReplaceShots("SC.01", "生成画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 || replayed[0].ID != created[0].ID {
		t.Fatalf("replayed shots = %#v, want original receipt", replayed)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Description != "用户后来改的画面" {
		t.Fatalf("description = %q, want 用户后来改的画面", stored.Description)
	}
	assertSingleChapterApplyReceipt(t, db, "user-1", "task-storyboard-1")
}

func TestChapterApplyDifferentPayloadSameIdentityConflicts(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-storyboard-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{},
		ExpectedRevision: revision,
		Shots:            storyboardReplaceShots("SC.01", "第一份画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{created[0].ID},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            storyboardReplaceShots("SC.99", "另一份画面"),
	})
	if err == nil {
		t.Fatal("different payload reused identity")
	}
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != kernel.CodeConflict || appErr.Reason != kernel.ErrorReason("operation_id_reused_with_different_payload") {
		t.Fatalf("conflict = %#v", err)
	}
	if appErr.Message != "这份结果已经按另一份内容写入，不能再覆盖" {
		t.Fatalf("message = %q", appErr.Message)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Description != "第一份画面" {
		t.Fatalf("description = %q, want 第一份画面", stored.Description)
	}
}

func TestChapterApplyFailedFirstWriteLeavesNoReceiptThenReviewSnapshotSucceeds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chapter-apply-interrupt.db")
	svc, db := openFileProjectService(t, path)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	original, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            storyboardReplaceShots("SC.01", "批准时的画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	approvedRevision := ownedRevision(t, svc, project.ID)
	approvedShotIDs := []string{original[0].ID}
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-storyboard-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: approvedRevision, ApprovedShotIDs: approvedShotIDs,
	})
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, original[0].ID, ShotRevisionInput{PlotDescription: "生成期间改过的画面", DurationMs: 3000}); err != nil {
		t.Fatal(err)
	}

	_, err = svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  approvedShotIDs,
		ExpectedRevision: approvedRevision,
		Shots:            storyboardReplaceShots("SC.02", "新生成画面"),
	})
	if err == nil {
		t.Fatal("stale original snapshot overwrote later edits")
	}
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != kernel.CodeConflict {
		t.Fatalf("stale apply = %#v", err)
	}
	if appErr.Reason != kernel.ReasonProjectUnitShotsChanged && appErr.Reason != kernel.ReasonProjectRevisionConflict {
		t.Fatalf("stale apply reason = %s", appErr.Reason)
	}
	assertNoChapterApplyReceipt(t, db, "user-1", "task-storyboard-1")
	closeDB(t, db)

	svc, db = openFileProjectService(t, path)
	assertNoChapterApplyReceipt(t, db, "user-1", "task-storyboard-1")
	reviewedRevision := ownedRevision(t, svc, project.ID)
	reviewed, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{original[0].ID},
		ExpectedRevision: reviewedRevision,
		Shots:            storyboardReplaceShots("SC.02", "新生成画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(reviewed) != 1 || reviewed[0].Description != "新生成画面" {
		t.Fatalf("reviewed shots = %#v", reviewed)
	}
	assertSingleChapterApplyReceipt(t, db, "user-1", "task-storyboard-1")
}

func TestChapterApplyReceiptSurvivesSQLiteRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chapter-apply.db")
	svc, db := openFileProjectService(t, path)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-storyboard-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	created, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{},
		ExpectedRevision: revision,
		Shots:            storyboardReplaceShots("SC.01", "持久画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	closeDB(t, db)

	svc, db = openFileProjectService(t, path)
	if _, _, err := svc.CreateShotRevision("user-1", project.ID, created[0].ID, ShotRevisionInput{PlotDescription: "重启后用户又改了", DurationMs: 3000}); err != nil {
		t.Fatal(err)
	}
	replayed, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{created[0].ID},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            storyboardReplaceShots("SC.01", "持久画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if replayed[0].ID != created[0].ID {
		t.Fatalf("restart replay = %#v", replayed)
	}
	var stored model.Shot
	if err := db.First(&stored, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Description != "重启后用户又改了" {
		t.Fatalf("description = %q, want 重启后用户又改了", stored.Description)
	}
	receipts, err := svc.ChapterApplyReceipts("user-1", project.ID, []string{"task-storyboard-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 1 || !receipts[0].Applied || receipts[0].TaskID != "task-storyboard-1" {
		t.Fatalf("receipts = %#v", receipts)
	}
}

func TestChapterApplySourceTaskIsNotAForgeableCredential(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	other := seedProject(t, db, model.Project{ID: "project-2", UserID: "user-1", Name: "另一项目"})
	unit := seedChapter(t, svc, project.ID)
	otherUnit := seedChapter(t, svc, other.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-other-user", UserID: "user-2", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-other-project", UserID: "user-1", ProjectID: other.ID, ChapterID: otherUnit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: ownedRevision(t, svc, other.ID),
	})
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-running", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision, Status: model.TaskStatusRunning,
	})
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-characters", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyCharacters, ApprovedRevision: revision,
	})

	req := ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: revision,
		Shots:            storyboardReplaceShots("SC.01", "画面"),
	}
	req.SourceTaskID = "task-other-user"
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, req); !IsNotFound(err) && err.Error() != "找不到对应的生成任务" {
		t.Fatalf("foreign owner = %v", err)
	}
	req.SourceTaskID = "task-other-project"
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, req); err == nil {
		t.Fatal("foreign project task applied")
	}
	req.SourceTaskID = "task-running"
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, req); err == nil || err.Error() != "生成尚未完成，不能写入结果" {
		t.Fatalf("running task = %v", err)
	}
	req.SourceTaskID = "task-characters"
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, req); err == nil {
		t.Fatal("character task applied as storyboard")
	}
	assertNoChapterApplyReceipt(t, db, "user-1", "task-other-user")
}

func TestChapterApplyConcurrentCASKeepsOneReceipt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chapter-apply-cas.db")
	svc, db := openFileProjectService(t, path)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-a", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-b", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(4)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, taskID := range []string{"task-a", "task-b"} {
		workers.Add(1)
		go func(taskID string) {
			defer workers.Done()
			<-start
			_, applyErr := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
				SourceTaskID:     taskID,
				ExpectedShotIDs:  []string{},
				ExpectedRevision: revision,
				Shots:            storyboardReplaceShots("SC.01", taskID),
			})
			results <- applyErr
		}(taskID)
	}
	close(start)
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for applyErr := range results {
		if applyErr == nil {
			successes++
			continue
		}
		var appErr *kernel.AppError
		if errors.As(applyErr, &appErr) && appErr.Status == kernel.CodeConflict {
			conflicts++
			continue
		}
		if errors.Is(applyErr, repository.ErrProjectUnitShotsChanged) || errors.Is(applyErr, repository.ErrProjectRevisionConflict) {
			conflicts++
			continue
		}
		t.Fatal(applyErr)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	var receiptCount int64
	if err := db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND status = ?", "user-1", "succeeded").Count(&receiptCount).Error; err != nil {
		t.Fatal(err)
	}
	if receiptCount != 1 {
		t.Fatalf("receipts = %d, want 1", receiptCount)
	}
}

func TestChapterApplySameIdentityConcurrentReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chapter-apply-replay.db")
	svc, db := openFileProjectService(t, path)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-storyboard-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(4)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, applyErr := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
				SourceTaskID:     "task-storyboard-1",
				ExpectedShotIDs:  []string{},
				ExpectedRevision: revision,
				Shots:            storyboardReplaceShots("SC.01", "同一份画面"),
			})
			results <- applyErr
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	successes := 0
	for applyErr := range results {
		if applyErr == nil {
			successes++
			continue
		}
		var appErr *kernel.AppError
		if errors.As(applyErr, &appErr) && appErr.Reason == kernel.ErrorReason("operation_in_progress") {
			continue
		}
		t.Fatal(applyErr)
	}
	if successes < 1 {
		t.Fatal("same identity produced no successful apply")
	}
	replayed, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            storyboardReplaceShots("SC.01", "同一份画面"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 {
		t.Fatalf("replayed = %#v", replayed)
	}
	var shotCount int64
	if err := db.Model(&model.Shot{}).Where("project_id = ? AND unit_id = ?", project.ID, unit.ID).Count(&shotCount).Error; err != nil {
		t.Fatal(err)
	}
	if shotCount != 1 {
		t.Fatalf("shots = %d, want 1", shotCount)
	}
	assertSingleChapterApplyReceipt(t, db, "user-1", "task-storyboard-1")
}

func TestChapterCharacterApplyUsesReceiptNotTimestamp(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-characters-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyCharacters,
	})
	details := validChapterCharacterDetails()
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source:       AssetCandidateSourceChapterCharacter,
		SourceTaskID: "task-characters-1",
		Candidates:   []AssetCandidateInput{{UnitID: unit.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter), Details: details}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("created = %d, want 1", len(created))
	}
	if err := db.Model(&model.ProjectAssetCandidate{}).Where("id = ?", created[0].ID).Update("updated_at", time.Now().Add(time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
	replayed, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source:       AssetCandidateSourceChapterCharacter,
		SourceTaskID: "task-characters-1",
		Candidates:   []AssetCandidateInput{{UnitID: unit.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter), Details: details}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 || replayed[0].ID != created[0].ID {
		t.Fatalf("replayed = %#v", replayed)
	}
	var count int64
	if err := db.Model(&model.ProjectAssetCandidate{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("candidates = %d, want 1", count)
	}
	_, err = svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source:       AssetCandidateSourceChapterCharacter,
		SourceTaskID: "task-characters-1",
		Candidates:   []AssetCandidateInput{{UnitID: unit.ID, Name: "猎人", Category: string(model.AssetCategoryCharacter), Details: details}},
	})
	if err == nil {
		t.Fatal("different payload reused character identity")
	}
}

func TestChapterApplyShotsChangedReturnsStableReason(t *testing.T) {
	err := mapChapterApplyWriteError(repository.ErrProjectUnitShotsChanged)
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != kernel.CodeConflict || appErr.Reason != kernel.ReasonProjectUnitShotsChanged {
		t.Fatalf("mapped = %#v", err)
	}
	if appErr.Message != "本章分镜已发生变化，请刷新后重新确认" {
		t.Fatalf("message = %q", appErr.Message)
	}
	if !IsConflict(err) {
		t.Fatal("mapped shots-changed is not a conflict")
	}
}

func TestChapterApplyRevisionConflictReturnsStableReason(t *testing.T) {
	err := mapChapterApplyWriteError(repository.ErrProjectRevisionConflict)
	var appErr *kernel.AppError
	if !errors.As(err, &appErr) || appErr.Status != kernel.CodeConflict || appErr.Reason != kernel.ReasonProjectRevisionConflict {
		t.Fatalf("mapped = %#v", err)
	}
	if appErr.Message != "项目已被其他操作更新，请重新加载后再保存" {
		t.Fatalf("message = %q", appErr.Message)
	}
}

func TestChapterCharacterEmptyExtractWritesReceipt(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-characters-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyCharacters,
	})
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source:       AssetCandidateSourceChapterCharacter,
		SourceTaskID: "task-characters-1",
		Candidates:   nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 0 {
		t.Fatalf("created = %#v", created)
	}
	assertSingleChapterApplyReceipt(t, db, "user-1", "task-characters-1")
	receipts, err := svc.ChapterApplyReceipts("user-1", project.ID, []string{"task-characters-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 1 || !receipts[0].Applied || receipts[0].Kind != chapterApplyKindCharacters {
		t.Fatalf("receipts = %#v", receipts)
	}
}

func TestChapterApplyReceiptsStayOnOwningProject(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	other := seedProject(t, db, model.Project{ID: "project-2", UserID: "user-1", Name: "另一项目"})
	unit := seedChapter(t, svc, project.ID)
	revision := ownedRevision(t, svc, project.ID)
	seedSucceededChapterTask(t, db, chapterTaskSeed{
		ID: "task-storyboard-1", UserID: "user-1", ProjectID: project.ID, ChapterID: unit.ID,
		Kind: chapterApplyStoryboard, ApprovedRevision: revision,
	})
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		SourceTaskID:     "task-storyboard-1",
		ExpectedShotIDs:  []string{},
		ExpectedRevision: revision,
		Shots:            storyboardReplaceShots("SC.01", "画面"),
	}); err != nil {
		t.Fatal(err)
	}
	receipts, err := svc.ChapterApplyReceipts("user-1", other.ID, []string{"task-storyboard-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 0 {
		t.Fatalf("foreign project receipts = %#v", receipts)
	}
}

func TestChapterApplyReceiptRejectsCorruptIdentity(t *testing.T) {
	for _, raw := range []string{"", "{", `{}`, `{"taskId":"other","projectId":"project-1","unitId":"unit-1","kind":"storyboard"}`} {
		t.Run(raw, func(t *testing.T) {
			svc, db := newTestService(t, nil)
			seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
			record := model.AgentOpRecord{UserID: "user-1", OpID: chapterApplyOpID("task-1"), Op: ChapterApplyOpStoryboard, Status: "succeeded", ResultJSON: raw}
			if err := db.Create(&record).Error; err != nil {
				t.Fatal(err)
			}
			if receipts, err := svc.ChapterApplyReceipts("user-1", "project-1", []string{"task-1"}); err == nil || len(receipts) != 0 {
				t.Fatalf("corrupt receipt reported applied: %#v, %v", receipts, err)
			}
		})
	}
}

func TestReplaceWithoutSourceTaskDoesNotWriteReceipt(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	if _, err := svc.ReplaceProjectUnitShots("user-1", project.ID, unit.ID, ReplaceProjectUnitShotsRequest{
		ExpectedShotIDs:  []string{},
		ExpectedRevision: ownedRevision(t, svc, project.ID),
		Shots:            storyboardReplaceShots("SC.01", "手工写入"),
	}); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.Model(&model.AgentOpRecord{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("receipts = %d, want 0", count)
	}
}

type chapterTaskSeed struct {
	ID               string
	UserID           string
	ProjectID        string
	ChapterID        string
	Kind             chapterApplyKind
	ApprovedRevision int64
	ApprovedShotIDs  []string
	Status           model.TaskStatus
}

func seedSucceededChapterTask(t *testing.T, db *gorm.DB, seed chapterTaskSeed) {
	t.Helper()
	status := seed.Status
	if status == "" {
		status = model.TaskStatusSucceeded
	}
	metadata := map[string]any{
		"domainProjectId": seed.ProjectID,
		"chapterId":       seed.ChapterID,
	}
	operation := "storyboard"
	if seed.Kind == chapterApplyCharacters {
		metadata["operation"] = chapterCharacterTaskOperation
		operation = chapterCharacterTaskOperation
	} else {
		metadata["source"] = chapterStoryboardTaskSource
		if seed.ApprovedRevision > 0 {
			metadata["approvedRevision"] = seed.ApprovedRevision
		}
		if seed.ApprovedShotIDs != nil {
			metadata["approvedShotIds"] = seed.ApprovedShotIDs
		} else {
			metadata["approvedShotIds"] = []string{}
		}
	}
	encoded, err := json.Marshal(map[string]any{"metadata": metadata})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	completed := now
	task := model.Task{
		ID: seed.ID, UserID: seed.UserID, ProjectID: seed.ProjectID, Type: "canvas_text",
		Operation: operation, Status: status, Prompt: "chapter", InputJSON: string(encoded),
		CreatedAt: now, UpdatedAt: now,
	}
	if status == model.TaskStatusSucceeded {
		task.CompletedAt = &completed
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
}

func storyboardReplaceShots(title, description string) []ReplaceProjectUnitShotInput {
	return []ReplaceProjectUnitShotInput{{CreateProjectShotRequest: CreateProjectShotRequest{Title: title, Description: description, DurationMs: 3000}}}
}

func validChapterCharacterDetails() map[string]any {
	return map[string]any{
		"role": "主角", "appearance": "红色斗篷", "clothing": "红色兜帽与斗篷", "physique": "儿童体型",
		"personality": "勇敢", "voiceLanguage": "普通话", "voiceAge": "儿童", "voiceTimbre": "清亮",
	}
}

func assertSingleChapterApplyReceipt(t *testing.T, db *gorm.DB, userID, taskID string) {
	t.Helper()
	var record model.AgentOpRecord
	if err := db.First(&record, "user_id = ? AND op_id = ?", userID, chapterApplyOpID(taskID)).Error; err != nil {
		t.Fatal(err)
	}
	if record.Status != "succeeded" || record.PayloadHash == "" {
		t.Fatalf("receipt = %#v", record)
	}
}

func assertNoChapterApplyReceipt(t *testing.T, db *gorm.DB, userID, taskID string) {
	t.Helper()
	var count int64
	if err := db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, chapterApplyOpID(taskID)).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("receipt count = %d, want 0", count)
	}
}

func openFileProjectService(t *testing.T, path string) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Project{},
		&model.ProjectFolder{},
		&model.ProjectUnit{},
		&model.CanvasProject{},
		&model.CanvasSnapshot{},
		&model.CanvasSnapshotResource{},
		&model.CanvasUnitLink{},
		&model.ProjectAssetLink{},
		&model.ProjectAssetFolder{},
		&model.ProjectAssetCandidate{},
		&model.Asset{},
		&model.AssetVersion{},
		&model.AssetRepresentation{},
		&model.CharacterVoiceBinding{},
		&model.VoiceProfile{},
		&model.Resource{},
		&model.Task{},
		&model.Shot{},
		&model.ShotRevision{},
		&model.ShotArtifact{},
		&model.ShotAssetReference{},
		&model.WorkflowTemplateVersion{},
		&model.WorkflowInstance{},
		&model.WorkflowStepInstance{},
		&model.WorkflowStepTask{},
		&model.ProductionTaskLink{},
		&model.AgentOpRecord{},
	); err != nil {
		t.Fatal(err)
	}
	return New(repository.New(db), Dependencies{}), db
}

func closeDB(t *testing.T, db *gorm.DB) {
	t.Helper()
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestChapterApplyOpIDFitsAgentOpRecord(t *testing.T) {
	opID := chapterApplyOpID("123e4567-e89b-12d3-a456-426614174000")
	if len(opID) > 80 {
		t.Fatalf("op id length = %d", len(opID))
	}
	if operations.PayloadHash(ChapterApplyOpStoryboard, []byte(`{"unitId":"u"}`)) == "" {
		t.Fatal("payload hash empty")
	}
}
