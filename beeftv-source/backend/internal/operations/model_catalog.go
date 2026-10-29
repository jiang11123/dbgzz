package operations

import (
	"encoding/json"
	"infinite-canvas/backend/internal/modelcatalog"
)

type ModelCatalogReader interface {
	AgentModelCatalog() (*modelcatalog.CatalogResponse, error)
}

func registerModelCatalogOp(r *Registry) {
	r.Register(Op{AssistantCanvas: true, ID: "model.catalog", Summary: "按所需类型查询模型、参考能力和已保存的视频报价（videoPricing）；未返回报价表示价格未知，不能承诺预算；不含密钥", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"capability":{"type":"string","enum":["text","image","video","audio"]},"capabilities":{"type":"array","minItems":1,"maxItems":4,"uniqueItems":true,"items":{"type":"string","enum":["text","image","video","audio"]},"description":"一次读取本次需要的多种类型；整片制作用 image、video、audio，不必逐类型往返"}},"additionalProperties":false}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct {
				Capability   string   `json:"capability"`
				Capabilities []string `json:"capabilities"`
			}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			if args.Capability != "" && len(args.Capabilities) > 0 {
				return nil, InvalidArg("invalid_capability", "capability 与 capabilities 请选择一种")
			}
			if args.Capability != "" {
				args.Capabilities = []string{args.Capability}
			}
			wanted := map[string]bool{}
			for _, capability := range args.Capabilities {
				switch capability {
				case "text", "image", "video", "audio":
					wanted[capability] = true
				default:
					return nil, InvalidArg("invalid_capability", "请选择 text、image、video 或 audio")
				}
			}
			reader, ok := ctx.Domain.(ModelCatalogReader)
			if !ok {
				return nil, Unsupported("model_catalog_unavailable", "当前工作区无法读取模型目录")
			}
			catalog, err := reader.AgentModelCatalog()
			if err != nil || catalog == nil || len(wanted) == 0 {
				return catalog, mapDomainError(err)
			}
			filtered := modelcatalog.NewCatalogResponse(catalog.Source, nil, nil)
			for _, item := range catalog.Models {
				if wanted[item.Capability] {
					filtered.Models = append(filtered.Models, item)
				}
			}
			for _, channel := range catalog.Channels {
				models := []modelcatalog.PublicChannelModel{}
				for _, item := range channel.Models {
					if wanted[item.Capability] {
						models = append(models, item)
					}
				}
				if len(models) > 0 {
					channel.Models = models
					filtered.Channels = append(filtered.Channels, channel)
				}
			}
			return &filtered, nil
		}})
}
