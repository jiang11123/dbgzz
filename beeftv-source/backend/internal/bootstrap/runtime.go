package bootstrap

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/assistantruntime"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/buildinfo"
	"infinite-canvas/backend/internal/conversation"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/depthcapture"
	"infinite-canvas/backend/internal/eagle"
	canvasHandler "infinite-canvas/backend/internal/handler"
	"infinite-canvas/backend/internal/localapp"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/runtimeinfo"
	httptransport "infinite-canvas/backend/internal/transport/http"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/agentops"
)

type Runtime struct {
	workspaceLock    *os.File
	cfg              Config
	db               *gorm.DB
	service          *app.Service
	localApp         *localapp.App
	handler          http.Handler
	status           *systemStatus
	launchToken      string
	uiBootstrapToken string
	beefAPI          *beefapi.Service
	assistantHost    *assistantruntime.Host
	listener         net.Listener
	httpServer       *http.Server
	serveErr         chan error
	started          atomic.Bool
	closed           atomic.Bool
	closeOnce        sync.Once
	backgroundDone   chan struct{}
	closeErr         error
}

func Open(_ context.Context, raw Config) (result *Runtime, openErr error) {
	cfg := raw.withDefaults()
	if cfg.Profile != ProfileServer && cfg.Profile != ProfileDesktop {
		return nil, fmt.Errorf("不支持的运行模式：%s", cfg.Profile)
	}
	if strings.TrimSpace(cfg.DataDir) == "" {
		return nil, errors.New("后端数据目录不能为空")
	}
	if cfg.Profile == ProfileDesktop && !strings.HasPrefix(cfg.ListenAddr, "127.0.0.1:") {
		return nil, errors.New("桌面运行时只能监听 127.0.0.1")
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	var workspaceLock *os.File
	if cfg.Profile == ProfileDesktop {
		var err error
		workspaceLock, err = runtimeinfo.LockWorkspace(cfg.DataDir)
		if err != nil {
			return nil, err
		}
		defer func() {
			if openErr != nil {
				_ = workspaceLock.Close()
			}
		}()
	}
	db, err := database.Open(database.Config{Driver: cfg.DatabaseDriver, DSN: cfg.DatabaseURL, DataDir: cfg.DataDir})
	if err != nil {
		return nil, err
	}
	cleanupDB := func() {
		if sqlDB, sqlErr := db.DB(); sqlErr == nil {
			_ = sqlDB.Close()
		}
	}
	if err := database.ConfigurePool(db); err != nil {
		cleanupDB()
		return nil, err
	}
	if cfg.AutoMigrate {
		err = database.MigrateLocalSchema(db)
	} else {
		err = database.RequireLocalSchema(db)
	}
	if err != nil {
		cleanupDB()
		return nil, err
	}

	repo := repository.New(db)
	if cfg.Profile == ProfileDesktop {
		if err := repo.PauseDepthCapturesAfterRestart(context.Background()); err != nil {
			cleanupDB()
			return nil, err
		}
	}
	svc := app.NewLocal(repo, cfg.DataDir)
	cleanupService := func() {
		_ = svc.Close()
		cleanupDB()
	}
	if err := initializeService(svc); err != nil {
		cleanupService()
		return nil, err
	}
	providerConfig, configErr := workspace.NewProviderConfig(cfg.DataDir)
	if configErr != nil {
		cleanupService()
		return nil, configErr
	}
	beefAPIConnection, beefAPIErr := beefapi.New(beefapi.Options{
		DataDir: cfg.DataDir, Provider: providerConfig, ClientVersion: buildinfo.Current().Version,
		FetchCatalog: func(apiKey, baseURL string) ([]beefapi.CatalogModel, error) {
			owner, ownerErr := svc.LocalWorkspaceOwner()
			if ownerErr != nil {
				return nil, ownerErr
			}
			items, catalogErr := svc.FetchChannelModelCatalog(context.Background(), owner, app.ChannelModelsRequest{
				BaseURL: baseURL, APIKey: apiKey, APIFormat: "openai", ChannelID: beefapi.ChannelID, CredentialRef: beefapi.CredentialRef,
			})
			if catalogErr != nil {
				return nil, catalogErr
			}
			models := make([]beefapi.CatalogModel, 0, len(items))
			for _, item := range items {
				version := ""
				if item.VideoCapabilitiesVersion != nil {
					version = *item.VideoCapabilitiesVersion
				}
				models = append(models, beefapi.CatalogModel{
					ID: item.ID, DisplayName: item.DisplayName, ModelType: item.ModelType, SupportedEndpointTypes: item.SupportedEndpointTypes,
					VideoCapabilities: item.VideoCapabilities, VideoCapabilitiesVersion: version,
					VideoPricing: item.VideoPricing,
				})
			}
			return models, nil
		},
	})
	if beefAPIErr != nil {
		cleanupService()
		return nil, beefAPIErr
	}
	svc.SetBeefAPI(beefAPIConnection)
	localKernel := app.NewLocalKernel(svc)
	assetService := svc.ResourceService()
	projectService := svc.ProjectService()
	taskService := svc.TaskService()
	localRoot, err := localapp.New(localapp.Options{
		Workspace: workspace.NewService(repo), Projects: projectService, Assets: assetService, Tasks: taskService,
		Generation: taskService, ProviderConfig: providerConfig, Lifecycle: localKernel,
	})
	if err != nil {
		cleanupService()
		return nil, err
	}

	owner, ownerErr := svc.LocalWorkspaceOwner()
	if ownerErr != nil {
		cleanupService()
		return nil, ownerErr
	}
	scope := workspace.Context{ID: owner.ID, DataDir: cfg.DataDir}

	// 桌面启动令牌在构建路由前解析：它既是整个 API 的入口凭据，也是「本机受信任 UI」
	// 的判据（内置助手签发 UI 会话时使用）。服务端形态没有它，DesktopTrust 为 nil。
	launchToken := ""
	uiBootstrapToken := ""
	if cfg.Profile == ProfileDesktop {
		uiBootstrapToken, err = httptransport.NewLaunchToken()
		if err != nil {
			cleanupService()
			return nil, err
		}
		launchToken = strings.TrimSpace(cfg.LaunchToken)
		if launchToken == "" {
			launchToken, err = httptransport.NewLaunchToken()
			if err != nil {
				cleanupService()
				return nil, err
			}
		}
	}

	router := gin.New()
	router.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		return fmt.Sprintf("%s - [%s] \"%s %s\" %d %s %s\n", param.ClientIP, param.TimeStamp.Format(time.RFC3339), param.Method, param.Path, param.StatusCode, param.Latency, param.ErrorMessage)
	}), gin.Recovery())
	router.Use(canvasHandler.RequestCorrelationMiddleware())
	for _, middleware := range cfg.RouterMiddleware {
		router.Use(middleware)
	}
	if cfg.Profile == ProfileDesktop {
		router.Use(desktopCORSMiddleware())
	}
	router.Use(canvasHandler.WorkspaceMiddleware(scope))
	// 本机可信凭据在组合根生成：owner 凭据与宿主凭据只在本机数据目录，0600。
	agentops.EnsureAgentCredentials(svc.DataDir())
	assistantHost := assistantruntime.New(assistantruntime.OptionsFromService(svc))
	svc.SetAssistantContinuationSubmitter(canvasHandler.AssistantContinuationSubmitter(svc, assistantHost))
	api := router.Group("/api")
	status := newSystemStatus(db, svc, true)
	registerSystemStatusRoutes(api, status)
	canvasHandler.RegisterDesktopCanvasAPIWithDependencies(api, svc, canvasHandler.RuntimeDependencies{
		RequestCoordinator: localKernel,
		ProviderConfig:     localRoot.ProviderConfig,
		Assets:             localRoot.Assets,
		Projects:           localRoot.Projects,
		Tasks:              localRoot.Tasks,
		Generation:         localRoot.Generation,
		BeefAPI:            beefAPIConnection,
		AssistantHost:      assistantHost,
		Conversations:      conversation.New(conversation.NewStore(repo)),
		TextReplay:         svc.TextReplay(),
		Appearance:         svc.AppearanceDomain(),
		Diagnostics:        svc.DiagnosticsDomain(),
		Eagle:              eagle.New(),
		DesktopTrust:       desktopTrust(launchToken, uiBootstrapToken),
	})
	businessCatalog := canvasHandler.NewBusinessCatalog(router.Routes())
	canvasHandler.RegisterBusinessDiscovery(api, businessCatalog, svc)
	router.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "msg": "请求不存在"})
	})

	rootHandler := http.Handler(router)
	protected := rootHandler
	if launchToken != "" {
		protected = httptransport.RequireLaunchToken(launchToken)(rootHandler)
	}
	clients := agentops.NewClientRegistry(svc.DataDir())
	rootHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tool, allowed := businessCatalog.Match(r.Method, r.URL.Path); allowed && isLoopbackRemote(r.RemoteAddr) {
			if reg, valid := clients.Lookup(r.Header.Get("X-Beeftv-Client"), strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))); valid {
				if reg.Mode == agentops.ClientReadOnly && !tool.ReadOnly {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusForbidden)
					_, _ = w.Write([]byte(`{"code":403,"reason":"read_only_client","msg":"此连接仅支持读取"}`))
					return
				}
				if r.Header.Get("X-Beeftv-Agent-Turn") != "" || r.Header.Get("X-Beeftv-Agent-Token") != "" || !canvasHandler.IsLocalBusinessRequest(r) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusForbidden)
					_, _ = w.Write([]byte(`{"code":403,"reason":"invalid_external_identity","msg":"外部调用不能使用助手身份"}`))
					return
				}
				router.ServeHTTP(w, canvasHandler.WithExternalBusinessPrincipal(r, reg.Mode == agentops.ClientReadOnly))
				return
			}
			if r.Header.Get("X-Beeftv-Client") == "" && agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(r.Header.Get("X-Beeftv-Owner"))) && canvasHandler.IsLocalBusinessRequest(r) {
				if launchToken != "" && r.Header.Get("X-Desktop-Token") != launchToken {
					protected.ServeHTTP(w, r)
					return
				}
				router.ServeHTTP(w, canvasHandler.WithExternalBusinessPrincipal(r, false))
				return
			}
		}
		// External clients receive only their own capability token, never shell credentials.
		// Shared operations also accept registered local clients. Business handlers
		// above use the same mounted catalog for discovery and authorization.
		// Credential issuance and runtime administration retain desktop trust.
		if isOpsEntryPath(r) && isLoopbackRemote(r.RemoteAddr) {
			if _, ok := clients.Lookup(r.Header.Get("X-Beeftv-Client"), strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))); ok {
				router.ServeHTTP(w, r)
				return
			}
		}
		if r.Header.Get("X-Beeftv-Client") != "" {
			if launchToken != "" && r.Header.Get("X-Desktop-Token") != launchToken {
				protected.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"code":403,"reason":"external_business_forbidden","msg":"该接口不支持外部调用"}`))
			return
		}
		protected.ServeHTTP(w, r)
	})
	return &Runtime{
		workspaceLock:    workspaceLock,
		cfg:              cfg,
		db:               db,
		service:          svc,
		localApp:         localRoot,
		handler:          rootHandler,
		status:           status,
		launchToken:      launchToken,
		uiBootstrapToken: uiBootstrapToken,
		beefAPI:          beefAPIConnection,
		assistantHost:    assistantHost,
		serveErr:         make(chan error, 1),
	}, nil
}

func initializeService(svc *app.Service) error {
	if err := svc.ValidateRuntime(); err != nil {
		return err
	}
	initializers := []func() error{
		svc.EnsureDefaultPromptTemplates,
		svc.EnsureBuiltinProjectWorkflowTemplate,
		svc.EnsureBuiltinSkills,
		svc.EnsureSkillPackages,
	}
	for _, initialize := range initializers {
		if err := initialize(); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) Handler() http.Handler { return r.handler }

func (r *Runtime) Start() error {
	if r == nil || r.closed.Load() {
		return errors.New("运行时已关闭")
	}
	if !r.started.CompareAndSwap(false, true) {
		return nil
	}
	listener, err := net.Listen("tcp", r.cfg.ListenAddr)
	if err != nil {
		r.started.Store(false)
		return err
	}
	r.listener = listener
	httpContext, cancelHTTP := context.WithCancel(context.Background())
	r.httpServer = &http.Server{Handler: r.handler, ReadHeaderTimeout: 10 * time.Second,
		BaseContext: func(net.Listener) context.Context { return httpContext }}
	// Shutdown waits for streams but does not cancel them. Its callback runs
	// after Durable releases its invocations while the ops listener is alive.
	r.httpServer.RegisterOnShutdown(cancelHTTP)
	if r.localApp != nil {
		r.localApp.Start()
	} else {
		r.service.StartWorker()
	}
	r.backgroundDone = make(chan struct{})
	go func() {
		defer close(r.backgroundDone)
		r.service.RecoverPlaybackTranscodes()
	}()
	// The assistant loads its operation catalog from this server before becoming
	// healthy. Accept requests before synchronously waiting for child readiness.
	go func() {
		err := r.httpServer.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			r.serveErr <- fmt.Errorf("HTTP 服务异常退出：%w", err)
		}
		close(r.serveErr)
	}()
	// 桌面形态：按本机配置拉起内置创作助手宿主（未配置时 no-op），
	// 关闭时由 Runtime.Close 收尾，保证「应用启动链」而不是手工点按钮。
	if r.cfg.Profile == ProfileDesktop {
		opsURL := "http://" + r.listener.Addr().String() + "/api"
		// 运行时发现：端口是动态的，外部客户端靠工作区对应的运行时描述文件找到当前地址，
		// 而不是靠猜端口或拿到桌面启动令牌。写失败不影响应用启动。
		if err := runtimeinfo.Write(r.cfg.DataDir, opsURL, buildinfo.Current().Version); err != nil {
			log.Printf("未能写入运行时地址（外部 Agent 需手动指定 BEEFTV_BASE_URL）：%v", err)
		}
		if r.assistantHost != nil {
			if err := r.assistantHost.Start(opsURL, r.launchToken); err != nil {
				log.Printf("内置创作助手宿主未启动（不影响应用启动）：%v", err)
			}
		}
	}
	if r.beefAPI != nil {
		_ = r.beefAPI.Recover(context.Background())
	}
	r.status.markStarted()
	return nil
}

func (r *Runtime) Ready() bool {
	return r != nil && r.started.Load() && !r.closed.Load() && r.status.snapshot(context.Background()).Ready
}

func (r *Runtime) BaseURL() string {
	if r == nil || r.listener == nil {
		return ""
	}
	return "http://" + r.listener.Addr().String() + "/api"
}

func (r *Runtime) LaunchToken() string {
	if r == nil {
		return ""
	}
	return r.launchToken
}

func (r *Runtime) UIBootstrapToken() string { return r.uiBootstrapToken }

func (r *Runtime) Errors() <-chan error {
	if r == nil {
		closed := make(chan error)
		close(closed)
		return closed
	}
	return r.serveErr
}

func (r *Runtime) DepthComponents() *depthcapture.Service { return r.service.DepthComponents() }

func (r *Runtime) PrepareStorageMigration(ctx context.Context) (func(), error) {
	return r.service.PrepareStorageMigration(ctx)
}

func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		r.closed.Store(true)
		r.status.beginDrain()
		var failures []error
		// Durable must release its invocations while Go authorization and ops
		// are still reachable; closing HTTP first turns Quit into fetch errors.
		if r.assistantHost != nil {
			if err := r.assistantHost.StopContext(ctx); err != nil {
				failures = append(failures, err)
			}
		}
		if r.beefAPI != nil {
			r.beefAPI.Close()
		}
		if err := r.DepthComponents().CloseComponents(ctx); err != nil {
			failures = append(failures, fmt.Errorf("暂停组件下载：%w", err))
		}
		// 干净退出先撤掉运行时地址：留着会让下一次发现连到一个已经不在的端口。
		if r.cfg.Profile == ProfileDesktop {
			if err := runtimeinfo.Remove(r.cfg.DataDir); err != nil {
				failures = append(failures, fmt.Errorf("清理运行时地址：%w", err))
			}
		}
		if r.httpServer != nil {
			httpCtx, cancel := context.WithTimeout(ctx, min(30*time.Second, r.cfg.ShutdownTimeout))
			if err := r.httpServer.Shutdown(httpCtx); err != nil {
				_ = r.httpServer.Close()
				failures = append(failures, fmt.Errorf("关闭 HTTP 服务：%w", err))
			}
			cancel()
		}
		workerCtx, cancel := context.WithTimeout(ctx, r.cfg.ShutdownTimeout)
		var workerErr error
		if r.localApp != nil {
			workerErr = r.localApp.Stop(workerCtx)
		} else {
			workerErr = r.service.StopWorker(workerCtx)
		}
		if workerErr != nil {
			failures = append(failures, fmt.Errorf("等待后台任务退出：%w", workerErr))
		}
		cancel()
		if r.backgroundDone != nil {
			select {
			case <-r.backgroundDone:
			default:
				select {
				case <-r.backgroundDone:
				case <-ctx.Done():
					failures = append(failures, fmt.Errorf("等待初始化任务退出：%w", ctx.Err()))
				}
			}
		}
		var serviceErr error
		if r.localApp != nil {
			serviceErr = r.localApp.Close()
		} else {
			serviceErr = r.service.Close()
		}
		if serviceErr != nil {
			failures = append(failures, serviceErr)
		}
		if sqlDB, err := r.db.DB(); err == nil {
			if err := sqlDB.Close(); err != nil {
				failures = append(failures, err)
			}
		}
		r.closeErr = errors.Join(failures...)
		if r.workspaceLock != nil {
			_ = r.workspaceLock.Close()
		}
	})
	return r.closeErr
}

func desktopCORSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := strings.TrimSpace(c.GetHeader("Origin"))
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
		}
		c.Header("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Traceparent, X-Desktop-Token, X-Beeftv-UI-Bootstrap, X-Beeftv-Ui-Session, X-Canvas-Trace-ID, X-Idempotency-Key, X-Canvas-Scene, X-Canvas-Upstream-URL, X-Canvas-Upstream-Format, X-Canvas-Upstream-Base-URL, X-Canvas-Upstream-Headers")
		c.Header("Access-Control-Expose-Headers", "X-Request-ID, X-Canvas-Trace-ID, X-Diagnostic-Bundle-ID, X-Diagnostic-Schema-Version")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// isOpsEntryPath 只认操作层的两个入口：GET /api/ops 与 POST /api/ops/<op>。
// /api/ops/clients 是凭据签发，不在豁免范围；带子路径的形态也一律不算。
func isOpsEntryPath(r *http.Request) bool {
	path := r.URL.Path
	if r.Method == http.MethodGet && path == "/api/ops" {
		return true
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(path, "/api/ops/") {
		return false
	}
	op := strings.TrimPrefix(path, "/api/ops/")
	return op != "" && op != "clients" && !strings.Contains(op, "/")
}

// isLoopbackRemote 保证豁免只对本机连接生效。
func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	parsed := net.ParseIP(strings.Trim(host, "[]"))
	return parsed != nil && parsed.IsLoopback()
}

// desktopTrust 用桌面启动令牌判定请求是否来自受信任的桌面壳。
// 令牌为空（服务端形态）时返回 nil，表示没有这条信任路径。
func desktopTrust(launchToken, uiToken string) func(*http.Request) bool {
	want := []byte(strings.TrimSpace(launchToken))
	if len(want) == 0 {
		return nil
	}
	return func(r *http.Request) bool {
		got := []byte(r.Header.Get(httptransport.LaunchTokenHeader))
		ui := []byte(r.Header.Get("X-Beeftv-UI-Bootstrap"))
		return len(got) == len(want) && subtle.ConstantTimeCompare(got, want) == 1 && len(uiToken) > 0 && subtle.ConstantTimeCompare(ui, []byte(uiToken)) == 1
	}
}
