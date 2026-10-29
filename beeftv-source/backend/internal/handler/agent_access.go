package handler

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
)

// requireOwner 是所有 owner 级入口的唯一准入判断：本机同源 + owner 凭据。
// 统一在这里，避免每个文件各写一份表达式。
func requireOwner(c *gin.Context, svc *app.Service) bool {
	if !isLoopbackRequest(c.Request) {
		fail(c, http.StatusForbidden, app.BadAuthRequest("只接受本机同源请求"))
		return false
	}
	if !agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader("X-Beeftv-Owner"))) {
		fail(c, http.StatusForbidden, app.BadAuthRequest("该操作需要 owner 凭据"))
		return false
	}
	return true
}
