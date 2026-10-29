package handler

import (
	"errors"
	"net/http"
	"time"

	"infinite-canvas/backend/internal/app"
	localtask "infinite-canvas/backend/internal/task"

	"github.com/gin-gonic/gin"
)

func RegisterTaskRoutes(r *gin.RouterGroup, svc *app.Service, hostedProfile ...bool) {
	registerMediaUpscaleRoutes(r, svc)
	r.POST("/tasks", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "任务只能由当前桌面界面创建") {
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "tasks:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<20)
		var req localtask.CreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		req.TraceID = TraceID(c)
		req.RequestID = RequestID(c)
		task, err := requestGenerationPort(c, svc).CreateTask(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, task)
	})
	r.POST("/timeline/transcriptions", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "字幕转写只能由当前桌面界面创建") {
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "timeline-ts:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var req localtask.TimelineTranscriptionCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		req.TraceID = TraceID(c)
		req.RequestID = RequestID(c)
		task, err := requestTaskPort(c, svc).CreateTimelineTranscriptionTask(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, task)
	})
	r.POST("/timeline/renders", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "时间线渲染只能由当前桌面界面创建") {
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "timeline-render:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<20)
		var req localtask.TimelineRenderCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		req.TraceID = TraceID(c)
		req.RequestID = RequestID(c)
		task, err := requestTaskPort(c, svc).CreateTimelineRenderTask(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, task)
	})
	r.POST("/timeline/render-plan", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "timeline-plan:"+user.ID, policy.Request.CanvasWritePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<20)
		var req app.TimelineRenderPlanRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		plan, err := svc.CompileTimelineRenderPlan(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, plan)
	})
	r.POST("/depth-captures", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "深度捕捉只能由当前桌面界面创建") {
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "depth-capture:"+user.ID, policy.Request.TaskCreatePerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var req localtask.DepthCaptureCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		req.TraceID = TraceID(c)
		req.RequestID = RequestID(c)
		task, err := requestTaskPort(c, svc).CreateDepthCaptureTask(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, task)
	})
	r.GET("/tasks", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 50)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		tasks, err := requestTaskPort(c, svc).TasksWithOptions(user.ID, localtask.ListOptions{
			Limit:      pageSize,
			ProjectID:  c.Query("projectId"),
			ActiveOnly: c.Query("activeOnly") == "true",
		})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, tasks)
	})
	r.GET("/tasks/by-operation/:operationId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		task, err := svc.TaskByClientOperation(user.ID, c.Query("projectId"), c.Param("operationId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, task)
	})
	r.GET("/tasks/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		task, err := svc.Task(user.ID, c.Param("id"))
		if err != nil {
			fail(c, http.StatusNotFound, err)
			return
		}
		ok(c, task)
	})
	registerTaskTextReplayRoutes(r, svc)
	r.POST("/tasks/:id/retry", func(c *gin.Context) {
		if !requireTrustedDesktopWritePrincipal(c, "任务只能由当前桌面界面重试") {
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		task, err := svc.RetryTask(user.ID, c.Param("id"))
		if err != nil {
			var appErr *app.AppError
			if errors.As(err, &appErr) {
				failService(c, err)
			} else {
				fail(c, http.StatusBadRequest, err)
			}
			return
		}
		ok(c, task)
	})
	r.POST("/tasks/:id/query-provider", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.QueryFailedVideoTask(c.Request.Context(), user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/tasks/:id/cancel", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		task, err := svc.CancelTask(c.Request.Context(), user.ID, c.Param("id"))
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		ok(c, task)
	})
	r.GET("/tasks/:id/logs", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		logs, err := svc.TaskLogs(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, logs)
	})
}
