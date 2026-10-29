package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantturns"
)

func skillContextFailure(c *gin.Context, err error) {
	var contextErr *assistantturns.Error
	if errors.As(err, &contextErr) {
		status := http.StatusBadRequest
		switch contextErr.Reason {
		case "skill_context_revision_conflict", "skill_context_request_conflict", "skill_scope_reset_pending":
			status = http.StatusConflict
		case assistantturns.ReasonNotFound:
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"code": status, "reason": contextErr.Reason, "msg": contextErr.Error()})
		return
	}
	failService(c, err)
}

func registerAssistantSkillContextRoutes(r gin.IRouter, svc *app.Service, guard func(*gin.Context, bool) bool, hostJSON func(*gin.Context, string, string, []byte)) {
	// UI changes always pass through the host's per-canvas lock, including reset.
	r.GET("/assistant/canvases/:canvasId/skill-context", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		if _, err := svc.UserCanvasProject(c.GetString("agentUserId"), c.Param("canvasId")); err != nil {
			failService(c, err)
			return
		}
		hostJSON(c, http.MethodGet, "/skill-context?canvasId="+url.QueryEscape(c.Param("canvasId"))+"&sessionId="+url.QueryEscape(c.Query("sessionId")), nil)
	})
	r.POST("/assistant/canvases/:canvasId/skill-context", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		if _, err := svc.UserCanvasProject(c.GetString("agentUserId"), c.Param("canvasId")); err != nil {
			failService(c, err)
			return
		}
		_, body, valid := readAssistantBody(c, assistantturns.SkillContextChange{})
		if !valid {
			return
		}
		payload, _ := json.Marshal(struct {
			CanvasID string `json:"canvasId"`
			assistantturns.SkillContextChange
		}{CanvasID: c.Param("canvasId"), SkillContextChange: body})
		hostJSON(c, http.MethodPost, "/skill-context", payload)
	})
}

func registerAssistantRuntimeSkillContextRoutes(r gin.IRouter, svc *app.Service) {
	route := func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			fail(c, http.StatusForbidden, app.Forbidden("仅内置助手宿主可以管理技能状态"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		canvasID := c.Param("canvasId")
		if c.Request.Method == http.MethodGet {
			var result *assistantturns.SkillContext
			if turnID := c.Query("turnId"); turnID != "" {
				result, err = svc.BoundAssistantSkillContext(user.ID, turnID, c.Query("sessionId"))
				if err == nil && result.CanvasID != canvasID {
					err = app.Forbidden("画布不匹配")
				}
			} else {
				result, err = svc.AssistantSkillContext(user.ID, canvasID, c.Query("sessionId"))
			}
			if err != nil {
				skillContextFailure(c, err)
				return
			}
			ok(c, result)
			return
		}
		var body struct {
			assistantturns.SkillContextChange
			TurnID  string `json:"turnId"`
			ScopeID string `json:"scopeId"`
			Origin  string `json:"origin"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16384))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil || !errors.Is(decoder.Decode(new(any)), io.EOF) {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("技能状态参数无效"))
			return
		}
		if body.Origin != "" && (body.Origin != "skill_load" || body.TurnID == "" || body.Action != "activate") {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("技能加载参数无效"))
			return
		}
		if body.TurnID != "" {
			current, boundErr := svc.BoundAssistantSkillContext(user.ID, body.TurnID, body.SessionID)
			if boundErr != nil {
				skillContextFailure(c, boundErr)
				return
			}
			if current.CanvasID != canvasID {
				fail(c, http.StatusForbidden, app.Forbidden("画布不匹配"))
				return
			}
			body.SkillContextChange.BoundTurnID = body.TurnID
		}
		var result *assistantturns.SkillContext
		if body.Action == "ack_reset" {
			result, err = svc.AcknowledgeAssistantSkillScope(user.ID, canvasID, body.SessionID, body.ScopeID, body.ExpectedRevision)
		} else if body.Origin == "skill_load" {
			result, err = svc.LoadAssistantTurnSkillContext(user.ID, canvasID, body.TurnID, body.SkillContextChange)
		} else {
			result, err = svc.ChangeAssistantSkillContext(user.ID, canvasID, body.SkillContextChange)
		}
		if err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, result)
	}
	r.GET("/assistant/runtime/canvases/:canvasId/skill-context", route)
	r.POST("/assistant/runtime/canvases/:canvasId/skill-context", route)
}
