package asset

import (
	"encoding/json"
	"time"
)

type CreateAssetFolderRequest struct {
	Name string `json:"name"`
}

type UpdateAssetFolderRequest struct {
	Name string `json:"name"`
}

type MoveUserAssetsRequest struct {
	AssetIDs []string `json:"assetIds"`
	FolderID string   `json:"folderId"`
}

type AssetsSyncRequest struct {
	Assets []json.RawMessage `json:"assets"`
}

type Summary struct {
	ID        string    `json:"id"`
	FolderID  string    `json:"folderId,omitempty"`
	Kind      string    `json:"kind,omitempty"`
	Category  string    `json:"category,omitempty"`
	Status    string    `json:"status,omitempty"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type UserAssetPage struct {
	Assets              []json.RawMessage `json:"assets"`
	KindCounts          map[string]int64  `json:"kindCounts"`
	CategoryCounts      map[string]int64  `json:"categoryCounts"`
	FolderCounts        map[string]int64  `json:"folderCounts"`
	FavoriteTotal       int64             `json:"favoriteTotal"`
	RecentTotal         int64             `json:"recentTotal"`
	ProjectCounts       map[string]int64  `json:"projectCounts"`
	GeneratedTotal      int64             `json:"generatedTotal"`
	GeneratedKindCounts map[string]int64  `json:"generatedKindCounts"`
	Page                int               `json:"page"`
	PageSize            int               `json:"pageSize"`
	Total               int64             `json:"total"`
	HasMore             bool              `json:"hasMore"`
}

type UserAssetPageFilter struct {
	Kind          string
	Category      string
	FolderID      *string
	Uncategorized bool
	Status        string
	Query         string
	Favorite      bool
	Recent        bool
	Project       string
	ProjectID     string
	Generated     bool
}
