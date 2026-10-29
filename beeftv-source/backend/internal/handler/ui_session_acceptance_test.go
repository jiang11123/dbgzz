package handler

import (
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
)

func TestAssistantAcceptanceRejectsMissingForeignAndExpiredUISessions(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	ui := newUISessionStore()
	valid := ui.issue(owner.ID)
	foreignUser := ui.issue("foreign-workspace-owner")
	foreignStore := newUISessionStore().issue(owner.ID)
	expired := ui.issue(owner.ID)
	expired.ExpiresAt = time.Now().Add(-time.Hour)
	ui.sessions[expired.Token] = expired
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{AssistantHost: env.assistantHost}))
	RegisterAgentProxyRoutes(router.Group("/api"), env.service, agentops.NewClientRegistry(env.service.DataDir()), ui, env.assistantHost)
	env.router = router
	for _, tc := range []struct{ name, token string }{
		{"missing", ""}, {"unknown", "not-issued"}, {"foreign-user", foreignUser.Token}, {"foreign-store", foreignStore.Token}, {"expired", expired.Token},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env.uiToken = tc.token
			for _, route := range []struct{ method, path string }{
				{"GET", "/assistant/sessions?canvasId=" + env.canvasID},
				{"POST", "/assistant/sessions"},
				{"POST", "/assistant/chat"},
				{"POST", "/assistant/cancel"},
			} {
				w := env.call(t, route.method, route.path, `{"canvasId":"`+env.canvasID+`","message":"must not reach host"}`)
				data := decodeEnvelope(t, w)
				if w.Code != http.StatusForbidden || data["__reason"] != "unauthenticated" {
					t.Fatalf("%s: %d %s", route.path, w.Code, w.Body.String())
				}
			}
		})
	}
	// A valid session passes auth and reaches input validation without contacting a host.
	env.uiToken = valid.Token
	w := env.call(t, "POST", "/assistant/sessions", "{}")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("valid UI did not reach input validation: %d %s", w.Code, w.Body.String())
	}
}
