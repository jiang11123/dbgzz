package handler

import (
	"context"
	"infinite-canvas/backend/internal/app"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// BusinessCatalog describes only mounted business handlers. It never grants
// desktop trust or accepts a model-supplied URL or header map.
type BusinessTool struct {
	ID                string         `json:"id"`
	Summary           string         `json:"summary"`
	Method            string         `json:"method"`
	Path              string         `json:"path"`
	ReadOnly          bool           `json:"readOnly"`
	SubmitsGeneration bool           `json:"submitsGeneration"`
	Cost              string         `json:"cost,omitempty"`
	Params            map[string]any `json:"params"`
}
type BusinessCatalog struct{ Tools []BusinessTool }
type externalBusinessKey struct{}
type externalBusinessPrincipal struct{ ReadOnly bool }

func IsLocalBusinessRequest(r *http.Request) bool { return isLoopbackRequest(r) }

func WithExternalBusinessPrincipal(r *http.Request, readOnly bool) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), externalBusinessKey{}, externalBusinessPrincipal{ReadOnly: readOnly}))
}
func externalBusiness(c *gin.Context) (externalBusinessPrincipal, bool) {
	p, ok := c.Request.Context().Value(externalBusinessKey{}).(externalBusinessPrincipal)
	return p, ok
}

func businessRouteAllowed(method, p string) bool {
	// Public market reads are ordinary discovery. Publishing grants, private
	// drafts and the two confirmation actions remain on the desktop UI path.
	if p == "/skills/market" || strings.HasPrefix(p, "/skills/market/") {
		if method != http.MethodGet {
			return false
		}
		switch p {
		case "/skills/market/search", "/skills/market/catalog", "/skills/market/releases/:skillId/:releaseId", "/skills/market/versions/:skillId":
			return true
		default:
			return false
		}
	}
	for _, prefix := range []string{"/assets", "/asset-folders", "/resources", "/canvas-projects", "/canvas-folders", "/projects", "/project-folders", "/voice-profiles", "/style-profiles", "/tasks", "/timeline", "/depth-captures", "/creation-runs", "/creation-conversations", "/skills", "/plugins", "/runninghub", "/settings/prompt-templates"} {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return p == "/workspace/model-config" || p == "/workspace/bootstrap" || p == "/ai/models"
}

func NewBusinessCatalog(routes gin.RoutesInfo) *BusinessCatalog {
	c := &BusinessCatalog{}
	for _, route := range routes {
		p := strings.TrimPrefix(route.Path, "/api")
		if !strings.HasPrefix(route.Path, "/api/") || !businessRouteAllowed(route.Method, p) {
			continue
		}
		readOnly := route.Method == http.MethodGet || p == "/timeline/render-plan"
		properties := map[string]any{"path": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}, "query": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}}, "body": map[string]any{"type": "object", "additionalProperties": true}}
		pathProperties := map[string]any{}
		required := []string{}
		for _, part := range strings.Split(p, "/") {
			if strings.HasPrefix(part, ":") {
				n := strings.TrimPrefix(part, ":")
				pathProperties[n] = map[string]any{"type": "string", "minLength": 1}
				required = append(required, n)
			}
		}
		properties["path"] = map[string]any{"type": "object", "properties": pathProperties, "required": required, "additionalProperties": false}
		if p == "/resources" && route.Method == http.MethodPost || p == "/skills/install" || p == "/plugins" && route.Method == http.MethodPost {
			properties["file"] = map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}, "mimeType": map[string]any{"type": "string"}, "data": map[string]any{"type": "string", "description": "Base64 file bytes"}}, "required": []string{"name", "data"}, "additionalProperties": false}
		}
		id := "business_" + strings.ToLower(route.Method) + "_" + strings.NewReplacer("/", "_", ":", "", "-", "_").Replace(strings.TrimPrefix(p, "/"))
		c.Tools = append(c.Tools, BusinessTool{ID: id, Summary: route.Method + " " + p, Method: route.Method, Path: p, ReadOnly: readOnly, Params: map[string]any{"type": "object", "properties": properties, "additionalProperties": false}})
	}
	sort.Slice(c.Tools, func(i, j int) bool { return c.Tools[i].ID < c.Tools[j].ID })
	enrichBusinessSchemas(c)
	for i := range c.Tools {
		t := &c.Tools[i]
		if t.Method == "POST" && (t.Path == "/tasks" || t.Path == "/tasks/:id/retry" || t.Path == "/creation-runs/:id/execute") {
			t.SubmitsGeneration = true
			t.Cost = "selected-channel"
			t.Summary += "；提交生成，按所选渠道计费，由外部调用方审批"
		}
	}
	return c
}

func (c *BusinessCatalog) Match(method, p string) (BusinessTool, bool) {
	if method == http.MethodGet && p == "/api/business/tools" {
		return BusinessTool{ReadOnly: true}, true
	}
	p = strings.TrimPrefix(p, "/api")
	for _, tool := range c.Tools {
		if method != tool.Method {
			continue
		}
		a, b := strings.Split(tool.Path, "/"), strings.Split(p, "/")
		if len(a) != len(b) {
			continue
		}
		match := true
		for i := 1; i < len(a); i++ {
			if b[i] == "" || b[i] == "." || b[i] == ".." || strings.ContainsAny(b[i], "\\%") || !strings.HasPrefix(a[i], ":") && a[i] != b[i] {
				match = false
				break
			}
		}
		if match {
			return tool, true
		}
	}
	return BusinessTool{}, false
}

func RegisterBusinessDiscovery(api *gin.RouterGroup, catalog *BusinessCatalog, svc *app.Service) {
	api.GET("/business/tools", func(c *gin.Context) {
		principal, authorized := externalBusiness(c)
		if !authorized {
			if c.GetHeader("X-Beeftv-Client") != "" || !requireOwner(c, svc) {
				return
			}
		}
		okResponse := gin.H{"tools": catalog.Tools, "readOnly": principal.ReadOnly, "authentication": "registered-client", "approval": "external-client"}
		ok(c, okResponse)
	})
}
