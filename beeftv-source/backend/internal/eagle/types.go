package eagle

import (
	"encoding/json"
	"io"
)

const DefaultBaseURL = "http://127.0.0.1:41595"

type Folder struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	ParentID string   `json:"parentId,omitempty"`
	Children []Folder `json:"children,omitempty"`
}

type Library struct {
	ApplicationVersion string   `json:"applicationVersion"`
	LibraryName        string   `json:"libraryName"`
	LibraryPath        string   `json:"-"`
	Folders            []Folder `json:"folders"`
}

type Item struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Size             int64    `json:"size"`
	Extension        string   `json:"extension"`
	Tags             []string `json:"tags"`
	FolderIDs        []string `json:"folderIds"`
	URL              string   `json:"url"`
	Annotation       string   `json:"annotation"`
	ModificationTime int64    `json:"modificationTime"`
	Width            int      `json:"width,omitempty"`
	Height           int      `json:"height,omitempty"`
	Deleted          bool     `json:"deleted"`
}

func (item *Item) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID               string   `json:"id"`
		Name             string   `json:"name"`
		Size             int64    `json:"size"`
		Extension        string   `json:"ext"`
		Tags             []string `json:"tags"`
		FolderIDs        []string `json:"folders"`
		URL              string   `json:"url"`
		Annotation       string   `json:"annotation"`
		ModificationTime int64    `json:"modificationTime"`
		Width            int      `json:"width"`
		Height           int      `json:"height"`
		Deleted          bool     `json:"isDeleted"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*item = Item{
		ID: raw.ID, Name: raw.Name, Size: raw.Size, Extension: raw.Extension,
		Tags: raw.Tags, FolderIDs: raw.FolderIDs, URL: raw.URL, Annotation: raw.Annotation,
		ModificationTime: raw.ModificationTime, Width: raw.Width, Height: raw.Height, Deleted: raw.Deleted,
	}
	return nil
}

func normalizeStringSlice(values []string) []string {
	normalized := make([]string, len(values))
	copy(normalized, values)
	return normalized
}

func normalizeItemCollections(item *Item) {
	item.FolderIDs = normalizeStringSlice(item.FolderIDs)
	item.Tags = normalizeStringSlice(item.Tags)
}

type ItemQuery struct {
	FolderID string
	Keyword  string
	Limit    int
	Offset   int
}

type AddItemRequest struct {
	URL              string   `json:"url"`
	Name             string   `json:"name"`
	FolderID         string   `json:"folderId,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	Annotation       string   `json:"annotation,omitempty"`
	Website          string   `json:"website,omitempty"`
	ModificationTime int64    `json:"modificationTime,omitempty"`
}

type CreatedItem struct {
	ID string `json:"id,omitempty"`
}

type File struct {
	Path     string
	Name     string
	Size     int64
	MimeType string
	Body     io.ReadCloser
}
