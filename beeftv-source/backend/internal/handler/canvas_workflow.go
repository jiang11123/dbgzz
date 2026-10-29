package handler

import (
	"fmt"
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"net/http"
	"strconv"
	"time"
)

func registerCanvasWorkflowRoutes(r *gin.RouterGroup, svc *app.Service) {
	// Every route resolves the current desktop owner; mutations additionally
	// require the same trusted UI principal as manual generation.
	owner := func(c *gin.Context, write bool) string {
		if write && !requireTrustedDesktopWritePrincipal(c, "工作流只能由当前桌面界面创建和运行") {
			return ""
		}
		user, e := currentUser(c, svc)
		if e != nil {
			failService(c, e)
			return ""
		}
		if write {
			policy, available := loadRuntimePolicy(c, svc)
			if !available || !enforceRateLimit(c, "canvas-workflow:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
				return ""
			}
		}
		return user.ID
	}
	r.GET("/canvas-workflow-operations", func(c *gin.Context) {
		if owner(c, false) == "" {
			return
		}
		ok(c, gin.H{"operations": svc.CanvasWorkflowOperations()})
	})
	r.POST("/canvas-workflows/validate", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req struct {
			Definition       cw.Definition `json:"definition"`
			TemplateID       string        `json:"templateId"`
			TemplateRevision int           `json:"templateRevision"`
		}
		if e := c.ShouldBindJSON(&req); e != nil {
			fail(c, http.StatusBadRequest, e)
			return
		}
		prepared, e := svc.PrepareCanvasWorkflow(user, req.Definition, req.TemplateID, req.TemplateRevision)
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, gin.H{"valid": true, "definition": prepared})
	})
	r.GET("/canvas-workflows/:id/editor", func(c *gin.Context) {
		user := owner(c, false)
		if user == "" {
			return
		}
		revision := 0
		if raw := c.Query("revision"); raw != "" {
			n, e := strconv.Atoi(raw)
			if e != nil || n < 1 {
				fail(c, http.StatusBadRequest, fmt.Errorf("工作流版本必须为正整数"))
				return
			}
			revision = n
		}
		v, e := svc.CanvasWorkflowEditor(user, c.Param("id"), revision)
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.PUT("/canvas-workflows/:id", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req cw.UpdateRequest
		if e := c.ShouldBindJSON(&req); e != nil {
			fail(c, http.StatusBadRequest, e)
			return
		}
		v, e := svc.UpdateCanvasWorkflow(user, c.Param("id"), req)
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.GET("/canvas-workflows", func(c *gin.Context) {
		user := owner(c, false)
		if user == "" {
			return
		}
		v, e := svc.CanvasWorkflows(user)
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, gin.H{"workflows": v})
	})
	r.POST("/canvas-workflows", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req cw.CreateRequest
		if e := c.ShouldBindJSON(&req); e != nil {
			fail(c, http.StatusBadRequest, e)
			return
		}
		v, e := svc.CreateCanvasWorkflow(user, req)
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.GET("/canvas-workflows/:id", func(c *gin.Context) {
		user := owner(c, false)
		if user == "" {
			return
		}
		v, e := svc.CanvasWorkflow(user, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.DELETE("/canvas-workflows/:id", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		if e := svc.DeleteCanvasWorkflow(user, c.Param("id")); e != nil {
			failService(c, e)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.GET("/canvas-workflows/:id/runs", func(c *gin.Context) {
		user := owner(c, false)
		if user == "" {
			return
		}
		v, e := svc.CanvasWorkflowRuns(user, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, gin.H{"runs": v})
	})
	r.POST("/canvas-workflows/:id/runs", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req cw.RunRequest
		if e := c.ShouldBindJSON(&req); e != nil {
			fail(c, http.StatusBadRequest, e)
			return
		}
		v, e := svc.StartCanvasWorkflow(user, c.Param("id"), req)
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.GET("/canvas-workflow-runs/:id", func(c *gin.Context) {
		user := owner(c, false)
		if user == "" {
			return
		}
		v, e := svc.CanvasWorkflowRun(user, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.POST("/canvas-workflow-runs/:id/retry", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		v, e := svc.RetryCanvasWorkflow(user, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
	r.POST("/canvas-workflow-runs/:id/select-image", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		var request struct {
			NodeID     string `json:"nodeId"`
			ResourceID string `json:"resourceId"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, fmt.Errorf("请选择图片"))
			return
		}
		value, err := svc.SelectCanvasWorkflowImage(user, c.Param("id"), request.NodeID, request.ResourceID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})
	r.POST("/canvas-workflow-runs/:id/cancel", func(c *gin.Context) {
		user := owner(c, true)
		if user == "" {
			return
		}
		v, e := svc.CancelCanvasWorkflow(c.Request.Context(), user, c.Param("id"))
		if e != nil {
			failService(c, e)
			return
		}
		ok(c, v)
	})
}
