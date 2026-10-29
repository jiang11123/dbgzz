package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

const CurrentSchemaVersion int64 = 25

type localSchemaMigration struct {
	Version   int64 `gorm:"primaryKey;autoIncrement:false"`
	Name      string
	AppliedAt time.Time
}

func (localSchemaMigration) TableName() string { return "local_schema_migrations" }

type localMigration struct {
	version     int64
	name        string
	destructive bool
	apply       func(*gorm.DB) error
}

type SchemaStatus struct {
	Current  int64 `json:"current"`
	Expected int64 `json:"expected"`
	Ready    bool  `json:"ready"`
}

// LocalModels is the complete native-app persistence surface. SaaS identity,
// billing, payments, object-storage settings, announcements, public shares,
// and managed model catalogs are deliberately absent.
func LocalModels() []any {
	return []any{
		&model.Workspace{}, &model.IDSequence{}, &model.SystemSetting{}, &model.UserDailyActivity{},
		&model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelVariant{}, &model.ApiCallLog{},
		&model.LogicalModel{}, &model.LogicalModelRevision{}, &model.LogicalModelRoute{}, &model.RouteAttempt{},
		&model.ImageSubmission{},
		&model.CloudAgentExecution{}, &model.CloudAgentCanvasMutation{}, &model.AgentProfile{}, &model.AgentLesson{}, &model.AgentMemorySetting{},
		&model.PluginPlatformState{}, &model.UserPluginState{},
		&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{},
		&model.Resource{}, &model.ResourceDeletionJob{}, &model.UserDailyUploadUsage{}, &model.UserUploadReservation{}, &model.ArkPrivateAssetBinding{},
		&model.Asset{}, &model.AssetFolder{}, &model.AssetVersion{}, &model.AssetRepresentation{},
		&model.ProjectAssetLink{}, &model.ProjectAssetFolder{}, &model.ProjectAssetCandidate{},
		&model.VoiceProfile{}, &model.CharacterVoiceBinding{},
		&model.Project{}, &model.ProjectFolder{}, &model.StyleProfile{}, &model.ProjectUnit{}, &model.CanvasUnitLink{},
		&model.Shot{}, &model.ShotRevision{}, &model.ShotArtifact{}, &model.ShotAssetReference{},
		&model.WorkflowTemplateVersion{}, &model.WorkflowInstance{}, &model.WorkflowStepInstance{}, &model.WorkflowStepTask{}, &model.ProductionTaskLink{},
		&model.CanvasProject{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}, &model.AgentOpRecord{},
		&model.AssistantTurn{},
		&model.AssistantContinuation{},
		&model.AssistantSkillContext{}, &model.AssistantSkillContextMutation{},
		&model.CreationConversation{},
		&model.CanvasLibraryFolder{}, &model.CanvasDrawing{},
		&model.CanvasWorkflow{}, &model.CanvasWorkflowRun{}, &model.CanvasWorkflowResource{}, &model.CanvasWorkflowRevision{},
		&model.PromptTemplate{}, &model.UserPromptCustomization{},
		&model.Task{}, &model.CreationRun{}, &model.CreationSubmission{}, &model.TaskTextDelta{}, &model.TaskLog{}, &model.Result{},
	}
}

func MigrateLocalSchema(db *gorm.DB) error {
	return migrateLocalSchema(db, nil)
}

// canonicalLocalMigrations is the unified catalog. Fresh databases record these
// names. Occupied historical version numbers are never re-applied, even when a
// preview branch stored a different name for the same number.
func canonicalLocalMigrations() []localMigration {
	return []localMigration{
		{version: 1, name: "local-core-schema", apply: migrateLocalCoreSchema},
		{version: 2, name: "retire-hosted-schema", destructive: true, apply: migrateRetiredHostedSchema},
		{version: 3, name: "task-failure-diagnostics", apply: ensureTaskFailureDiagnostics},
		{version: 4, name: "task-client-operation", apply: ensureTaskClientOperation},
		{version: 5, name: "task-client-operation-hash", apply: ensureTaskClientOperationHash},
		{version: 6, name: "agent-operation-turn-attribution", apply: ensureAgentOperationTurnAttribution},
		{version: 8, name: "reconcile-product-agent-schema", apply: migrateProductAgentSchema},
		{version: 9, name: "repair-product-agent-contracts", apply: repairProductAgentContracts},
		{version: 10, name: "assistant-business-turns", apply: migrateAssistantBusinessTurns},
		{version: 11, name: "creation-conversations", apply: migrateCreationConversations},
		{version: 12, name: "canvas-library-drawings", apply: migrateCanvasLibrarySchema},
		{version: 13, name: "upload-reservation-witness", apply: migrateUploadReservationWitness},
		{version: 14, name: "assistant-skill-version-pins", apply: migrateAssistantSkillPins},
		{version: 15, name: "assistant-permission-and-canvas-snapshots", apply: migrateAssistantPermissions},
		{version: 16, name: "assistant-durable-session-binding", apply: migrateAssistantSessions},
		{version: 17, name: "assistant-active-skill-context", apply: migrateAssistantSkillContexts},
		{version: 18, name: "assistant-generation-continuations", apply: migrateAssistantContinuations},
		{version: 19, name: "assistant-continuation-intent-fence", apply: migrateAssistantContinuationIntentFence},
		{version: 20, name: "assistant-production-authorization", apply: migrateAssistantProductionAuthorization},
		{version: 21, name: "skill-market-release-metadata", apply: migrateSkillMarketReleaseMetadata},
		{version: 22, name: "canvas-reusable-workflows", apply: func(tx *gorm.DB) error {
			return tx.AutoMigrate(&model.CanvasWorkflow{}, &model.CanvasWorkflowRun{}, &model.CanvasWorkflowResource{})
		}},
		{version: 23, name: "canvas-workflow-source-snapshots", apply: func(tx *gorm.DB) error { return ensureSQLiteColumn(tx, "tasks", "workflow_source_cipher", "TEXT") }},
		{version: 24, name: "canvas-workflow-immutable-revisions", apply: func(tx *gorm.DB) error {
			if err := tx.AutoMigrate(&model.CanvasWorkflow{}, &model.CanvasWorkflowRun{}, &model.CanvasWorkflowRevision{}); err != nil {
				return err
			}
			return tx.Exec("INSERT OR IGNORE INTO canvas_workflow_revisions (template_id, revision, user_id, name, description, definition_json, recipe_cipher) SELECT id, 1, user_id, name, description, definition_json, recipe_cipher FROM canvas_workflows").Error
		}},
		// Preview builds assigned v17-v19 to workflow migrations before main
		// used those versions for assistant context and continuation schema. Keep
		// the historical ledger intact and reconcile the idempotent assistant
		// structures under a new version so upgraded preview databases become
		// compatible with current main.
		{version: 25, name: "reconcile-preview-assistant-schema", apply: func(tx *gorm.DB) error {
			if err := migrateAssistantSkillContexts(tx); err != nil {
				return err
			}
			if err := migrateAssistantContinuations(tx); err != nil {
				return err
			}
			return migrateAssistantContinuationIntentFence(tx)
		}},
	}
}

func migrateLocalSchema(db *gorm.DB, beforeApply func(int64) error) error {
	current, err := currentSchemaVersion(db)
	if err != nil {
		return err
	}
	if current > CurrentSchemaVersion {
		return fmt.Errorf("数据库版本 %d 高于当前程序支持的 %d，拒绝降级迁移", current, CurrentSchemaVersion)
	}
	if err := db.AutoMigrate(&localSchemaMigration{}); err != nil {
		return fmt.Errorf("初始化本地结构版本表: %w", err)
	}
	frozen, err := listSchemaMigrations(db)
	if err != nil {
		return err
	}
	occupied := make(map[int64]localSchemaMigration, len(frozen))
	for _, row := range frozen {
		occupied[row.Version] = row
	}
	current, err = currentSchemaVersion(db)
	if err != nil {
		return err
	}
	for _, migration := range canonicalLocalMigrations() {
		if _, exists := occupied[migration.version]; exists {
			continue
		}
		if migration.version <= current {
			continue
		}
		if migration.destructive {
			if err := backupBeforeDestructiveMigration(db, migration.version); err != nil {
				return err
			}
		}
		if beforeApply != nil {
			if err := beforeApply(migration.version); err != nil {
				return fmt.Errorf("迁移 v%d %s 前置检查: %w", migration.version, migration.name, err)
			}
		}
		if err := db.Transaction(func(tx *gorm.DB) error {
			if err := migration.apply(tx); err != nil {
				return err
			}
			if err := tx.Create(&localSchemaMigration{Version: migration.version, Name: migration.name, AppliedAt: time.Now().UTC()}).Error; err != nil {
				return err
			}
			return assertLedgerImmutable(tx, frozen)
		}); err != nil {
			return fmt.Errorf("执行本地数据库迁移 v%d %s: %w", migration.version, migration.name, err)
		}
		frozen, err = listSchemaMigrations(db)
		if err != nil {
			return err
		}
		current = migration.version
	}
	if err := assertLedgerImmutable(db, frozen); err != nil {
		return err
	}
	if current >= 11 {
		if err := ensureCreationConversationsIndexes(db); err != nil {
			return fmt.Errorf("补齐创作对话索引: %w", err)
		}
	}
	return requireReconciledSchema(db)
}

// migrateProductAgentSchema adds the unified product/Agent contract without
// rebuilding existing tables or rewriting ledger identities.
func migrateProductAgentSchema(tx *gorm.DB) error {
	if err := ensureTaskFailureDiagnostics(tx); err != nil {
		return err
	}
	if err := ensureImageSubmissionsTable(tx); err != nil {
		return err
	}
	if err := ensureAgentOpRecordsTable(tx); err != nil {
		return err
	}
	if err := ensureTaskClientOperation(tx); err != nil {
		return err
	}
	if err := ensureTaskClientOperationHash(tx); err != nil {
		return err
	}
	return ensureTaskUserClientOpIndex(tx)
}

func migrateUploadReservationWitness(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.UserUploadReservation{}); err != nil {
		return fmt.Errorf("迁移上传预留恢复索引: %w", err)
	}
	return backfillUnattributedLegacyUploads(tx)
}

func migrateLocalCoreSchema(tx *gorm.DB) error {
	if err := tx.AutoMigrate(LocalModels()...); err != nil {
		return fmt.Errorf("迁移本地工作区结构: %w", err)
	}
	if err := ensureLocalWorkspace(tx); err != nil {
		return err
	}
	return backfillProjectUnitWordCounts(tx)
}

func migrateRetiredHostedSchema(tx *gorm.DB) error {
	if tx.Migrator().HasTable("creation_submissions") && tx.Migrator().HasColumn("creation_submissions", "quote_json") {
		if err := migrateLegacyCreationSubmissions(tx); err != nil {
			return err
		}
	}
	if tx.Migrator().HasTable("channel_model_price_tiers") {
		if err := migrateLegacyChannelModelVariants(tx); err != nil {
			return err
		}
	}
	return dropHostedTables(tx)
}

func currentSchemaVersion(db *gorm.DB) (int64, error) {
	if !hasSchemaLedger(db) {
		return 0, nil
	}
	var version int64
	if err := db.Model(&localSchemaMigration{}).Select("COALESCE(MAX(version), 0)").Scan(&version).Error; err != nil {
		return 0, fmt.Errorf("读取本地结构版本: %w", err)
	}
	return version, nil
}

func hasSchemaLedger(db *gorm.DB) bool {
	var count int
	if err := db.Raw("SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?", "table", "local_schema_migrations").Scan(&count).Error; err != nil {
		return false
	}
	return count > 0
}

func listSchemaMigrations(db *gorm.DB) ([]localSchemaMigration, error) {
	if !hasSchemaLedger(db) {
		return nil, nil
	}
	var rows []localSchemaMigration
	if err := db.Order("version").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("读取本地结构迁移记录: %w", err)
	}
	return rows, nil
}

func assertLedgerImmutable(db *gorm.DB, frozen []localSchemaMigration) error {
	for _, old := range frozen {
		var actual localSchemaMigration
		if err := db.First(&actual, "version = ?", old.Version).Error; err != nil {
			return fmt.Errorf("历史迁移身份丢失: v%d %s: %w", old.Version, old.Name, err)
		}
		if actual.Name != old.Name || !actual.AppliedAt.Equal(old.AppliedAt) {
			return fmt.Errorf("历史迁移身份被改写: v%d 原 %s %s 现 %s %s", old.Version, old.Name, old.AppliedAt.UTC().Format(time.RFC3339Nano), actual.Name, actual.AppliedAt.UTC().Format(time.RFC3339Nano))
		}
	}
	return nil
}

func backupBeforeDestructiveMigration(db *gorm.DB, version int64) error {
	needsBackup := false
	for _, table := range hostedTables() {
		if db.Migrator().HasTable(table) {
			needsBackup = true
			break
		}
	}
	if !needsBackup && db.Migrator().HasTable("creation_submissions") {
		needsBackup = db.Migrator().HasColumn("creation_submissions", "quote_json")
	}
	if !needsBackup {
		return nil
	}
	var databases []struct {
		Seq  int
		Name string
		File string
	}
	if err := db.Raw("PRAGMA database_list").Scan(&databases).Error; err != nil {
		return fmt.Errorf("读取 SQLite 数据库路径: %w", err)
	}
	databasePath := ""
	for _, item := range databases {
		if item.Name == "main" {
			databasePath = strings.TrimSpace(item.File)
			break
		}
	}
	// In-memory test and ephemeral databases have no recoverable file to copy.
	if databasePath == "" || databasePath == ":memory:" {
		return nil
	}
	backupDir := filepath.Join(filepath.Dir(databasePath), "backups")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return fmt.Errorf("创建数据库备份目录: %w", err)
	}
	backupPath := filepath.Join(backupDir, fmt.Sprintf("before-schema-v%d-%s.db", version, time.Now().UTC().Format("20060102T150405.000000000Z")))
	quotedPath := strings.ReplaceAll(backupPath, "'", "''")
	if err := db.Exec("VACUUM INTO '" + quotedPath + "'").Error; err != nil {
		return fmt.Errorf("创建破坏性迁移前备份: %w", err)
	}
	return nil
}

func migrateLegacyChannelModelVariants(db *gorm.DB) error {
	type legacyVariant struct {
		ID               string
		ChannelModelID   string
		SelectorKey      string
		SelectorJSON     string
		Resolution       string
		VideoSeconds     int
		ProviderModelKey string
		Enabled          bool
		CreatedAt        time.Time
		UpdatedAt        time.Time
		DeletedAt        gorm.DeletedAt
	}
	var items []legacyVariant
	if err := db.Table("channel_model_price_tiers").Select(
		"id, channel_model_id, selector_key, selector_json, resolution, video_seconds, provider_model_key, enabled, created_at, updated_at, deleted_at",
	).Find(&items).Error; err != nil {
		return fmt.Errorf("读取旧模型规格: %w", err)
	}
	for _, item := range items {
		selectorJSON := strings.TrimSpace(item.SelectorJSON)
		if selectorJSON == "" {
			selectorJSON = "{}"
		}
		selectorKey := strings.TrimSpace(item.SelectorKey)
		if selectorKey == "" {
			selectorKey = selectorJSON
		}
		variant := model.ChannelModelVariant{
			ID: item.ID, ChannelModelID: item.ChannelModelID,
			SelectorKey: selectorKey, SelectorJSON: selectorJSON,
			Resolution: item.Resolution, VideoSeconds: item.VideoSeconds,
			ProviderModelKey: item.ProviderModelKey, Enabled: item.Enabled,
			CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt, DeletedAt: item.DeletedAt,
		}
		if err := db.Where("id = ?", variant.ID).FirstOrCreate(&variant).Error; err != nil {
			return fmt.Errorf("迁移模型规格 %s: %w", item.ID, err)
		}
	}
	return nil
}

func migrateLegacyCreationSubmissions(db *gorm.DB) error {
	type legacySubmission struct {
		ID             string
		QuoteJSON      string
		PriceSignature string
	}
	var items []legacySubmission
	if err := db.Table("creation_submissions").Select("id, quote_json, price_signature").Find(&items).Error; err != nil {
		return fmt.Errorf("读取旧创作执行项: %w", err)
	}
	for _, item := range items {
		legacy := struct {
			Model     string         `json:"model"`
			QuoteHash string         `json:"quoteHash"`
			Options   map[string]any `json:"options"`
		}{}
		_ = json.Unmarshal([]byte(item.QuoteJSON), &legacy)
		execution, _ := json.Marshal(map[string]any{
			"model": legacy.Model, "configHash": legacy.QuoteHash, "options": legacy.Options,
		})
		if err := db.Table("creation_submissions").Where("id = ?", item.ID).Updates(map[string]any{
			"execution_json": string(execution), "config_signature": item.PriceSignature,
		}).Error; err != nil {
			return fmt.Errorf("迁移创作执行项 %s: %w", item.ID, err)
		}
	}
	for _, column := range []string{"quote_json", "price_signature", "expires_at"} {
		if db.Migrator().HasColumn("creation_submissions", column) {
			// The desktop runtime is SQLite-only. Using the native statement here
			// avoids GORM's SQLite table-rebuild path dereferencing a nil schema
			// when the retired column is intentionally absent from the Go model.
			if err := db.Exec("ALTER TABLE creation_submissions DROP COLUMN " + column).Error; err != nil {
				return fmt.Errorf("删除创作执行项旧字段 %s: %w", column, err)
			}
		}
	}
	return nil
}

func RequireLocalSchema(db *gorm.DB) error {
	if !db.Migrator().HasTable(&model.AssistantContinuation{}) {
		return fmt.Errorf("本地工作区数据库结构缺失，请启用自动迁移")
	}
	for _, table := range []any{&model.Workspace{}, &model.Resource{}, &model.Project{}, &model.CanvasProject{}, &model.Task{}, &model.AgentOpRecord{}, &model.ImageSubmission{}, &model.AssistantTurn{}, &model.CreationConversation{}, &model.CanvasLibraryFolder{}, &model.CanvasDrawing{}, &model.AssistantSkillContext{}, &model.AssistantSkillContextMutation{}} {
		if !db.Migrator().HasTable(table) {
			return fmt.Errorf("本地工作区数据库结构缺失，请启用自动迁移")
		}
	}
	version, err := currentSchemaVersion(db)
	if err != nil {
		return err
	}
	if version >= 13 && !db.Migrator().HasTable(&model.UserUploadReservation{}) {
		return fmt.Errorf("本地工作区数据库结构缺失，请启用自动迁移")
	}
	if version != CurrentSchemaVersion {
		return fmt.Errorf("本地工作区数据库版本为 %d，期望 %d，请启用自动迁移", version, CurrentSchemaVersion)
	}
	if err := requireAssistantContinuations(db); err != nil {
		return err
	}
	if err := requireAssistantContinuationIntentFence(db); err != nil {
		return err
	}
	return requireReconciledSchema(db)
}

func requireReconciledSchema(db *gorm.DB) error {
	if err := requireSQLitePrimaryKey(db, "tasks", []string{"id"}); err != nil {
		return err
	}
	if !db.Migrator().HasTable("image_submissions") || !db.Migrator().HasTable("agent_op_records") {
		return fmt.Errorf("本地图片恢复或 Agent 操作表缺失，请从备份恢复或使用修复迁移")
	}
	for _, column := range []string{"failure_diagnostics", "client_operation_id", "client_operation_hash"} {
		has, err := sqliteHasColumn(db, "tasks", column)
		if err != nil {
			return err
		}
		if !has {
			return fmt.Errorf("本地任务结构缺失列 %s", column)
		}
	}
	hasTurnID, err := sqliteHasColumn(db, "agent_op_records", "turn_id")
	if err != nil {
		return err
	}
	if !hasTurnID {
		return fmt.Errorf("本地 Agent 幂等或回合归属结构缺失")
	}
	for _, value := range []any{&model.ImageSubmission{}, &model.AgentOpRecord{}} {
		stmt := &gorm.Statement{DB: db}
		if err := stmt.Parse(value); err != nil {
			return err
		}
		for _, column := range stmt.Schema.DBNames {
			has, err := sqliteHasColumn(db, stmt.Schema.Table, column)
			if err != nil {
				return err
			}
			if !has {
				return fmt.Errorf("本地数据库表 %s 缺失列 %s", stmt.Schema.Table, column)
			}
		}
		if err := requireSQLitePrimaryKey(db, stmt.Schema.Table, stmt.Schema.PrimaryFieldDBNames); err != nil {
			return err
		}
	}
	for _, index := range reconciledIndexes {
		valid, err := matchesSQLiteIndex(db, index)
		if err != nil {
			return err
		}
		if !valid {
			return fmt.Errorf("本地数据库索引 %s 定义不完整", index.name)
		}
	}
	version, err := currentSchemaVersion(db)
	if err != nil {
		return err
	}
	if version >= 10 {
		if err := requireAssistantTurnsSchema(db); err != nil {
			return err
		}
	}
	if version >= 11 {
		if err := requireCreationConversationsSchema(db); err != nil {
			return err
		}
	}
	if version >= 12 {
		if err := requireCanvasLibrarySchema(db); err != nil {
			return err
		}
	}
	if version >= 14 {
		if err := requireAssistantSkillPins(db); err != nil {
			return err
		}
	}
	if version >= 15 {
		if err := requireAssistantPermissions(db); err != nil {
			return err
		}
	}
	if version >= 16 {
		if err := requireAssistantSessions(db); err != nil {
			return err
		}
	}
	if version >= 20 {
		if err := requireAssistantProductionAuthorization(db); err != nil {
			return err
		}
	}
	if version >= 21 {
		if err := requireSkillMarketReleaseMetadata(db); err != nil {
			return err
		}
	}
	if version >= 22 {
		for _, table := range []any{&model.CanvasWorkflow{}, &model.CanvasWorkflowRun{}, &model.CanvasWorkflowResource{}} {
			if !db.Migrator().HasTable(table) {
				return fmt.Errorf("本地可复用工作流表缺失，请启用自动迁移")
			}
		}
	}
	if version >= 23 {
		exists, err := sqliteHasColumn(db, "tasks", "workflow_source_cipher")
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("本地任务工作流来源快照列缺失，请启用自动迁移")
		}
	}
	if version >= 24 {
		if !db.Migrator().HasTable(&model.CanvasWorkflowRevision{}) || !db.Migrator().HasColumn(&model.CanvasWorkflow{}, "revision") || !db.Migrator().HasColumn(&model.CanvasWorkflowRun{}, "template_revision") {
			return fmt.Errorf("本地工作流版本结构缺失，请启用自动迁移")
		}
	}
	return nil
}

func ReadSchemaStatus(db *gorm.DB) (SchemaStatus, error) {
	status := SchemaStatus{Expected: CurrentSchemaVersion}
	var err error
	status.Current, err = currentSchemaVersion(db)
	if err != nil {
		return status, err
	}
	if err := RequireLocalSchema(db); err != nil {
		return status, nil
	}
	status.Ready = status.Current == CurrentSchemaVersion
	return status, nil
}

func backfillProjectUnitWordCounts(db *gorm.DB) error {
	var units []model.ProjectUnit
	if err := db.Select("id", "source_text").Where("word_count = 0 AND source_text <> ''").Find(&units).Error; err != nil {
		return fmt.Errorf("读取待回填章节字数：%w", err)
	}
	for _, unit := range units {
		wordCount := model.ProjectUnitWordCount(unit.SourceText)
		if err := db.Model(&model.ProjectUnit{}).Where("id = ?", unit.ID).Update("word_count", wordCount).Error; err != nil {
			return fmt.Errorf("回填章节 %s 字数：%w", unit.ID, err)
		}
	}
	return nil
}

func ensureLocalWorkspace(db *gorm.DB) error {
	var existing model.Workspace
	if err := db.Order("created_at ASC").First(&existing).Error; err == nil {
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return fmt.Errorf("读取本地工作区: %w", err)
	}

	id := legacyWorkspaceOwnerID(db)
	if id == "" {
		id = kernel.NewID()
	}
	now := time.Now().UTC()
	if err := db.Create(&model.Workspace{ID: id, Name: "本地工作区", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		return fmt.Errorf("创建本地工作区: %w", err)
	}
	return nil
}

func legacyWorkspaceOwnerID(db *gorm.DB) string {
	if db.Migrator().HasTable("users") {
		var id string
		if err := db.Table("users").Select("id").Where("username = ?", "local").Limit(1).Scan(&id).Error; err == nil && id != "" {
			return id
		}
	}
	for _, table := range []string{"projects", "resources", "tasks", "canvas_projects", "assets"} {
		if !db.Migrator().HasTable(table) {
			continue
		}
		var id string
		if err := db.Table(table).Select("user_id").Where("user_id <> ''").Limit(1).Scan(&id).Error; err == nil && id != "" {
			return id
		}
	}
	return ""
}

func dropHostedTables(db *gorm.DB) error {
	for _, table := range hostedTables() {
		if db.Migrator().HasTable(table) {
			if err := db.Migrator().DropTable(table); err != nil {
				return fmt.Errorf("删除托管版遗留表 %s: %w", table, err)
			}
		}
	}
	return nil
}

func hostedTables() []string {
	return []string{
		// Hosted identity and authentication.
		"auth_sessions", "user_identities", "oauth_states", "email_verification_codes", "users",
		// Hosted content distribution and object-storage control planes.
		"announcements", "announcement_image_drafts", "user_announcement_reads", "banner_announcements", "canvas_shares",
		"user_oss_settings", "storage_locations",
		// Commerce, wallet, payment, redemption, and reconciliation.
		"model_pricings", "credit_accounts", "credit_ledger_entries", "billing_orders", "billing_reviews",
		"topup_products", "payment_provider_configs", "payment_orders", "payment_notifications",
		"payment_reconciliation_runs", "payment_reconciliation_items", "redeem_batches", "redeem_codes",
		"channel_model_price_tiers", "logical_model_price_skus",
	}
}
