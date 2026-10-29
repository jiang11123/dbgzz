package handler

import "strings"

// Query metadata for desktop handlers absent from the legacy OpenAPI document.
// Values travel as URL strings; each handler remains the validation authority.
func enrichBusinessQueries(tool *BusinessTool) {
	queries := map[string]string{
		"GET /resources":                             "pageSize=200",
		"GET /resources/:id/file":                    "direct proxy variant",
		"GET /assets":                                "page=1 pageSize=40 folderId kind category uncategorized status q favorite recent project generated",
		"DELETE /assets/:id":                         "expectedStatus",
		"GET /canvas-projects":                       "page=1 pageSize=40 projectId q sort",
		"GET /projects":                              "page=1 pageSize=50",
		"GET /projects/:id/assets":                   "page=1 pageSize=40 folderId category mediaType status q usage",
		"GET /projects/:id/asset-candidates":         "page=1 pageSize=100 unitId status category q",
		"GET /projects/:id/chapter-apply-receipts":   "taskIds",
		"GET /tasks":                                 "pageSize=50 projectId activeOnly",
		"GET /tasks/:id/text-events":                 "after",
		"GET /skills":                                "page=1 pageSize=20 scope=public search tag sort=popular",
		"GET /skills/:id/file":                       "path",
		"GET /skills/:id/file/raw":                   "path",
		"GET /skills/:id/search":                     "q",
		"DELETE /creation-conversations/:id":         "expectedRevision",
		"GET /plugins/catalog":                       "scope=user.custom-channel capability",
		"GET /plugins/eagle/library":                 "baseUrl",
		"GET /plugins/eagle/items":                   "baseUrl folderId keyword limit=60 offset=0",
		"GET /plugins/eagle/items/:itemId/file":      "baseUrl",
		"GET /plugins/eagle/items/:itemId/thumbnail": "baseUrl",
		"POST /plugins/eagle/items":                  "baseUrl",
		"POST /plugins/eagle/folders":                "baseUrl",
	}
	fieldsText, exists := queries[tool.Method+" "+tool.Path]
	if !exists {
		return
	}
	properties := tool.Params["properties"].(map[string]any)
	query := properties["query"].(map[string]any)
	fields, _ := query["properties"].(map[string]any)
	if fields == nil {
		fields = map[string]any{}
		query["properties"] = fields
	}
	for _, text := range strings.Fields(fieldsText) {
		name, defaultValue, hasDefault := strings.Cut(text, "=")
		if _, present := fields[name]; present {
			continue
		}
		field := map[string]any{"type": "string", "description": "URL query value; validated by the existing business handler"}
		if hasDefault {
			field["default"] = defaultValue
		}
		fields[name] = field
	}
	if tool.Method == "DELETE" && tool.Path == "/creation-conversations/:id" {
		query["required"] = []string{"expectedRevision"}
	}
}
