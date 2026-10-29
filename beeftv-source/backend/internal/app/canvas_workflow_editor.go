package app

import (
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/mediatools"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
)

func workflowRevision(n int) int {
	if n < 1 {
		return 1
	}
	return n
}

func (s *Service) CanvasWorkflowOperations() []cw.Operation {
	operations := cw.Operations()
	if snapshot, err := s.canvasWorkflowProviderConfig(); err == nil {
		upscaleChannels := []cw.FieldOption{}
		if _, err := s.upscaleConfig(""); err == nil {
			upscaleChannels = append(upscaleChannels, cw.FieldOption{Label: "官方算力", Value: "beefapi"})
		}
		textModels := []cw.FieldOption{}
		for _, model := range workflowDescribeModels(snapshot) {
			if model.Enabled && model.Capability == "text" && model.Protocol != "" {
				textModels = append(textModels, cw.FieldOption{Label: model.DisplayName, Value: model.ChannelID + "::" + model.Model})
			}
		}
		for i := range operations {
			for j := range operations[i].Fields {
				field := &operations[i].Fields[j]
				if strings.HasPrefix(operations[i].ID, "generate.") && field.Key == "modelOption" {
					raw, _ := json.Marshal(snapshot)
					for _, candidate := range modelcatalog.ParseLocalChannelModels(raw) {
						if candidate.Enabled && generation.UpscaleMediaType(candidate.Model) == "" && candidate.Capability == operations[i].OutputType && candidate.Protocol != "" {
							field.Options = append(field.Options, cw.FieldOption{Label: candidate.DisplayName + " · " + candidate.ChannelID, Value: candidate.ChannelID + "::" + candidate.Model, Capabilities: candidate.CapabilityConfig})
						}
					}
				}
				if strings.HasSuffix(operations[i].ID, ".ai-upscale") && field.Key == "channelId" {
					field.Options = upscaleChannels
				}
				if operations[i].ID == "image.describe" && field.Key == "modelOption" {
					field.Options = textModels
				}
			}
		}
	}
	path, err := mediatools.ResolveFFmpeg()
	if err == nil {
		var info os.FileInfo
		info, err = os.Stat(path)
		if err == nil && (!info.Mode().IsRegular() || runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0) {
			err = os.ErrPermission
		}
	}
	if err != nil {
		for i := range operations {
			if cw.IsMediaOperation(operations[i].ID) || operations[i].ID == "video.trim" || operations[i].ID == "video.merge" {
				operations[i].UnavailableReason = "本机媒体编码器不可用，请更新安装版后重试"
			}
		}
	}
	return operations
}
func workflowSnapshot(row model.CanvasWorkflow) *model.CanvasWorkflowRevision {
	return &model.CanvasWorkflowRevision{TemplateID: row.ID, Revision: workflowRevision(row.Revision), UserID: row.UserID, Name: row.Name, Description: row.Description, DefinitionJSON: row.DefinitionJSON, RecipeCipher: row.RecipeCipher}
}
func (s *Service) workflowRevisionRow(user, id string, revision int) (model.CanvasWorkflow, error) {
	var row model.CanvasWorkflow
	if e := s.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
		return row, workflowNotFound()
	}
	revision = workflowRevision(revision)
	if workflowRevision(row.Revision) == revision {
		return row, nil
	}
	var snapshot model.CanvasWorkflowRevision
	if e := s.repo.DB().Where("template_id = ? AND user_id = ? AND revision = ?", id, user, revision).First(&snapshot).Error; e != nil {
		return row, workflowNotFound()
	}
	row.Revision = snapshot.Revision
	row.Name = snapshot.Name
	row.Description = snapshot.Description
	row.DefinitionJSON = snapshot.DefinitionJSON
	row.RecipeCipher = snapshot.RecipeCipher
	return row, nil
}
func (s *Service) CanvasWorkflowEditor(user, id string, revision int) (cw.Editor, error) {
	if revision == 0 {
		current, e := s.CanvasWorkflow(user, id)
		if e != nil {
			return cw.Editor{}, e
		}
		revision = current.Revision
	}
	row, e := s.workflowRevisionRow(user, id, revision)
	if e != nil {
		return cw.Editor{}, e
	}
	public, e := workflowTemplate(row)
	if e != nil {
		return cw.Editor{}, e
	}
	plain, e := s.decryptSettingSecret(row.RecipeCipher)
	if e != nil {
		return cw.Editor{}, e
	}
	var recipes workflowRecipes
	if e = json.Unmarshal([]byte(plain), &recipes); e != nil {
		return cw.Editor{}, e
	}
	public.Definition = workflowEditorDefinition(public.Definition, recipes)
	return cw.Editor{Workflow: public, Operations: s.CanvasWorkflowOperations()}, nil
}
func workflowEditorDefinition(d cw.Definition, recipes workflowRecipes) cw.Definition {
	d = cw.Normalize(d)
	for i, n := range d.Nodes {
		if !strings.HasPrefix(n.OperationID, "generate.") {
			continue
		}
		recipe := recipes[n.ID]
		n.Config = map[string]any{}
		for _, key := range []string{"prompt", "size", "quality", "vquality", "videoSeconds", "seed"} {
			value, ok := recipe.Request.Input[key]
			if key != "prompt" {
				config, _ := recipe.Request.Input["config"].(map[string]any)
				value, ok = config[key]
				if (key == "seed" || key == "videoSeconds") && ok {
					if text, yes := value.(string); yes {
						number, err := strconv.ParseFloat(text, 64)
						if err != nil {
							ok = false
						} else {
							value = number
						}
					}
				}
			}
			if key == "prompt" && !ok {
				value = recipe.Request.Prompt
				ok = true
			}
			if ok {
				switch value.(type) {
				case string, float64, int, bool:
					n.Config[key] = value
				}
			}
		}
		config, _ := recipe.Request.Input["config"].(map[string]any)
		channel := recipe.ChannelID
		if channel == "@beefapi" {
			channel = "beefapi"
		}
		if channel != "" && stringValue(config["model"]) != "" {
			n.Config["modelOption"] = channel + "::" + stringValue(config["model"])
		}
		d.Nodes[i] = n
	}
	for i, edge := range d.Edges {
		bindings := []workflowBinding{}
		for _, binding := range recipes[edge.To].Bindings {
			if binding.NodeID == edge.From && !workflowPromptBinding(binding.Field) {
				bindings = append(bindings, binding)
			}
		}
		if len(bindings) == 1 {
			edge.ToPort, edge.Order = bindings[0].Field, bindings[0].Index
			d.Edges[i] = edge
		}
	}
	// Reference identity belongs to the private recipe. Reusable inputs and
	// processing outputs have no original media attached to their public slots.
	for i := range d.Nodes {
		n := &d.Nodes[i]
		if d.PresentationVersion > 0 && (n.Role == "operation" || n.Role == "input" && n.MediaType != "text" && !n.UseDefault) {
			n.ResourceID = ""
		}
	}
	return d
}
func (s *Service) ValidateCanvasWorkflow(user string, d cw.Definition) error {
	_, _, e := s.compileCanvasWorkflow(user, d)
	return e
}
func (s *Service) PrepareCanvasWorkflow(user string, d cw.Definition, id string, revision int) (cw.Definition, error) {
	var recipes workflowRecipes
	var e error
	if id == "" {
		recipes, _, e = s.compileCanvasWorkflow(user, d)
	} else {
		if revision < 1 {
			return d, workflowBad("编辑校验需要有效的模板版本")
		}
		var row model.CanvasWorkflow
		row, e = s.workflowRevisionRow(user, id, revision)
		if e == nil {
			recipes, _, e = s.compileCanvasWorkflow(user, d, row)
		}
	}
	if e != nil {
		return d, e
	}
	return workflowEditorDefinition(d, recipes), nil
}
func (s *Service) UpdateCanvasWorkflow(user, id string, req cw.UpdateRequest) (cw.Template, error) {
	s.canvasWorkflowMu.Lock()
	defer s.canvasWorkflowMu.Unlock()
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 100 || len(req.Description) > 4000 {
		return cw.Template{}, workflowBad("工作流名称或说明无效")
	}
	var row model.CanvasWorkflow
	if e := s.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
		return cw.Template{}, workflowNotFound()
	}
	if req.ExpectedRevision != workflowRevision(row.Revision) {
		return cw.Template{}, kernel.NewAppError(kernel.CodeConflict, "工作流已更新，请保留草稿并重新载入比较")
	}
	recipes, refs, e := s.compileCanvasWorkflow(user, req.Definition, row)
	if e != nil {
		return cw.Template{}, e
	}
	raw, e := json.Marshal(recipes)
	if e != nil {
		return cw.Template{}, e
	}
	cipher, e := s.encryptSettingSecret(string(raw))
	if e != nil {
		return cw.Template{}, e
	}
	if req.Definition.PresentationVersion > 0 {
		req.Definition = workflowEditorDefinition(req.Definition, recipes)
	}
	definition, e := json.Marshal(req.Definition)
	if e != nil {
		return cw.Template{}, e
	}
	old := row
	row.Revision = workflowRevision(row.Revision) + 1
	row.Name = req.Name
	row.Description = req.Description
	row.DefinitionJSON = string(definition)
	row.RecipeCipher = cipher
	e = s.repo.DB().Transaction(func(tx *gorm.DB) error {
		if e := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(workflowSnapshot(old)).Error; e != nil {
			return e
		}
		result := tx.Model(&model.CanvasWorkflow{}).Where("id = ? AND user_id = ? AND revision = ?", id, user, req.ExpectedRevision).Updates(map[string]any{"revision": row.Revision, "name": row.Name, "description": row.Description, "definition_json": row.DefinitionJSON, "recipe_cipher": row.RecipeCipher})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return kernel.NewAppError(kernel.CodeConflict, "工作流版本冲突")
		}
		if e := tx.Create(workflowSnapshot(row)).Error; e != nil {
			return e
		}
		// References are a union across immutable revisions; never release old inputs on edit.
		return persistWorkflowReferences(tx, workflowReferenceRows(id, user, refs))
	})
	if e != nil {
		return cw.Template{}, e
	}
	return s.CanvasWorkflow(user, id)
}
