package handler

import (
	"errors"

	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

const workspaceContextKey = "canvas.workspace"

func WorkspaceMiddleware(scope workspace.Context) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(workspaceContextKey, scope)
		c.Next()
	}
}

func CurrentWorkspace(c *gin.Context) (workspace.Context, error) {
	value, exists := c.Get(workspaceContextKey)
	if !exists {
		return workspace.Context{}, errors.New("本地工作区上下文未初始化")
	}
	scope, ok := value.(workspace.Context)
	if !ok {
		return workspace.Context{}, errors.New("本地工作区上下文无效")
	}
	if err := scope.Validate(); err != nil {
		return workspace.Context{}, err
	}
	return scope, nil
}
