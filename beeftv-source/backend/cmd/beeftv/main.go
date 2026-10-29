// beeftv 的工作区命令与内置 pi/MCP 共用本地业务操作层，不另开数据库或 worker。
// skills 子命令直接访问远程技能市场，不要求安装或运行桌面应用。
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"infinite-canvas/backend/internal/runtimeinfo"
)

const mcpStartupTimeout = 5 * time.Second

// resolveBaseURL 决定连哪个工作区，并说明来源（诊断输出用，不含任何凭据）。
//
// 桌面应用监听的是动态端口，所以没有显式 BEEFTV_BASE_URL 时不去猜端口，而是读数据
// 目录对应的运行时描述文件：那是正在运行的桌面后端自己写下的地址。文件里的进程已经退出
// 就当它不存在，绝不拿一个过期端口去连别的进程。
func resolveBaseURL() (string, string) {
	if base := strings.TrimSpace(os.Getenv("BEEFTV_BASE_URL")); base != "" {
		return base, "BEEFTV_BASE_URL"
	}
	if info, found := runtimeinfo.Discover(""); found {
		return info.BaseURL, "运行中的桌面工作区"
	}
	return "", "未发现运行中的工作区"
}

// 退出码：机器可读的失败分类，stderr 输出诊断，stdout 只放业务结果。
const (
	exitOK               = 0
	exitInternal         = 1
	exitUsage            = 2
	exitNotFound         = 3
	exitConflict         = 4
	exitPrecondition     = 5
	exitForbidden        = 6
	exitUnsupported      = 7
	exitBadRequest       = 8
	exitTransportFailure = 9
)

type cliError struct {
	code    int
	reason  string
	msg     string
	details map[string]any
}

func (e *cliError) Error() string { return fmt.Sprintf("%s: %s", e.reason, e.msg) }

// machineError 是可被客户端解析的失败结构（CLI --json 与 MCP 错误共用同一形状）。
func (e *cliError) machineError() map[string]any {
	payload := map[string]any{"code": e.code, "reason": e.reason, "message": e.msg}
	if len(e.details) > 0 {
		payload["details"] = e.details
	}
	return payload
}

type client struct {
	mu           sync.Mutex
	fixedBaseURL bool
	baseURL      string
	clientID     string
	token        string
	ownerToken   string
	desktopToken string
	http         *http.Client
}

type opDescriptor struct {
	ID       string          `json:"id"`
	Summary  string          `json:"summary"`
	ReadOnly bool            `json:"readOnly"`
	Scope    string          `json:"scope"`
	Params   json.RawMessage `json:"params"`
}

func validateBaseURL(base string) error {
	parsedBase, parseErr := url.Parse(base)
	if base == "" {
		return nil
	}
	if parseErr != nil || (parsedBase.Scheme != "http" && parsedBase.Scheme != "https") {
		return &cliError{code: exitUsage, reason: "invalid_base_url", msg: "工作区地址不是合法 URL"}
	}
	if parsedBase.User != nil {
		return &cliError{code: exitUsage, reason: "credentials_in_url", msg: "拒绝对带凭据的 URL 发请求"}
	}
	host := parsedBase.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return &cliError{code: exitUsage, reason: "base_url_not_local", msg: "首版仅支持连接本机工作区，拒绝 " + host}
	}
	return nil
}

func newClient() (*client, error) {
	base, source := resolveBaseURL()
	if err := validateBaseURL(base); err != nil {
		return nil, err
	}
	return &client{
		fixedBaseURL: source == "BEEFTV_BASE_URL",
		baseURL:      strings.TrimRight(base, "/"),
		clientID:     strings.TrimSpace(os.Getenv("BEEFTV_CLIENT_ID")),
		token:        strings.TrimSpace(os.Getenv("BEEFTV_CLIENT_TOKEN")),
		ownerToken:   strings.TrimSpace(os.Getenv("BEEFTV_OWNER_TOKEN")),
		// 桌面形态整个 API 由桌面启动令牌把关：CLI/MCP 要接同一个桌面工作区就必须出示它。
		// 它只是通过守卫，不改变能力模式——能力仍由 owner/已登记客户端凭据决定。
		desktopToken: strings.TrimSpace(os.Getenv("BEEFTV_DESKTOP_TOKEN")),
		// 凭据头是自定义敏感头，不能依赖标准库只保护 Authorization 的行为：一律不跟随重定向。
		http: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}, nil
}

// Re-read the runtime before dispatch, including business uploads. A failed
// write is never replayed: it may already have reached the previous process.
func (c *client) currentBaseURL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.fixedBaseURL {
		c.baseURL = ""
		if info, found := runtimeinfo.Discover(""); found && validateBaseURL(info.BaseURL) == nil {
			c.baseURL = strings.TrimRight(info.BaseURL, "/")
		}
	}
	return c.baseURL
}

func (c *client) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	base := c.currentBaseURL()
	if base == "" {
		return nil, &cliError{code: exitTransportFailure, reason: "runtime_not_found", msg: "未发现运行中的 BeefTV 工作区。请先打开 BeefTV；若使用自定义目录，请检查 BEEFTV_DATA_DIR；独立服务请显式设置 BEEFTV_BASE_URL"}
	}
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, &cliError{code: exitInternal, reason: "encode_failed", msg: err.Error()}
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, payload)
	if err != nil {
		return nil, &cliError{code: exitUsage, reason: "bad_request", msg: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	if c.clientID != "" {
		req.Header.Set("X-Beeftv-Client", c.clientID)
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.ownerToken != "" {
		req.Header.Set("X-Beeftv-Owner", c.ownerToken)
	}
	if c.desktopToken != "" {
		req.Header.Set("X-Desktop-Token", c.desktopToken)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &cliError{code: exitTransportFailure, reason: "transport_failed", msg: fmt.Sprintf("无法连接本地工作区 %s：%v", base, err)}
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if readErr != nil {
		return nil, &cliError{code: exitTransportFailure, reason: "read_failed", msg: readErr.Error()}
	}
	if resp.StatusCode == http.StatusOK {
		var envelope struct {
			Code    int             `json:"code"`
			Data    json.RawMessage `json:"data"`
			Reason  string          `json:"reason"`
			Msg     string          `json:"msg"`
			Details map[string]any  `json:"details"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil || len(envelope.Data) == 0 {
			return nil, &cliError{code: exitInternal, reason: "invalid_envelope", msg: strings.TrimSpace(string(raw[:min(len(raw), 200)]))}
		}
		if envelope.Code != 0 {
			return nil, mapEnvelopeError(envelope.Code, envelope.Reason, envelope.Msg, envelope.Details)
		}
		return envelope.Data, nil
	}
	var failure struct {
		Code    int            `json:"code"`
		Reason  string         `json:"reason"`
		Msg     string         `json:"msg"`
		Details map[string]any `json:"details"`
	}
	_ = json.Unmarshal(raw, &failure)
	return nil, mapEnvelopeError(resp.StatusCode, failure.Reason, failure.Msg, failure.Details)
}

func mapEnvelopeError(status int, reason, msg string, details map[string]any) error {
	code := exitInternal
	switch status {
	case http.StatusNotFound:
		code = exitNotFound
	case http.StatusConflict:
		code = exitConflict
	case http.StatusPreconditionFailed:
		code = exitPrecondition
	case http.StatusForbidden:
		code = exitForbidden
	case http.StatusUnsupportedMediaType:
		code = exitUnsupported
	case http.StatusBadRequest:
		code = exitBadRequest
	case http.StatusUnauthorized, http.StatusTooManyRequests:
		code = exitForbidden
	}
	if msg == "" {
		msg = http.StatusText(status)
	}
	if len(details) > 0 {
		encoded, _ := json.Marshal(details)
		msg = msg + " " + string(encoded)
	}
	return &cliError{code: code, reason: reason, msg: msg, details: details}
}

// listOps 拉取操作清单。
//
// 服务端已经按调用者身份（登记客户端权限/owner）返回基础集合；`--read-only` 在这里
// 只做本地收紧：即使服务端因为任何原因返回了写操作，只读模式也绝不把它们交给
// MCP 或调用方。查询参数不能用于放宽权限，所以客户端不再发送它。
func (c *client) listOps(readOnly bool) ([]opDescriptor, error) {
	return c.listOpsCtx(context.Background(), readOnly)
}

func (c *client) listOpsCtx(ctx context.Context, readOnly bool) ([]opDescriptor, error) {
	raw, err := c.do(ctx, http.MethodGet, "/ops", nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Ops []opDescriptor `json:"ops"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, &cliError{code: exitInternal, reason: "invalid_ops_payload", msg: err.Error()}
	}
	if !readOnly {
		return payload.Ops, nil
	}
	tightened := make([]opDescriptor, 0, len(payload.Ops))
	for _, op := range payload.Ops {
		if op.ReadOnly {
			tightened = append(tightened, op)
		}
	}
	return tightened, nil
}

func (c *client) callOp(opID, requestID string, params json.RawMessage) (json.RawMessage, error) {
	return c.callOpCtx(context.Background(), opID, requestID, params)
}

func (c *client) callOpCtx(ctx context.Context, opID, requestID string, params json.RawMessage) (json.RawMessage, error) {
	body := map[string]any{"opId": requestID, "params": json.RawMessage(params)}
	return c.do(ctx, http.MethodPost, "/ops/"+opID, body)
}

func main() {
	args := os.Args[1:]
	if err := run(args); err != nil {
		code := exitInternal
		payload := map[string]any{"code": code, "reason": "internal_error", "message": err.Error()}
		var cliErr *cliError
		if ok := asCLIError(err, &cliErr); ok {
			code = cliErr.code
			payload = cliErr.machineError()
		}
		payload["exitCode"] = code
		if wantsJSON(args) && !(len(args) > 0 && args[0] == "mcp") {
			// --json 时失败也要机器可读：结构写 stdout，人话留 stderr。
			if encoded, marshalErr := json.Marshal(payload); marshalErr == nil {
				fmt.Println(string(encoded))
			}
		}
		fmt.Fprintf(os.Stderr, "beeftv: %v\n", err)
		os.Exit(code)
	}
	os.Exit(exitOK)
}

// wantsJSON 判断本次调用是否要求 JSON 输出（用于失败路径也给出机器可读结构）。
func wantsJSON(args []string) bool {
	for _, arg := range args {
		if arg == "--json" || arg == "-json" {
			return true
		}
	}
	return false
}

func asCLIError(err error, target **cliError) bool {
	if e, ok := err.(*cliError); ok {
		*target = e
		return true
	}
	return false
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return &cliError{code: exitUsage, reason: "missing_command", msg: "需要一个子命令"}
	}
	// 顶层 --help/-h 与各子命令一致：打印用法后正常退出。
	if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		usage()
		return nil
	}
	if args[0] == "skills" {
		return runSkills(args[1:])
	}
	if args[0] == "diagnostics" {
		return runDiagnostics(args[1:])
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "ops":
		if len(args) > 1 && args[1] == "call" {
			return runOpsCall(c, args[2:])
		}
		fs := flag.NewFlagSet("ops", flag.ContinueOnError)
		readOnly := fs.Bool("read-only", false, "只列出只读操作")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		ops, err := c.listOps(*readOnly)
		if err != nil {
			return err
		}
		if *jsonOut {
			return emitJSON(ops)
		}
		for _, op := range ops {
			kind := "write"
			if op.ReadOnly {
				kind = "read "
			}
			fmt.Printf("%-24s %s  scope=%s  %s\n", op.ID, kind, op.Scope, op.Summary)
		}
		return nil
	case "canvas":
		return runCanvas(c, args[1:])
	case "asset":
		return runAsset(c, args[1:])
	case "task":
		return runTask(c, args[1:])
	case "client":
		return runClient(c, args[1:])
	case "mcp":
		return runMCP(c, args[1:])
	case "business":
		return runBusiness(c, args[1:])
	default:
		usage()
		return &cliError{code: exitUsage, reason: "unknown_command", msg: "未知子命令: " + args[0]}
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `beeftv — BeefTV 业务操作命令行（连接正在运行的本地工作区）

  beeftv skills help  （远程技能市场，无需运行桌面应用）
  beeftv diagnostics analyze --file <diagnostics.zip>  （离线分析，无需运行桌面应用）
  beeftv ops [--read-only] [--json]
  beeftv ops call <operation> --params '<json>' [--operation-id <id>] [--json]
  beeftv business discover
  beeftv business call --tool <id> --params '<path/query/body json>'
  beeftv business upload --file <path> [--target resource|skill|plugin] [--params '<json>']
  beeftv canvas get --canvas <id> [--json]
  beeftv canvas search [--query <q>] [--page N] [--page-size N] [--json]
  beeftv canvas node update --canvas <id> --node <id> --expected-revision N [--title T] [--prompt P] [--content C] --op-id <id>
  beeftv canvas nodes create --canvas <id> --expected-revision N --node <title:type[:prompt]>... --op-id <id>
  beeftv canvas edge create --canvas <id> --from <nodeId> --to <nodeId> --expected-revision N --op-id <id>
  beeftv asset list [--query <q>] [--kind <kind>] [--favorite] [--recent] [--project <name>] [--generated] [--json]
  beeftv asset get --asset <id> [--json]
  beeftv task get --task <id> [--json]
  beeftv client register --label <label> [--kind codex|claude|cursor|other] [--mode read-only|read-write]
  beeftv mcp serve [--read-only]

连接哪个工作区：不设 BEEFTV_BASE_URL 时自动连正在运行的 BeefTV 桌面应用，端口是动态的。
BEEFTV_DATA_DIR 可以指向非默认数据目录。Windows 从用户目录下 .beeftv/runtime 读取对应
工作区的运行信息，其他平台读取数据目录里的 runtime.json。升级后请重新打开 BeefTV。

凭据：在 BeefTV 的设置里新建一个客户端，把它给出的 BEEFTV_CLIENT_ID 与 BEEFTV_CLIENT_TOKEN
填进环境变量即可，不需要桌面令牌。新连接默认开放全部业务工具，操作审批由外部 Agent 管理。
历史只读凭据继续保持只读；CLI 仍支持显式签发只读凭据。

写操作必须带幂等键（CLI 的 --op-id，MCP 工具参数里的 operationId）：重试同一操作要复用同一个值。

环境变量：BEEFTV_BASE_URL、BEEFTV_DATA_DIR、BEEFTV_CLIENT_ID、BEEFTV_CLIENT_TOKEN、
BEEFTV_OWNER_TOKEN（owner 可信通道）、BEEFTV_DESKTOP_TOKEN（桌面自身调用）
退出码：0 成功；2 用法；3 未找到；4 冲突；5 前置条件；6 只读/未授权；7 不支持；8 参数；9 连接失败；1 内部
`)
}

func emitJSON(value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return &cliError{code: exitInternal, reason: "encode_failed", msg: err.Error()}
	}
	fmt.Println(string(encoded))
	return nil
}

func runCanvas(c *client, args []string) error {
	if len(args) == 0 {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "canvas 需要 get|search|node|nodes|edge"}
	}
	switch args[0] {
	case "get":
		fs := flag.NewFlagSet("canvas get", flag.ContinueOnError)
		canvasID := fs.String("canvas", "", "画布 ID")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		if *canvasID == "" {
			return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas 必填"}
		}
		raw, err := c.callOp("canvas.get", "", mustJSON(map[string]any{"canvasId": *canvasID}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	case "search":
		fs := flag.NewFlagSet("canvas search", flag.ContinueOnError)
		query := fs.String("query", "", "搜索关键字")
		page := fs.Int("page", 1, "页码")
		pageSize := fs.Int("page-size", 20, "每页数量")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		raw, err := c.callOp("canvas.search", "", mustJSON(map[string]any{"query": *query, "page": *page, "pageSize": *pageSize}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	case "node":
		if err := requireVerb("node", args, "update"); err != nil {
			return err
		}
		return runCanvasNodeUpdate(c, args[2:])
	case "nodes":
		if err := requireVerb("nodes", args, "create"); err != nil {
			return err
		}
		return runCanvasNodesCreate(c, args[2:])
	case "edge":
		if err := requireVerb("edge", args, "create"); err != nil {
			return err
		}
		return runCanvasEdgeCreate(c, args[2:])
	default:
		return &cliError{code: exitUsage, reason: "unknown_subcommand", msg: "未知 canvas 子命令: " + args[0]}
	}
}

// requireVerb 校验二级子命令：缺失或未知动词直接按用法错误退出，绝不发 HTTP 请求。
func requireVerb(group string, args []string, verb string) error {
	if len(args) < 2 {
		return &cliError{code: exitUsage, reason: "missing_subcommand",
			msg: fmt.Sprintf("canvas %s 需要子命令 %s", group, verb)}
	}
	if args[1] != verb {
		return &cliError{code: exitUsage, reason: "unknown_subcommand",
			msg: fmt.Sprintf("未知的 canvas %s 子命令 %q（只支持 %s）", group, args[1], verb)}
	}
	return nil
}

// flagError 把 -h/--help 视为正常退出，其余解析失败按用法错误。
// 这里绝不能递归调用自己：非法 flag 会直接打爆栈，而不是给用户一条错误。
func flagError(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	return &cliError{code: exitUsage, reason: "bad_flags", msg: err.Error()}
}

func runCanvasNodeUpdate(c *client, args []string) error {
	fs := flag.NewFlagSet("canvas node update", flag.ContinueOnError)
	canvasID := fs.String("canvas", "", "画布 ID")
	nodeID := fs.String("node", "", "节点 ID")
	revision := fs.Int64("expected-revision", 0, "读取画布时的 revision（必填）")
	title := fs.String("title", "", "新标题")
	prompt := fs.String("prompt", "", "新的生成提示词")
	content := fs.String("content", "", "新的内容")
	opID := fs.String("op-id", "", "幂等键（必填）")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	if *canvasID == "" || *nodeID == "" || *opID == "" || *revision <= 0 {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas/--node/--op-id/--expected-revision 均为必填"}
	}
	patch := map[string]any{}
	// 用「flags 是否出现」判断是否传参：显式传空串是清空语义，不允许用非空值猜测。
	fs.Visit(func(flagValue *flag.Flag) {
		switch flagValue.Name {
		case "title":
			patch["title"] = *title
		case "prompt":
			patch["prompt"] = *prompt
		case "content":
			patch["content"] = *content
		}
	})
	if len(patch) == 0 {
		return &cliError{code: exitUsage, reason: "empty_patch", msg: "至少要给出 --title/--prompt/--content 之一"}
	}
	raw, err := c.callOp("canvas.node.update", *opID, mustJSON(map[string]any{
		"canvasId": *canvasID, "nodeId": *nodeID, "expectedRevision": *revision, "patch": patch}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runCanvasNodesCreate(c *client, args []string) error {
	fs := flag.NewFlagSet("canvas nodes create", flag.ContinueOnError)
	canvasID := fs.String("canvas", "", "画布 ID")
	revision := fs.Int64("expected-revision", 0, "读取画布时的 revision（必填）")
	opID := fs.String("op-id", "", "幂等键（必填）")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	var specs stringList
	fs.Var(&specs, "node", "节点，格式 title:type[:prompt]，可重复")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	if *canvasID == "" || *opID == "" || *revision <= 0 || len(specs) == 0 {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas/--op-id/--expected-revision/--node 必填"}
	}
	nodes := make([]map[string]any, 0, len(specs))
	for _, spec := range specs {
		parts := strings.SplitN(spec, ":", 3)
		if len(parts) < 2 {
			return &cliError{code: exitUsage, reason: "bad_node_spec", msg: "节点格式应为 title:type[:prompt]：" + spec}
		}
		node := map[string]any{"title": parts[0], "type": parts[1]}
		if len(parts) == 3 {
			node["prompt"] = parts[2]
		}
		nodes = append(nodes, node)
	}
	raw, err := c.callOp("canvas.nodes.create", *opID, mustJSON(map[string]any{
		"canvasId": *canvasID, "expectedRevision": *revision, "nodes": nodes}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runCanvasEdgeCreate(c *client, args []string) error {
	fs := flag.NewFlagSet("canvas edge create", flag.ContinueOnError)
	canvasID := fs.String("canvas", "", "画布 ID")
	from := fs.String("from", "", "起点节点 ID")
	to := fs.String("to", "", "终点节点 ID")
	revision := fs.Int64("expected-revision", 0, "读取画布时的 revision（必填）")
	opID := fs.String("op-id", "", "幂等键（必填）")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args); err != nil {
		return flagError(err)
	}
	if *canvasID == "" || *from == "" || *to == "" || *opID == "" || *revision <= 0 {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--canvas/--from/--to/--op-id/--expected-revision 必填"}
	}
	raw, err := c.callOp("canvas.edge.create", *opID, mustJSON(map[string]any{
		"canvasId": *canvasID, "fromNodeId": *from, "toNodeId": *to, "expectedRevision": *revision}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runAsset(c *client, args []string) error {
	if len(args) == 0 {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "asset 需要 list|get"}
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("asset list", flag.ContinueOnError)
		query := fs.String("query", "", "搜索关键字")
		kind := fs.String("kind", "", "素材类型")
		favorite := fs.Bool("favorite", false, "只列出收藏")
		recent := fs.Bool("recent", false, "只列出最近使用")
		project := fs.String("project", "", "项目来源")
		generated := fs.Bool("generated", false, "只列出生成历史")
		page := fs.Int("page", 1, "页码")
		pageSize := fs.Int("page-size", 40, "每页数量")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		raw, err := c.callOp("asset.list", "", mustJSON(map[string]any{
			"query": *query, "kind": *kind, "favorite": *favorite, "recent": *recent, "project": *project, "generated": *generated,
			"page": *page, "pageSize": *pageSize,
		}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	case "get":
		fs := flag.NewFlagSet("asset get", flag.ContinueOnError)
		assetID := fs.String("asset", "", "素材 ID")
		jsonOut := fs.Bool("json", false, "输出 JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return flagError(err)
		}
		if *assetID == "" {
			return &cliError{code: exitUsage, reason: "missing_flag", msg: "--asset 必填"}
		}
		raw, err := c.callOp("asset.get", "", mustJSON(map[string]any{"assetId": *assetID}))
		if err != nil {
			return err
		}
		return printResult(raw, *jsonOut)
	default:
		return &cliError{code: exitUsage, reason: "unknown_subcommand", msg: "未知 asset 子命令: " + args[0]}
	}
}

func runTask(c *client, args []string) error {
	if len(args) == 0 || args[0] != "get" {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "task 需要 get"}
	}
	fs := flag.NewFlagSet("task get", flag.ContinueOnError)
	taskID := fs.String("task", "", "任务 ID")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	if *taskID == "" {
		return &cliError{code: exitUsage, reason: "missing_flag", msg: "--task 必填"}
	}
	raw, err := c.callOp("task.get", "", mustJSON(map[string]any{"taskId": *taskID}))
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runClient(c *client, args []string) error {
	if len(args) == 0 || args[0] != "register" {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "client 需要 register"}
	}
	fs := flag.NewFlagSet("client register", flag.ContinueOnError)
	label := fs.String("label", "", "客户端名称")
	mode := fs.String("mode", "read-write", "read-only 或 read-write")
	kind := fs.String("kind", "other", "codex、claude、cursor 或 other")
	jsonOut := fs.Bool("json", false, "输出 JSON")
	if err := fs.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	raw, err := c.do(context.Background(), http.MethodPost, "/ops/clients", map[string]any{"label": *label, "mode": *mode, "kind": *kind})
	if err != nil {
		return err
	}
	return printResult(raw, *jsonOut)
}

func runMCP(c *client, args []string) error {
	if len(args) == 0 || args[0] != "serve" {
		return &cliError{code: exitUsage, reason: "missing_subcommand", msg: "mcp 需要 serve"}
	}
	fs := flag.NewFlagSet("mcp serve", flag.ContinueOnError)
	readOnly := fs.Bool("read-only", false, "只暴露只读工具")
	if err := fs.Parse(args[1:]); err != nil {
		return flagError(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	startupCtx, cancel := context.WithTimeout(ctx, mcpStartupTimeout)
	ops, err := c.listOpsCtx(startupCtx, *readOnly)
	timedOut := errors.Is(startupCtx.Err(), context.DeadlineExceeded)
	cancel()
	if timedOut {
		return &cliError{code: exitTransportFailure, reason: "mcp_startup_timeout", msg: "连接 BeefTV 工作区超过 5 秒，请确认 BeefTV 已启动且工作区可以访问"}
	}
	if err != nil {
		return err
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "beeftv", Version: "1.0.0"}, nil)
	registeredTools := len(ops)
	business, businessErr := c.businessTools(ctx)
	if businessErr != nil {
		var unavailable *cliError
		if !errors.As(businessErr, &unavailable) || unavailable.code != exitNotFound {
			return businessErr
		}
	} else {
		registerBusinessMCP(server, c, business, *readOnly)
		for _, tool := range business {
			if !*readOnly || tool.ReadOnly {
				registeredTools++
			}
		}
	}
	for _, op := range ops {
		descriptor := op
		server.AddTool(&mcp.Tool{Name: descriptor.ID, Description: descriptor.Summary, InputSchema: descriptor.Params,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: descriptor.ReadOnly}},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				args := map[string]any{}
				if req.Params != nil && req.Params.Arguments != nil {
					raw, err := json.Marshal(req.Params.Arguments)
					if err != nil {
						return toolError(&cliError{code: exitBadRequest, reason: "invalid_arguments", msg: err.Error()}), nil
					}
					if err := json.Unmarshal(raw, &args); err != nil {
						return toolError(&cliError{code: exitBadRequest, reason: "invalid_arguments", msg: err.Error()}), nil
					}
				}
				requestID := ""
				if !descriptor.ReadOnly {
					// 写操作必须由调用方给出稳定幂等键：模型重试同一操作要复用同一个值。
					value, _ := args["operationId"].(string)
					requestID = strings.TrimSpace(value)
					if requestID == "" {
						return toolError(&cliError{code: exitBadRequest, reason: "missing_operation_id",
							msg: "写操作必须在参数里提供 operationId，并在重试时复用同一个值"}), nil
					}
				}
				delete(args, "operationId")
				delete(args, "opId")
				params, err := json.Marshal(args)
				if err != nil {
					return toolError(&cliError{code: exitInternal, reason: "encode_failed", msg: err.Error()}), nil
				}
				result, err := c.callOpCtx(ctx, descriptor.ID, requestID, params)
				if err != nil {
					return toolError(err), nil
				}
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(result)}}}, nil
			})
	}
	_, baseSource := resolveBaseURL()
	fmt.Fprintf(os.Stderr, "beeftv mcp serve: %d 个工具，base=%s（%s），client=%s\n", registeredTools, c.currentBaseURL(), baseSource, orNone(c.clientID))
	return server.Run(ctx, &mcp.StdioTransport{})
}

func orNone(value string) string {
	if value == "" {
		return "(未登记的本机调用)"
	}
	return value
}

// toolError 把失败以结构化 JSON 返回，模型可以按 code/reason 决定是否重试或澄清。
func toolError(err error) *mcp.CallToolResult {
	payload := map[string]any{"reason": "operation_failed", "message": err.Error()}
	if cliErr, ok := err.(*cliError); ok {
		payload = cliErr.machineError()
	}
	encoded, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		encoded = []byte(`{"reason":"operation_failed"}`)
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}}}
}

func printResult(raw json.RawMessage, jsonOut bool) error {
	if jsonOut {
		fmt.Println(string(raw))
		return nil
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, raw, "", "  "); err != nil {
		fmt.Println(string(raw))
		return nil
	}
	fmt.Println(pretty.String())
	return nil
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("cli-%d", time.Now().UnixNano())
	}
	return "cli-" + hex.EncodeToString(buf)
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(value string) error {
	*s = append(*s, value)
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
