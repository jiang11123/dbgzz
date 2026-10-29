package operations

import (
	"encoding/json"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

// Domain 是一次操作在当前事务里看到的工作区。方法不接受 *gorm.DB：
// 事务绑定由 DomainBinder 在回执同一条连接上完成。
type Domain interface {
	UserCanvasProject(userID string, id string) (json.RawMessage, error)
	UserCanvasProjectsPage(userID string, page int, pageSize int, projectID string, search string, sort string) (canvas.CanvasLibraryPage, error)
	UserAssetsPage(userID string, page int, pageSize int, filter canvas.UserAssetPageFilter) (canvas.UserAssetPage, error)
	UserAsset(userID string, id string) (json.RawMessage, error)
	Task(userID string, id string) (*model.Task, error)
	ResolveAssistantGenerationModel(kind, selectedModel string) (AssistantGenerationModel, error)
	CreateUserCanvasNodes(userID string, canvasID string, drafts []canvas.NodeDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.CreatedNode, error)
	PrepareUserCanvasStoryboard(userID, canvasID, nodeID string, input canvas.StoryboardPreparation, expectedRevision int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error)
	UpdateUserCanvasNodeFields(userID string, canvasID string, nodeID string, patch map[string]any, expectedRevision int64) (canvas.UserDataSummary, error)
	AppendUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, drafts []canvas.StoryboardRowDraft, expectedRevision int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error)
	UpdateUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, patches []canvas.StoryboardRowPatch, expectedRevision int64) (canvas.UserDataSummary, canvas.StoryboardRowUpdate, error)
	RemoveUserCanvasStoryboardRows(userID string, canvasID string, nodeID string, rowIDs []string, expectedRevision int64) (canvas.UserDataSummary, int, error)
	ConnectUserCanvasNodesAtRevision(userID string, canvasID string, fromNodeID string, toNodeID string, expectedRevision int64) (canvas.UserDataSummary, error)
	CommitUserCanvasDocument(userID string, canvasID string, expectedRevision int64, document json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error)
	WorkspaceTask(userID string, id string) (*model.Task, error)
	GenerationOutputs(taskID string) ([]localtask.CanonicalOutput, error)
	OwnedReadyResource(userID, resourceID string) (*model.Resource, error)
	OwnedAsset(userID, assetID string) (*model.Asset, error)
	BindExistingCanvasNode(userID string, patch canvas.TaskOutputBind) (canvas.TaskOutputBindResult, error)
	UserConversation(userID, conversationID string) (taskbinding.ConversationView, error)
	AttachConversationMessage(userID string, input taskbinding.MessageAttachInput) (taskbinding.ConversationView, error)
}

// AssistantGenerationModel 是一次生成提议解析出的有效模型。
// KindMismatch 表示节点显式模型与本次 kind 冲突，调用方必须拒绝而不是改用默认。
type AssistantGenerationModel struct {
	Display      string
	ModelKey     string
	Revision     int64
	KindMismatch bool
}

// DomainBinder 是组合根把根服务绑到当前事务的唯一缝。操作核的业务端口不再露出 *gorm.DB。
type DomainBinder interface {
	BindDomain(tx *gorm.DB) Domain
}
