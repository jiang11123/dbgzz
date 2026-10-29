package handler

import (
	"fmt"
	"github.com/goccy/go-yaml"
	"infinite-canvas/backend/internal/task"
	"reflect"
	"strings"
)

// The mounted route graph owns availability; OpenAPI contributes schemas only.
// Legacy hosted paths in the document cannot become external tools by themselves.
func enrichBusinessSchemas(catalog *BusinessCatalog) {
	var spec map[string]any
	if yaml.Unmarshal(openAPISpec, &spec) != nil {
		return
	}
	paths, _ := spec["paths"].(map[string]any)
	var resolve func(any, int) any
	resolve = func(value any, depth int) any {
		if depth > 12 {
			return map[string]any{"type": "object"}
		}
		switch v := value.(type) {
		case map[string]any:
			if ref, ok := v["$ref"].(string); ok && strings.HasPrefix(ref, "#/") {
				var target any = spec
				for _, part := range strings.Split(ref[2:], "/") {
					m, ok := target.(map[string]any)
					if !ok {
						return map[string]any{}
					}
					target = m[part]
				}
				return resolve(target, depth+1)
			}
			out := map[string]any{}
			for k, x := range v {
				out[k] = resolve(x, depth+1)
			}
			return out
		case []any:
			out := make([]any, len(v))
			for i, x := range v {
				out[i] = resolve(x, depth+1)
			}
			return out
		default:
			return v
		}
	}
	for i := range catalog.Tools {
		t := &catalog.Tools[i]
		parts := strings.Split(t.Path, "/")
		for n, p := range parts {
			if strings.HasPrefix(p, ":") {
				parts[n] = "{" + p[1:] + "}"
			}
		}
		path, _ := paths[strings.Join(parts, "/")].(map[string]any)
		operation, _ := path[strings.ToLower(t.Method)].(map[string]any)
		if operation == nil {
			continue
		}
		if summary, ok := operation["summary"].(string); ok {
			t.Summary = summary + " (" + t.Method + " " + t.Path + ")"
		}
		for _, container := range []map[string]any{path, operation} {
			parameters, _ := container["parameters"].([]any)
			for _, raw := range parameters {
				parameter, _ := resolve(raw, 0).(map[string]any)
				if parameter["in"] != "query" {
					continue
				}
				name, _ := parameter["name"].(string)
				if name == "" {
					continue
				}
				properties := t.Params["properties"].(map[string]any)
				query := properties["query"].(map[string]any)
				fields, _ := query["properties"].(map[string]any)
				if fields == nil {
					fields = map[string]any{}
					query["properties"] = fields
				}
				description, _ := parameter["description"].(string)
				schema, _ := resolve(parameter["schema"], 0).(map[string]any)
				fields[name] = map[string]any{"type": "string", "description": description, "x-value-schema": schema}
				if schema["default"] != nil {
					fields[name].(map[string]any)["default"] = fmt.Sprint(schema["default"])
				}
				if parameter["required"] == true {
					required, _ := query["required"].([]string)
					query["required"] = append(required, name)
				}
			}
		}
		request, _ := operation["requestBody"].(map[string]any)
		content, _ := request["content"].(map[string]any)
		jsonBody, _ := content["application/json"].(map[string]any)
		if schema, ok := jsonBody["schema"]; ok {
			properties, _ := t.Params["properties"].(map[string]any)
			properties["body"] = resolve(schema, 0)
		}
	}
	for i := range catalog.Tools {
		t := &catalog.Tools[i]
		enrichBusinessQueries(t)
		var request any
		switch t.Method + " " + t.Path {
		case "POST /tasks":
			request = task.CreateRequest{}
		case "POST /timeline/renders":
			request = task.TimelineRenderCreateRequest{}
		case "POST /timeline/transcriptions":
			request = task.TimelineTranscriptionCreateRequest{}
		case "POST /depth-captures":
			request = task.DepthCaptureCreateRequest{}
		case "PUT /workspace/model-config":
			request = struct {
				Config           map[string]any `json:"config"`
				ExpectedRevision int64          `json:"expectedRevision"`
			}{}
		case "POST /resources":
			request = struct {
				Kind       string `json:"kind"`
				Width      int    `json:"width"`
				Height     int    `json:"height"`
				DurationMs int64  `json:"durationMs"`
			}{}
		}
		if request != nil {
			properties, _ := t.Params["properties"].(map[string]any)
			properties["body"] = businessGoSchema(reflect.TypeOf(request), 0)
		}
	}
}

func businessGoSchema(t reflect.Type, depth int) map[string]any {
	if depth > 8 {
		return map[string]any{"type": "object"}
	}
	if t.Kind() == reflect.Pointer {
		return businessGoSchema(t.Elem(), depth+1)
	}
	switch t.Kind() {
	case reflect.Struct:
		props := map[string]any{}
		for i := 0; i < t.NumField(); i++ {
			field := t.Field(i)
			if !field.IsExported() {
				continue
			}
			name := strings.Split(field.Tag.Get("json"), ",")[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			props[name] = businessGoSchema(field.Type, depth+1)
		}
		return map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	case reflect.String:
		return map[string]any{"type": "string"}
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return map[string]any{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Array, reflect.Slice:
		return map[string]any{"type": "array", "items": businessGoSchema(t.Elem(), depth+1)}
	case reflect.Map:
		return map[string]any{"type": "object", "additionalProperties": true}
	default:
		return map[string]any{}
	}
}
