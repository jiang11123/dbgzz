package desktopstorage

// Progress never exposes individual file paths or contents.
type Progress struct {
	Phase          string `json:"phase"`
	Detail         string `json:"detail"`
	LoadedBytes    int64  `json:"loadedBytes"`
	TotalBytes     int64  `json:"totalBytes"`
	CompletedFiles int    `json:"completedFiles"`
	TotalFiles     int    `json:"totalFiles"`
}
