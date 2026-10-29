package handler

import (
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantturns"
	"net/http"
)

func registerAssistantContinuationRoutes(r gin.IRouter, svc *app.Service, guard func(*gin.Context, bool) bool) {
	r.POST("/assistant/continuations", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		_, input, valid := readAssistantBody(c, assistantturns.ContinuationInput{})
		if !valid {
			return
		}
		result, err := svc.ArmAssistantContinuation(c.GetString("agentUserId"), input)
		if err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, result)
	})
	r.GET("/assistant/continuations", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		result, err := svc.ListAssistantContinuations(c.GetString("agentUserId"), c.Query("canvasId"), c.Query("sessionId"))
		if err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/assistant/continuations/:id/manifest", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		_, input, valid := readAssistantBody(c, assistantturns.ContinuationManifest{})
		if !valid {
			return
		}
		if err := svc.RegisterAssistantContinuationManifest(c.GetString("agentUserId"), c.Param("id"), input); err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, gin.H{"accepted": true})
	})
	r.POST("/assistant/continuations/:id/claim", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		result, err := svc.ClaimAssistantContinuation(c.GetString("agentUserId"), c.Param("id"))
		if err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/assistant/continuations/cancel", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		_, input, valid := readAssistantBody(c, struct {
			CanvasID  string `json:"canvasId"`
			SessionID string `json:"sessionId"`
		}{})
		if !valid {
			return
		}
		if input.CanvasID == "" || input.SessionID == "" {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("canvasId 与 sessionId 必填"))
			return
		}
		if err := svc.CancelAssistantContinuations(c.GetString("agentUserId"), input.CanvasID, input.SessionID, false); err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, gin.H{"cancelled": true})
	})
	r.POST("/assistant/runtime/continuations/:id/verify", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) || !isAssistantHostRequest(c, svc) {
			c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "forbidden", "msg": "需要内置助手宿主身份"})
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		_, input, valid := readAssistantBody(c, struct {
			TurnID    string `json:"turnId"`
			SessionID string `json:"sessionId"`
		}{})
		if !valid {
			return
		}
		if err = svc.VerifyAssistantContinuation(user.ID, c.Param("id"), input.TurnID, input.SessionID); err != nil {
			skillContextFailure(c, err)
			return
		}
		ok(c, gin.H{"allowed": true})
	})
}
