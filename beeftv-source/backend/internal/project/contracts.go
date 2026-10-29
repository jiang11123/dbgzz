package project

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

type CreateProjectRequest struct {
	Name              string `json:"name"`
	Type              string `json:"type"`
	AspectRatio       string `json:"aspectRatio"`
	SourceType        string `json:"sourceType"`
	Description       string `json:"description"`
	StylePresetID     string `json:"stylePresetId"`
	StyleProfileJSON  string `json:"styleProfileJson"`
	DefaultImageModel string `json:"defaultImageModel"`
	DefaultVideoModel string `json:"defaultVideoModel"`
}

type UpdateProjectRequest struct {
	Name              string  `json:"name"`
	Type              string  `json:"type"`
	AspectRatio       string  `json:"aspectRatio"`
	SourceType        string  `json:"sourceType"`
	Description       *string `json:"description"`
	CoverResourceID   *string `json:"coverResourceId"`
	StylePresetID     *string `json:"stylePresetId"`
	StyleProfileJSON  *string `json:"styleProfileJson"`
	DefaultImageModel *string `json:"defaultImageModel"`
	DefaultVideoModel *string `json:"defaultVideoModel"`
	Status            string  `json:"status"`
}

type CreateProjectUnitRequest struct {
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	SourceText string `json:"sourceText"`
	Position   int    `json:"position"`
}

type UpdateProjectUnitRequest struct {
	Title      string `json:"title"`
	SourceText string `json:"sourceText"`
	Status     string `json:"status"`
}

type ImportProjectUnitsRequest struct {
	Units []CreateProjectUnitRequest `json:"units"`
}

type ReorderProjectUnitsRequest struct {
	UnitIDs []string `json:"unitIds"`
}

type LinkCanvasUnitRequest struct {
	CanvasID string `json:"canvasId"`
	UnitID   string `json:"unitId"`
	Role     string `json:"role"`
}

type CreateProjectFolderRequest struct {
	Name     string `json:"name"`
	ParentID string `json:"parentId"`
}

// WorkflowSeed is the default production instance prepared by a collaborator.
// Persistence stays in the same project-create transaction.
type WorkflowSeed struct {
	Instance model.WorkflowInstance
	Steps    []model.WorkflowStepInstance
}

// Summary is the local list card. Collaborator counts stay numeric so the
// composition root does not leak asset or task document types into this port.
type Summary struct {
	Project            model.Project `json:"project"`
	CanvasCount        int           `json:"canvasCount"`
	AssetCount         int64         `json:"assetCount"`
	UnitCount          int           `json:"unitCount"`
	CompletedUnitCount int           `json:"completedUnitCount"`
}

type ListPage struct {
	Projects []Summary `json:"projects"`
	Page     int       `json:"page"`
	PageSize int       `json:"pageSize"`
	Total    int64     `json:"total"`
	HasMore  bool      `json:"hasMore"`
}

type Core struct {
	Project model.Project `json:"project"`
}

type UnitSummaries struct {
	Units        []model.ProjectUnit `json:"units"`
	CanvasCounts map[string]int64    `json:"canvasCounts"`
}

type Overview struct {
	Metrics OverviewMetrics `json:"metrics"`
	Units   []OverviewUnit  `json:"units"`
}

type OverviewMetrics struct {
	UnitCount             int64 `json:"unitCount"`
	CompletedUnitCount    int64 `json:"completedUnitCount"`
	TotalWordCount        int64 `json:"totalWordCount"`
	UnitsWithoutText      int64 `json:"unitsWithoutText"`
	UnitsWithoutShots     int64 `json:"unitsWithoutShots"`
	CanvasCount           int64 `json:"canvasCount"`
	AssetCount            int64 `json:"assetCount"`
	ShotCount             int64 `json:"shotCount"`
	PendingCandidateCount int64 `json:"pendingCandidateCount"`
	ReadyStoryboardCount  int64 `json:"readyStoryboardCount"`
	ReadyPrevizCount      int64 `json:"readyPrevizCount"`
	ReadyVideoCount       int64 `json:"readyVideoCount"`
	RenderSucceededCount  int64 `json:"renderSucceededCount"`
	StaleArtifactCount    int64 `json:"staleArtifactCount"`
}

type OverviewUnit struct {
	Unit           model.ProjectUnit `json:"unit"`
	ShotCount      int64             `json:"shotCount"`
	CandidateCount int64             `json:"candidateCount"`
	CanvasCount    int64             `json:"canvasCount"`
}

type CanvasPage struct {
	Canvases        []model.CanvasProject  `json:"canvases"`
	CanvasUnitLinks []model.CanvasUnitLink `json:"canvasUnitLinks"`
	Page            int                    `json:"page"`
	PageSize        int                    `json:"pageSize"`
	Total           int64                  `json:"total"`
	HasMore         bool                   `json:"hasMore"`
}

const (
	AssetSourceUploaded = "uploaded"
	AssetSourceCanvas   = "canvas"
)

type LinkProjectAssetRequest struct {
	AssetID  string  `json:"assetId"`
	Category string  `json:"category"`
	FolderID *string `json:"folderId"`
	Title    string  `json:"title"`
	Source   string  `json:"source"`
}

type UpdateProjectAssetRequest struct {
	Category *string `json:"category"`
	FolderID *string `json:"folderId"`
}

type CreateAssetVersionRequest struct {
	Prompt         string `json:"prompt"`
	DefinitionJSON string `json:"definitionJson"`
	Note           string `json:"note"`
}

type ProjectAssetFilter struct {
	Category  string
	MediaType string
	Status    string
	Usage     string
}

type ConfirmProjectAssetCandidateRequest struct {
	AssetID string `json:"assetId"`
}

type CreateProjectAssetFolderRequest struct {
	Name     string `json:"name"`
	ParentID string `json:"parentId"`
	Style    string `json:"style"`
	Theme    string `json:"theme"`
}

type UpdateProjectAssetFolderRequest struct {
	Name     *string `json:"name"`
	ParentID *string `json:"parentId"`
	Style    *string `json:"style"`
	Theme    *string `json:"theme"`
}

type CreateProjectCharacterRequest struct {
	Name       string         `json:"name"`
	Definition map[string]any `json:"definition"`
}

type UpdateProjectCharacterRequest struct {
	Name       string         `json:"name"`
	Definition map[string]any `json:"definition"`
}

type CharacterRepresentationInput struct {
	Role       string `json:"role"`
	ResourceID string `json:"resourceId"`
	Metadata   any    `json:"metadata"`
}

type ReplaceCharacterRepresentationsRequest struct {
	Representations []CharacterRepresentationInput `json:"representations"`
}

type BindCharacterVoiceRequest struct {
	VoiceProfileID   string `json:"voiceProfileId"`
	SampleResourceID string `json:"sampleResourceId"`
	VoiceName        string `json:"voiceName"`
	Instructions     string `json:"instructions"`
}

type CharacterRepresentationSummary struct {
	ID         string `json:"id"`
	ResourceID string `json:"resourceId"`
	MediaType  string `json:"mediaType"`
	Role       string `json:"role"`
}

type VoiceProfileSummary struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Provider         string   `json:"provider"`
	VoiceKey         string   `json:"voiceKey"`
	Language         string   `json:"language"`
	Timbre           string   `json:"timbre"`
	SampleResourceID string   `json:"sampleResourceId,omitempty"`
	CompatibleModels []string `json:"compatibleModels"`
	Status           string   `json:"status"`
}

type CharacterVoiceSummary struct {
	Profile      VoiceProfileSummary `json:"profile"`
	Instructions string              `json:"instructions"`
}

type CharacterCardSummary struct {
	VersionID       string                           `json:"versionId"`
	Version         int                              `json:"version"`
	Definition      map[string]any                   `json:"definition"`
	Representations []CharacterRepresentationSummary `json:"representations"`
	Voice           *CharacterVoiceSummary           `json:"voice,omitempty"`
	VisualStatus    string                           `json:"visualStatus"`
	VoiceStatus     string                           `json:"voiceStatus"`
}

type AssetSummary struct {
	ID               string                   `json:"id"`
	Title            string                   `json:"title"`
	MediaType        string                   `json:"mediaType"`
	Category         model.AssetCategory      `json:"category"`
	Status           model.AssetVersionStatus `json:"status"`
	PrimaryVersionID string                   `json:"primaryVersionId,omitempty"`
	VersionCount     int                      `json:"versionCount"`
	Usages           []string                 `json:"usages"`
	FolderID         string                   `json:"folderId,omitempty"`
	Position         int                      `json:"position"`
	StorageKey       string                   `json:"storageKey,omitempty"`
	DurationMs       int64                    `json:"durationMs,omitempty"`
	PreviewText      string                   `json:"previewText,omitempty"`
	UpdatedAt        time.Time                `json:"updatedAt"`
	Source           string                   `json:"source,omitempty"`
	Character        *CharacterCardSummary    `json:"character,omitempty"`
}

type CharacterDetail struct {
	Asset     AssetSummary         `json:"asset"`
	Character CharacterCardSummary `json:"character"`
}

type CreateProjectShotRequest struct {
	ID          string            `json:"id"`
	UnitID      string            `json:"unitId"`
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Position    int               `json:"position"`
	DurationMs  int64             `json:"durationMs"`
	Status      string            `json:"status"`
	Revision    ShotRevisionInput `json:"revision"`
}

type ShotRevisionInput struct {
	PlotDescription string           `json:"plotDescription"`
	Action          string           `json:"action"`
	Dialogue        string           `json:"dialogue"`
	ShotSize        string           `json:"shotSize"`
	CameraAngle     string           `json:"cameraAngle"`
	CameraMovement  string           `json:"cameraMovement"`
	DurationMs      int64            `json:"durationMs"`
	ImagePrompt     string           `json:"imagePrompt"`
	VideoPrompt     string           `json:"videoPrompt"`
	NegativePrompt  string           `json:"negativePrompt"`
	ContinuityNotes string           `json:"continuityNotes"`
	ActionBeats     []map[string]any `json:"actionBeats"`
}

type ReplaceProjectUnitShotsRequest struct {
	Shots            []ReplaceProjectUnitShotInput `json:"shots"`
	ExpectedShotIDs  []string                      `json:"expectedShotIds"`
	ExpectedRevision int64                         `json:"expectedRevision"`
	// SourceTaskID 是章节生成任务的查找键，不是客户端可自选的幂等凭据。
	// 服务端校验 owner/project/chapter/operation 后派生应用身份。
	SourceTaskID string `json:"sourceTaskId"`
}

type ReplaceProjectUnitShotInput struct {
	CreateProjectShotRequest
	AssetVersionIDs []string `json:"assetVersionIds"`
}

type LinkShotAssetRequest struct {
	AssetVersionID string `json:"assetVersionId"`
	Role           string `json:"role"`
}

type AssetCandidateInput struct {
	UnitID   string         `json:"unitId"`
	ShotID   string         `json:"shotId"`
	Name     string         `json:"name"`
	Category string         `json:"category"`
	Details  map[string]any `json:"details"`
}

type CreateAssetCandidatesRequest struct {
	Candidates []AssetCandidateInput `json:"candidates"`
	Source     string                `json:"source"`
	// SourceTaskID 是章节提取任务的查找键，不是客户端可自选的幂等凭据。
	SourceTaskID string `json:"sourceTaskId"`
}

type ChapterApplyReceiptView struct {
	TaskID  string `json:"taskId"`
	Op      string `json:"op"`
	Kind    string `json:"kind"`
	Applied bool   `json:"applied"`
}

type WorkflowDetail struct {
	Instance model.WorkflowInstance       `json:"instance"`
	Steps    []model.WorkflowStepInstance `json:"steps"`
}

type UpdateWorkflowStepRequest struct {
	Status     string `json:"status"`
	OutputJSON string `json:"outputJson"`
	Error      string `json:"error"`
}

type RegisterTaskOutputRequest struct {
	TaskID         string `json:"taskId"`
	CanvasID       string `json:"canvasId"`
	UnitID         string `json:"unitId"`
	ShotID         string `json:"shotId"`
	ShotRevisionID string `json:"shotRevisionId"`
	ArtifactType   string `json:"artifactType"`
	AssetVersionID string `json:"assetVersionId"`
	ResourceID     string `json:"resourceId"`
	MediaType      string `json:"mediaType"`
	Role           string `json:"role"`
	MetadataJSON   string `json:"metadataJson"`
	OutputJSON     string `json:"outputJson"`
}

type ShotAssetReference struct {
	model.ShotAssetReference
	Asset             AssetSummary              `json:"asset"`
	ReferencedVersion ShotAssetReferenceVersion `json:"referencedVersion"`
}

type ShotAssetReferenceVersion struct {
	ID              string                           `json:"id"`
	AssetID         string                           `json:"assetId"`
	Version         int                              `json:"version"`
	Representations []CharacterRepresentationSummary `json:"representations"`
}

type UnitWorkspace struct {
	Unit            model.ProjectUnit             `json:"unit"`
	Workflows       []WorkflowDetail              `json:"workflows"`
	Shots           []model.Shot                  `json:"shots"`
	ShotRevisions   []model.ShotRevision          `json:"shotRevisions"`
	ShotArtifacts   []model.ShotArtifact          `json:"shotArtifacts"`
	ShotReferences  []ShotAssetReference          `json:"shotReferences"`
	AssetCandidates []model.ProjectAssetCandidate `json:"assetCandidates"`
	Assets          []AssetSummary                `json:"assets"`
}

type AssetCandidatePage struct {
	Candidates []model.ProjectAssetCandidate `json:"candidates"`
	Page       int                           `json:"page"`
	PageSize   int                           `json:"pageSize"`
	Total      int64                         `json:"total"`
	HasMore    bool                          `json:"hasMore"`
}

type AssetPage struct {
	Assets         []AssetSummary   `json:"assets"`
	CategoryCounts map[string]int64 `json:"categoryCounts"`
	FolderCounts   map[string]int64 `json:"folderCounts"`
	Page           int              `json:"page"`
	PageSize       int              `json:"pageSize"`
	Total          int64            `json:"total"`
	HasMore        bool             `json:"hasMore"`
}

// Snapshot is the project-owned slice of a workbench read. Task summaries stay
// with the generation adapter because they require TasksWithOptions.
type Snapshot struct {
	Project         model.Project                 `json:"project"`
	Units           []model.ProjectUnit           `json:"units"`
	Canvases        []model.CanvasProject         `json:"canvases"`
	CanvasUnitLinks []model.CanvasUnitLink        `json:"canvasUnitLinks"`
	AssetFolders    []model.ProjectAssetFolder    `json:"assetFolders"`
	Shots           []model.Shot                  `json:"shots"`
	ShotRevisions   []model.ShotRevision          `json:"shotRevisions"`
	ShotArtifacts   []model.ShotArtifact          `json:"shotArtifacts"`
	ShotReferences  []model.ShotAssetReference    `json:"shotReferences"`
	AssetCandidates []model.ProjectAssetCandidate `json:"assetCandidates"`
}
