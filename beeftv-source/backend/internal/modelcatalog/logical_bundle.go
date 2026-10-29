package modelcatalog

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

var logicalModelCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,79}$`)

type LogicalBundleDeps struct {
	ChannelModel       func(id string) (*model.ChannelModel, error)
	SystemChannel      func(id string) (*model.ModelChannel, error)
	AdminSystemChannel func(id string) (*model.ModelChannel, error)
	LogicalModel       func(id string) (*model.LogicalModel, error)
	NextID             IDGen
	Now                time.Time
	ActorID            string
}

func PrepareLogicalModelBundle(id string, req LogicalModelRequest, deps LogicalBundleDeps) (*model.LogicalModel, *model.LogicalModelRevision, []model.LogicalModelRoute, bool, error) {
	code := strings.ToLower(strings.TrimSpace(req.Code))
	name := strings.TrimSpace(req.Name)
	capability := normalizeCapability(req.Capability)
	if !logicalModelCodePattern.MatchString(code) {
		return nil, nil, nil, false, kernel.BadAuthRequest("模型 code 需为 2-80 位小写字母、数字、点、下划线或连字符")
	}
	if name == "" || len([]rune(name)) > 120 {
		return nil, nil, nil, false, kernel.BadAuthRequest("请填写 1-120 个字符的模型名称")
	}
	sourceChannelModelID := strings.TrimSpace(req.SourceChannelModelID)
	if sourceChannelModelID != "" {
		source, sourceErr := deps.ChannelModel(sourceChannelModelID)
		if sourceErr != nil {
			return nil, nil, nil, false, kernel.BadAuthRequest("系统渠道模型不存在")
		}
		if _, channelErr := deps.AdminSystemChannel(source.ChannelID); channelErr != nil {
			return nil, nil, nil, false, kernel.BadAuthRequest("前台模型只能同步系统渠道模型")
		}
		capability = normalizeCapability(source.Capability)
		derivedSpec, specErr := channelModelCapabilitySpec(*source)
		if specErr != nil {
			return nil, nil, nil, false, specErr
		}
		derivedDefaults, defaultsErr := channelModelDefaultOptions(*source, derivedSpec)
		if defaultsErr != nil {
			return nil, nil, nil, false, defaultsErr
		}
		if len(req.Routes) == 0 {
			req.CapabilitySpec = derivedSpec
			req.DefaultOptions = derivedDefaults
			req.Routes = []LogicalRouteRequest{{ChannelModelID: source.ID, Enabled: true, Priority: 100, Weight: 100}}
		}
		if strings.TrimSpace(id) == "" {
			req.Enabled = source.Enabled
		}
	}
	normalizedSpec, err := NormalizeCapabilitySpec(req.CapabilitySpec)
	if err != nil {
		return nil, nil, nil, false, err
	}
	req.CapabilitySpec = normalizedSpec
	if normalizeCapability(req.CapabilitySpec.Capability) != capability {
		return nil, nil, nil, false, kernel.BadAuthRequest("前台模型类型与能力配置不一致")
	}
	normalizedDefaults, err := normalizeLogicalDefaults(req.CapabilitySpec, req.DefaultOptions)
	if err != nil {
		return nil, nil, nil, false, err
	}
	req.DefaultOptions = normalizedDefaults
	creating := strings.TrimSpace(id) == ""
	var item *model.LogicalModel
	if creating {
		id, err = deps.NextID("LMODEL")
		if err != nil {
			return nil, nil, nil, false, err
		}
		item = &model.LogicalModel{ID: id, CreatedAt: deps.Now}
	} else {
		item, err = deps.LogicalModel(id)
		if err != nil {
			return nil, nil, nil, false, err
		}
		if item.ArchivedAt != nil {
			return nil, nil, nil, false, kernel.BadAuthRequest("前台模型不存在或已删除")
		}
	}
	item.Code, item.Name, item.Icon, item.Description, item.Capability = code, name, strings.TrimSpace(req.Icon), strings.TrimSpace(req.Description), capability
	if sourceChannelModelID != "" {
		item.SourceChannelModelID = sourceChannelModelID
	}
	item.Enabled, item.SortOrder = req.Enabled, req.SortOrder
	if req.LegacyModelIDs != nil {
		legacyJSON, marshalErr := json.Marshal(normalizeLegacyModelIDs(req.LegacyModelIDs))
		if marshalErr != nil {
			return nil, nil, nil, false, marshalErr
		}
		item.LegacyModelIDsJSON = string(legacyJSON)
	}
	item.UpdatedAt = deps.Now
	revisionID, err := deps.NextID("REVISION")
	if err != nil {
		return nil, nil, nil, false, err
	}
	specJSON, err := json.Marshal(req.CapabilitySpec)
	if err != nil {
		return nil, nil, nil, false, fmt.Errorf("序列化前台模型能力合同失败：%w", err)
	}
	defaultsJSON, err := json.Marshal(defaultMap(req.DefaultOptions))
	if err != nil {
		return nil, nil, nil, false, fmt.Errorf("序列化前台模型默认参数失败：%w", err)
	}
	revision := &model.LogicalModelRevision{ID: revisionID, LogicalModelID: item.ID, CapabilitySpecJSON: string(specJSON), DefaultOptionsJSON: string(defaultsJSON), CreatedBy: deps.ActorID, CreatedAt: deps.Now}
	routes := make([]model.LogicalModelRoute, 0, len(req.Routes))
	seenChannelModels := make(map[string]bool, len(req.Routes))
	structuralRouteSpecs := make([]CapabilitySpec, 0, len(req.Routes))
	for _, input := range req.Routes {
		channelModelID := strings.TrimSpace(input.ChannelModelID)
		if channelModelID == "" || seenChannelModels[channelModelID] {
			return nil, nil, nil, false, kernel.BadAuthRequest("供应线路必须选择不重复的渠道模型")
		}
		seenChannelModels[channelModelID] = true
		channelModel, modelErr := deps.ChannelModel(channelModelID)
		if modelErr != nil {
			return nil, nil, nil, false, kernel.BadAuthRequest("供应线路引用的渠道模型不存在")
		}
		capabilitySpec, specErr := channelModelCapabilitySpec(*channelModel)
		if specErr != nil {
			return nil, nil, nil, false, specErr
		}
		if normalizeCapability(capabilitySpec.Capability) != capability {
			return nil, nil, nil, false, kernel.BadAuthRequest("供应线路能力类型与前台模型不一致")
		}
		if req.Enabled && input.Enabled && input.Weight <= 0 {
			return nil, nil, nil, false, kernel.BadAuthRequest("启用供应线路的同级权重必须大于 0")
		}
		if input.Weight < 0 {
			return nil, nil, nil, false, kernel.BadAuthRequest("供应线路的同级权重不能为负数")
		}
		if _, channelErr := deps.SystemChannel(channelModel.ChannelID); channelErr != nil {
			return nil, nil, nil, false, kernel.BadAuthRequest("供应线路只能选择系统渠道模型")
		}
		if req.Enabled && input.Enabled && channelModel.Enabled {
			structuralRouteSpecs = append(structuralRouteSpecs, capabilitySpec)
		}
		routeID, idErr := deps.NextID("ROUTE")
		if idErr != nil {
			return nil, nil, nil, false, idErr
		}
		routes = append(routes, model.LogicalModelRoute{ID: routeID, ChannelModelID: channelModel.ID, Enabled: input.Enabled, Priority: input.Priority, Weight: input.Weight, CreatedAt: deps.Now, UpdatedAt: deps.Now})
	}
	if req.Enabled {
		if len(structuralRouteSpecs) == 0 {
			return nil, nil, nil, false, kernel.BadAuthRequest("启用前台模型前至少需要一条已启用的供应线路")
		}
		if err := validateProductSpecWithinRoutes(req.CapabilitySpec, structuralRouteSpecs); err != nil {
			return nil, nil, nil, false, err
		}
	}
	return item, revision, routes, creating, nil
}

func defaultMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}
