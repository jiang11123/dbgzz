package operations

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/canvas"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
	"infinite-canvas/backend/internal/taskbinding"
)

type unusedDomain struct{}

func (unusedDomain) PrepareUserCanvasStoryboard(string, string, string, canvas.StoryboardPreparation, int64) (canvas.UserDataSummary, canvas.StoryboardPreparationResult, error) {
	panic("unused")
}

func (unusedDomain) UserConversation(string, string) (taskbinding.ConversationView, error) {
	panic("unused")
}
func (unusedDomain) AttachConversationMessage(string, taskbinding.MessageAttachInput) (taskbinding.ConversationView, error) {
	panic("unused")
}

func (unusedDomain) UserCanvasProject(string, string) (json.RawMessage, error) {
	panic("unused")
}
func (unusedDomain) UserCanvasProjectsPage(string, int, int, string, string, string) (canvas.CanvasLibraryPage, error) {
	panic("unused")
}
func (unusedDomain) UserAssetsPage(string, int, int, canvas.UserAssetPageFilter) (canvas.UserAssetPage, error) {
	panic("unused")
}
func (unusedDomain) UserAsset(string, string) (json.RawMessage, error) { panic("unused") }
func (unusedDomain) Task(string, string) (*model.Task, error)          { panic("unused") }
func (unusedDomain) ResolveAssistantGenerationModel(string, string) (AssistantGenerationModel, error) {
	panic("unused")
}
func (unusedDomain) CreateUserCanvasNodes(string, string, []canvas.NodeDraft, int64) (canvas.UserDataSummary, []canvas.CreatedNode, error) {
	panic("unused")
}
func (unusedDomain) UpdateUserCanvasNodeFields(string, string, string, map[string]any, int64) (canvas.UserDataSummary, error) {
	panic("unused")
}
func (unusedDomain) AppendUserCanvasStoryboardRows(string, string, string, []canvas.StoryboardRowDraft, int64) (canvas.UserDataSummary, []canvas.StoryboardRowIdentity, error) {
	panic("unused")
}
func (unusedDomain) UpdateUserCanvasStoryboardRows(string, string, string, []canvas.StoryboardRowPatch, int64) (canvas.UserDataSummary, canvas.StoryboardRowUpdate, error) {
	panic("unused")
}
func (unusedDomain) RemoveUserCanvasStoryboardRows(string, string, string, []string, int64) (canvas.UserDataSummary, int, error) {
	panic("unused")
}
func (unusedDomain) ConnectUserCanvasNodesAtRevision(string, string, string, string, int64) (canvas.UserDataSummary, error) {
	panic("unused")
}
func (unusedDomain) CommitUserCanvasDocument(string, string, int64, json.RawMessage) (canvas.UserDataSummary, json.RawMessage, error) {
	panic("unused")
}
func (unusedDomain) WorkspaceTask(string, string) (*model.Task, error) { panic("unused") }
func (unusedDomain) GenerationOutputs(string) ([]localtask.CanonicalOutput, error) {
	panic("unused")
}
func (unusedDomain) OwnedReadyResource(string, string) (*model.Resource, error) { panic("unused") }
func (unusedDomain) OwnedAsset(string, string) (*model.Asset, error)            { panic("unused") }
func (unusedDomain) BindExistingCanvasNode(string, canvas.TaskOutputBind) (canvas.TaskOutputBindResult, error) {
	panic("unused")
}

type assetListProbe struct {
	unusedDomain
	userID string
	page   int
	size   int
	filter canvas.UserAssetPageFilter
}

func (p *assetListProbe) UserAssetsPage(userID string, page int, pageSize int, filter canvas.UserAssetPageFilter) (canvas.UserAssetPage, error) {
	p.userID = userID
	p.page = page
	p.size = pageSize
	p.filter = filter
	return canvas.UserAssetPage{
		FavoriteTotal: 4,
		RecentTotal:   5,
		ProjectCounts: map[string]int64{"海边剧": 2},
		Page:          page,
		PageSize:      pageSize,
		Total:         3,
	}, nil
}

func TestOpAssetListForwardsFavoriteRecentProject(t *testing.T) {
	probe := &assetListProbe{}
	result, err := opAssetList(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"page":2,"pageSize":20,"query":"海边","kind":"image","category":"material","favorite":true,"recent":true,"project":"海边剧"}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.userID != "owner" || probe.page != 2 || probe.size != 20 {
		t.Fatalf("paging = user %s page %d size %d", probe.userID, probe.page, probe.size)
	}
	if !probe.filter.Favorite || !probe.filter.Recent || probe.filter.Project != "海边剧" || probe.filter.Kind != "image" || probe.filter.Category != "material" || probe.filter.Query != "海边" || probe.filter.Generated {
		t.Fatalf("filter = %#v", probe.filter)
	}
	page, ok := result.(canvas.UserAssetPage)
	if !ok {
		t.Fatalf("result type %T", result)
	}
	if page.Total != 3 || page.FavoriteTotal != 4 || page.RecentTotal != 5 || page.ProjectCounts["海边剧"] != 2 {
		t.Fatalf("page = %#v", page)
	}
}

func TestOpAssetListKeepsLegacyArgsWithoutExtraFilters(t *testing.T) {
	probe := &assetListProbe{}
	if _, err := opAssetList(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"query":"x","kind":"image"}`)); err != nil {
		t.Fatal(err)
	}
	if probe.filter.Favorite || probe.filter.Recent || probe.filter.Project != "" || probe.filter.Generated || probe.filter.Kind != "image" || probe.filter.Query != "x" {
		t.Fatalf("legacy filter = %#v", probe.filter)
	}
}

func TestOpAssetListForwardsGenerated(t *testing.T) {
	probe := &assetListProbe{}
	if _, err := opAssetList(&Context{UserID: "owner", Domain: probe}, json.RawMessage(`{"generated":true,"kind":"video","page":3,"pageSize":20}`)); err != nil {
		t.Fatal(err)
	}
	if !probe.filter.Generated || probe.filter.Kind != "video" || probe.page != 3 || probe.size != 20 {
		t.Fatalf("generated filter = %#v page %d size %d", probe.filter, probe.page, probe.size)
	}
}
