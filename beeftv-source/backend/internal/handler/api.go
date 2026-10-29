package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/eagle"

	"github.com/gin-gonic/gin"
)

// RegisterCanvasAPI is kept as the standalone-development entrypoint. BeefTV
// has one local-only HTTP surface, so development and Wails use the same route
// graph instead of selecting between desktop and SaaS profiles at runtime.
func RegisterCanvasAPI(api *gin.RouterGroup, svc *app.Service) {
	registerDesktopCanvasAPI(api, svc, defaultRuntimeDependencies(svc))
}

// RegisterDesktopCanvasAPI keeps the desktop profile local-first. The server
// profile still exposes hosted routes for backward compatibility.
func RegisterDesktopCanvasAPI(api *gin.RouterGroup, svc *app.Service) {
	RegisterDesktopCanvasAPIWithDependencies(api, svc, defaultRuntimeDependencies(svc))
}

func defaultRuntimeDependencies(svc *app.Service) RuntimeDependencies {
	adapter := newServiceRuntimeAdapter(svc)
	dependencies := RuntimeDependencies{
		RequestCoordinator: adapter, ProviderConfig: adapter, Assets: adapter, Projects: adapter, Tasks: adapter, Generation: adapter,
		Eagle: eagle.New(),
	}
	if svc != nil {
		dependencies.Diagnostics = svc.DiagnosticsDomain()
		dependencies.Appearance = svc.AppearanceDomain()
	}
	return dependencies
}

func RegisterDesktopCanvasAPIWithDependencies(api *gin.RouterGroup, svc *app.Service, dependencies RuntimeDependencies) {
	registerDesktopCanvasAPI(api, svc, dependencies)
}

// registerDesktopCanvasAPI is deliberately a separate call graph. Keeping the
// local composition root free of runtime profile branches lets the Go linker
// discard hosted handlers and their SaaS-only service methods from BeefTV.
func registerDesktopCanvasAPI(api *gin.RouterGroup, svc *app.Service, dependencies RuntimeDependencies) {
	// A process supervisor needs an explicit Close owner. Only the composition
	// root supplies it; standalone route registration must not create a child
	// whose lifetime has no owner.
	api.Use(RuntimeDependenciesMiddleware(dependencies))
	api.Use(SupportTracingMiddleware(svc))
	RegisterOpenAPIRoutes(api)
	RegisterWorkspaceRoutes(api, svc)
	RegisterBeefAPIConnectionRoutes(api, svc)
	RegisterDesktopAppearanceRoutes(api, svc)
	RegisterDesktopFeatureAvailabilityRoutes(api, svc)
	// 旧内置 Agent 已从产品运行面退场：这里不再注册 /agent/*，运行、审批和记忆入口
	// 都不能由浏览器或直接 API 触发。历史执行、偏好和记忆数据保留在本地数据库，
	// 不做破坏性迁移；替换内核落地时再设计新的入口契约。
	RegisterCreationRoutes(api, svc)
	RegisterCreationConversationRoutes(api, svc, dependencies.Conversations)
	RegisterChannelModelRoutes(api, svc)
	RegisterCustomRelayRoutes(api, svc)
	RegisterTaskRoutes(api, svc, false)
	RegisterRunningHubRoutes(api, svc, false)
	RegisterDesktopSkillRoutes(api, svc)
	RegisterDesktopUserDataRoutes(api, svc)
	// 登记表在进程内单实例（避免每请求新建导致并发丢记录）。
	// 凭据落盘属于组合根职责：路由注册不产生文件副作用。
	clients := agentops.NewClientRegistry(svc.DataDir())
	// 统一操作层：CLI、MCP 与内置 pi 共用同一组操作与校验，连同一个运行中的工作区。
	if db := svc.Database(); db != nil {
		RegisterAgentOpsRoutes(api, svc, agentops.NewStore(db), clients)
	}
	// 内置创作助手：短期限 UI 会话凭据 + 可信代理；浏览器不接触 owner/宿主/模型凭据。
	uiSessions := newUISessionStore()
	RegisterAgentUISessionRoutes(api, svc, uiSessions, dependencies.DesktopTrust)
	// 外部 Agent 凭据的签发与吊销：只有受信任的桌面界面能进，外部客户端拿不到桌面启动令牌。
	RegisterAgentClientRoutes(api, svc, clients, dependencies.DesktopTrust)
	RegisterAgentProxyRoutes(api, svc, clients, uiSessions, dependencies.AssistantHost)
	// 宿主生命周期：配置当前文本模型与启动命令，显式启停；未配置时返回明确未就绪。
	RegisterAgentHostLifecycleRoutes(api, svc, dependencies.AssistantHost)
	RegisterChunkedUploadRoutes(api, svc, false)
	RegisterDiagnosticsRoutes(api, svc)
	RegisterPluginRoutes(api, svc, false)
	projectAPI := api.Group("")
	projectAPI.Use(RequireFeature(svc, app.FeatureShortDrama))
	RegisterProjectRoutes(projectAPI, svc)
}

func RegisterOpenAPIRoutes(api *gin.RouterGroup) {
	api.GET("/openapi.yaml", func(c *gin.Context) {
		c.Data(http.StatusOK, "application/yaml; charset=utf-8", openAPISpec)
	})
}
