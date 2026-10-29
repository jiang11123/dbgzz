package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type businessTool struct {
	ID                string         `json:"id"`
	Summary           string         `json:"summary"`
	Method            string         `json:"method"`
	Path              string         `json:"path"`
	ReadOnly          bool           `json:"readOnly"`
	SubmitsGeneration bool           `json:"submitsGeneration"`
	Cost              string         `json:"cost,omitempty"`
	Params            map[string]any `json:"params"`
}
type businessArgs struct {
	Path        map[string]string `json:"path"`
	Query       map[string]string `json:"query"`
	Body        json.RawMessage   `json:"body"`
	FilePath    string            `json:"filePath"`
	OperationID string            `json:"operationId"`
	File        *struct {
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	} `json:"file"`
}

func (c *client) businessTools(ctx context.Context) ([]businessTool, error) {
	raw, err := c.do(ctx, "GET", "/business/tools", nil)
	if err != nil {
		return nil, err
	}
	var data struct {
		Tools []businessTool `json:"tools"`
	}
	err = json.Unmarshal(raw, &data)
	return data.Tools, err
}
func (c *client) callBusiness(ctx context.Context, tool businessTool, args businessArgs) (json.RawMessage, error) {
	path := tool.Path
	for _, segment := range strings.Split(path, "/") {
		if strings.HasPrefix(segment, ":") {
			key := segment[1:]
			value := args.Path[key]
			if value == "" || value == "." || value == ".." || strings.ContainsAny(value, "/\\%?#") {
				return nil, fmt.Errorf("invalid path parameter %s", key)
			}
			path = strings.ReplaceAll(path, segment, url.PathEscape(value))
		}
	}
	query := url.Values{}
	for k, v := range args.Query {
		query.Set(k, v)
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	var reader io.Reader = bytes.NewReader(args.Body)
	contentType := "application/json"
	if args.FilePath != "" || args.File != nil {
		if args.FilePath != "" && args.File != nil {
			return nil, fmt.Errorf("provide filePath or file, not both")
		}
		chunk := tool.Method == "PUT" && strings.HasPrefix(tool.Path, "/resources/uploads/") && strings.Contains(tool.Path, "/chunks/")
		if !(tool.Method == "POST" && (tool.Path == "/resources" || tool.Path == "/skills/install" || tool.Path == "/plugins")) && !chunk {
			return nil, fmt.Errorf("this handler does not accept file uploads")
		}
		var data []byte
		var name string
		var err error
		if args.FilePath != "" {
			f, e := os.Open(args.FilePath)
			if e != nil {
				return nil, e
			}
			defer f.Close()
			data, err = io.ReadAll(io.LimitReader(f, 64<<20+1))
			name = filepath.Base(args.FilePath)
		} else {
			data, err = base64.StdEncoding.DecodeString(args.File.Data)
			name = filepath.Base(args.File.Name)
		}
		if err != nil {
			return nil, err
		}
		if len(data) > 64<<20 {
			return nil, fmt.Errorf("upload exceeds 64 MiB; use chunked resource upload")
		}
		if name == "." || name == "" {
			return nil, fmt.Errorf("file name is required")
		}
		if chunk {
			reader = bytes.NewReader(data)
			contentType = "application/octet-stream"
		} else {
			var buffer bytes.Buffer
			writer := multipart.NewWriter(&buffer)
			part, e := writer.CreateFormFile("file", name)
			if e != nil {
				return nil, e
			}
			if _, e = part.Write(data); e != nil {
				return nil, e
			}
			fields := map[string]any{}
			if len(args.Body) > 0 {
				if e = json.Unmarshal(args.Body, &fields); e != nil {
					return nil, e
				}
			}
			for key, value := range fields {
				if e = writer.WriteField(key, fmt.Sprint(value)); e != nil {
					return nil, e
				}
			}
			if e = writer.Close(); e != nil {
				return nil, e
			}
			reader = &buffer
			contentType = writer.FormDataContentType()
		}
	}
	base := c.currentBaseURL()
	if base == "" {
		return nil, &cliError{code: exitTransportFailure, reason: "runtime_not_found", msg: "未发现运行中的 BeefTV 工作区，请先打开 BeefTV"}
	}
	req, err := http.NewRequestWithContext(ctx, tool.Method, base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Beeftv-Client", c.clientID)
	req.Header.Set("Authorization", "Bearer "+c.token)
	if c.ownerToken != "" {
		req.Header.Set("X-Beeftv-Owner", c.ownerToken)
	}
	if c.desktopToken != "" {
		req.Header.Set("X-Desktop-Token", c.desktopToken)
	}
	if args.OperationID != "" {
		req.Header.Set("X-Idempotency-Key", args.OperationID)
	}
	response, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64<<20+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 64<<20 {
		return nil, fmt.Errorf("response exceeds 64 MiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Reason  string         `json:"reason"`
			Msg     string         `json:"msg"`
			Details map[string]any `json:"details"`
		}
		_ = json.Unmarshal(raw, &failure)
		return nil, mapEnvelopeError(response.StatusCode, failure.Reason, failure.Msg, failure.Details)
	}
	if !strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		return json.Marshal(map[string]any{"mimeType": response.Header.Get("Content-Type"), "data": base64.StdEncoding.EncodeToString(raw)})
	}
	var envelope struct {
		Code   int             `json:"code"`
		Data   json.RawMessage `json:"data"`
		Reason string          `json:"reason"`
		Msg    string          `json:"msg"`
	}
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if envelope.Code != 0 {
		return nil, mapEnvelopeError(envelope.Code, envelope.Reason, envelope.Msg, nil)
	}
	return envelope.Data, nil
}

func runBusiness(c *client, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("business requires discover, call or upload")
	}
	fs := flag.NewFlagSet("business "+args[0], flag.ContinueOnError)
	id := fs.String("tool", "", "discovered business tool ID")
	params := fs.String("params", "{}", "JSON path/query/body/file parameters")
	file := fs.String("file", "", "local file to upload; read by CLI, never server")
	target := fs.String("target", "resource", "resource, skill or plugin")
	_ = fs.Bool("json", true, "JSON output")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	tools, err := c.businessTools(context.Background())
	if err != nil {
		return err
	}
	if args[0] == "discover" {
		return emitJSON(tools)
	}
	var input businessArgs
	if err = json.Unmarshal([]byte(*params), &input); err != nil {
		return err
	}
	if args[0] == "upload" {
		if *file == "" {
			return fmt.Errorf("--file is required")
		}
		input.FilePath = *file
		switch *target {
		case "resource":
			*id = "business_post_resources"
		case "skill":
			*id = "business_post_skills_install"
		case "plugin":
			*id = "business_post_plugins"
		default:
			return fmt.Errorf("unknown upload target")
		}
	} else if args[0] != "call" {
		return fmt.Errorf("unknown business subcommand")
	}
	for _, tool := range tools {
		if tool.ID == *id {
			result, err := c.callBusiness(context.Background(), tool, input)
			if err != nil {
				return err
			}
			return emitJSON(result)
		}
	}
	return fmt.Errorf("unknown business tool %q; run business discover", *id)
}
func runOpsCall(c *client, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("ops call requires an operation ID")
	}
	operation := args[0]
	fs := flag.NewFlagSet("ops call", flag.ContinueOnError)
	params := fs.String("params", "{}", "operation JSON parameters")
	key := fs.String("operation-id", "", "stable write idempotency key")
	_ = fs.Bool("json", true, "JSON output")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if !json.Valid([]byte(*params)) {
		return fmt.Errorf("invalid JSON params")
	}
	result, err := c.callOp(operation, *key, json.RawMessage(*params))
	if err != nil {
		return err
	}
	return emitJSON(result)
}
func registerBusinessMCP(server *mcp.Server, c *client, tools []businessTool, readOnly bool) {
	for _, tool := range tools {
		descriptor := tool
		if readOnly && !tool.ReadOnly {
			continue
		}
		properties, _ := descriptor.Params["properties"].(map[string]any)
		_, acceptsFile := properties["file"]
		if acceptsFile || descriptor.Method == "PUT" && strings.HasPrefix(descriptor.Path, "/resources/uploads/") && strings.Contains(descriptor.Path, "/chunks/") {
			properties["filePath"] = map[string]any{"type": "string", "description": "Local file read by this external CLI, subject to the external agent's filesystem approval"}
		}
		properties["operationId"] = map[string]any{"type": "string", "description": "Stable idempotency key where supported by the business handler"}
		server.AddTool(&mcp.Tool{Name: descriptor.ID, Description: descriptor.Summary, InputSchema: descriptor.Params, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: descriptor.ReadOnly}}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if request == nil || request.Params == nil {
				return toolError(fmt.Errorf("missing tool arguments")), nil
			}
			var args businessArgs
			raw, err := json.Marshal(request.Params.Arguments)
			if err == nil {
				err = json.Unmarshal(raw, &args)
			}
			if err != nil {
				return toolError(err), nil
			}
			data, err := c.callBusiness(ctx, descriptor, args)
			if err != nil {
				return toolError(err), nil
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil
		})
	}
}
