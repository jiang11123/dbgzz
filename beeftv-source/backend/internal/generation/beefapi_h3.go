package generation

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

var h3Styles = map[string]string{
	"minimax-h3-max-style-hand-drawn": "hand-drawn", "minimax-h3-max-style-16bit-pixel": "16bit-pixel",
	"minimax-h3-max-style-low-poly": "low-poly", "minimax-h3-max-style-retro-toon-70s": "retro-toon-70s", "minimax-h3-max-style-vhs": "vhs",
}

func IsBeefAPIH3Model(model string) bool {
	_, style := h3Styles[model]
	return style || model == "minimax-h3" || model == "minimax-h3-max" || model == "minimax-h3-max-turbo"
}

type h3Reference struct{ ID, Type, URL string }

func beefAPIH3VideoBody(input Input) (map[string]interface{}, error) {
	name := input.Config.Model
	base := name == "minimax-h3"
	maxModel := name == "minimax-h3-max"
	style, styled := h3Styles[name]
	seconds := defaultString(strings.TrimSpace(input.Config.VideoSeconds), "5")
	duration, err := strconv.ParseFloat(seconds, 64)
	minimum := .92
	if base || styled {
		minimum = 5
	}
	if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration < minimum || duration > 15 || (base || styled) && duration != math.Trunc(duration) {
		return nil, fmt.Errorf("H3 视频时长超出当前模型支持的范围")
	}
	resolution := "768p"
	if base {
		resolution = "2k"
	}
	if input.Config.VQuality != "" {
		switch strings.ToLower(strings.TrimSpace(input.Config.VQuality)) {
		case "2k", "1440", "1440p":
			resolution = "2k"
		case "4k", "2160", "2160p":
			resolution = "4k"
		default:
			resolution = NormalizeVideoResolution(input.Config.VQuality)
		}
	}
	if resolution != "480p" && resolution != "768p" && !(base && (resolution == "2k" || resolution == "4k")) && !(!base && !styled && resolution == "1080p") || styled && resolution != "768p" {
		return nil, fmt.Errorf("所选分辨率不受当前 H3 模型支持")
	}
	body := map[string]interface{}{"model": name, "prompt": strings.TrimSpace(input.Prompt), "seconds": seconds, "resolution": resolution}
	if !styled {
		body["enable_safety_checker"] = true
		body["sync_mode"] = false
	}
	if err := h3Controls(body, input.Metadata, base, style, styled); err != nil {
		return nil, err
	}
	first, last, middle := metadataString(input.Metadata, "videoStartFrameNodeId"), metadataString(input.Metadata, "videoEndFrameNodeId"), metadataString(input.Metadata, "videoMiddleFrameNodeId")
	selected := map[string]string{}
	if first != "" {
		selected[first] = "first_frame_url"
	}
	if last != "" {
		selected[last] = "last_frame_url"
	}
	if middle != "" {
		selected[middle] = "middle_image_url"
	}
	op := metadataString(input.Metadata, "videoEditOperation")
	referenceMode := !styled && (op == "reference_to_video" || middle != "" || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 1 || base && len(input.ReferenceImages) > 0 && len(selected) == 0 && op != "image_to_video")
	if referenceMode && len(selected) > 0 && !maxModel {
		return nil, fmt.Errorf("当前 H3 参考模式不能同时指定关键帧")
	}
	refs := []h3Reference{}
	for index, m := range input.ReferenceImages {
		u, err := openAIImageInputURL(m)
		if err != nil {
			return nil, err
		}
		matched := false
		for _, role := range []struct{ id, key string }{{first, "first_frame_url"}, {last, "last_frame_url"}, {middle, "middle_image_url"}} {
			if role.id != "" && role.id == m.ID {
				body[role.key] = u
				matched = true
			}
		}
		if matched {
			continue
		}
		if referenceMode {
			refs = append(refs, h3Reference{m.ID, "image", u})
		} else if len(selected) > 0 {
			return nil, fmt.Errorf("首尾帧模式中的图片须指定角色")
		} else if index == 0 {
			body["first_frame_url"] = u
		} else {
			body["last_frame_url"] = u
		}
	}
	for _, role := range []struct{ id, key string }{{first, "first_frame_url"}, {last, "last_frame_url"}, {middle, "middle_image_url"}} {
		if role.id != "" && body[role.key] == nil {
			return nil, fmt.Errorf("已选择的关键帧未包含在视频请求中")
		}
	}
	if middle != "" || input.Metadata["videoMiddleFrameTime"] != nil {
		t, ok := input.Metadata["videoMiddleFrameTime"].(float64)
		frame := math.Round(t * 24)
		if !ok || !maxModel || middle == "" || first == "" || last == "" || math.IsNaN(t) || math.IsInf(t, 0) || frame <= 0 || frame >= math.Round(duration*24)-1 || resolution == "1080p" {
			return nil, fmt.Errorf("中间帧须同时指定首尾帧和片内时间，并使用 H3 Max 的 480P 或 768P")
		}
		body["middle_frame_time"] = t
	}
	if styled {
		if len(input.ReferenceImages) > 1 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0 || last != "" || middle != "" {
			return nil, fmt.Errorf("H3 Styles 支持一张首帧图片")
		}
	} else if !referenceMode && (len(input.ReferenceImages) > 2 || len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 1) {
		return nil, fmt.Errorf("H3 首尾帧模式支持最多 2 张图片、1 段配音")
	}
	for _, m := range input.ReferenceVideos {
		u, err := SeedanceVideosMediaURL(m)
		if err != nil {
			return nil, err
		}
		refs = append(refs, h3Reference{m.ID, "video", u})
	}
	for _, m := range input.ReferenceAudios {
		u, err := BeefAPIAudioURL(m)
		if err != nil {
			return nil, err
		}
		if !referenceMode {
			if duration < 2 {
				return nil, fmt.Errorf("使用配音时视频须至少 2 秒")
			}
			body["target_audio_url"] = u
		} else {
			refs = append(refs, h3Reference{m.ID, "audio", u})
		}
	}
	if referenceMode {
		counts := map[string]int{}
		for _, r := range refs {
			counts[r.Type]++
		}
		if len(refs) > 12 || counts["image"] > 9 || counts["video"] > 3 || counts["audio"] > 3 || len(refs) == 0 && len(selected) == 0 {
			return nil, fmt.Errorf("H3 最多支持 9 张参考图、3 段视频、3 段音频，参考素材合计不超过 12 个")
		}
		body["operation"] = "reference_to_video"
		if !base && input.Metadata["videoReferenceOrder"] != nil {
			order, err := h3ReferenceOrder(input.Metadata["videoReferenceOrder"])
			filtered := make([]string, 0, len(order))
			for _, id := range order {
				if _, frame := selected[id]; !frame {
					filtered = append(filtered, id)
				}
			}
			order = filtered
			if err != nil || len(order) != len(refs) {
				return nil, fmt.Errorf("参考素材顺序与当前连接不一致，请重新排序")
			}
			conditions := []map[string]string{}
			seen := map[string]bool{}
			for _, id := range order {
				if seen[id] {
					return nil, fmt.Errorf("参考素材顺序重复")
				}
				seen[id] = true
				found := false
				for _, r := range refs {
					if r.ID == id {
						conditions = append(conditions, map[string]string{"type": r.Type, "url": r.URL})
						found = true
						break
					}
				}
				if !found {
					return nil, fmt.Errorf("参考素材已断开，请重新排序")
				}
			}
			body["reference_conditions"] = conditions
		} else {
			for _, kind := range []string{"image", "video", "audio"} {
				urls := []string{}
				for _, r := range refs {
					if r.Type == kind {
						urls = append(urls, r.URL)
					}
				}
				if len(urls) > 0 {
					body["reference_"+kind+"_urls"] = urls
				}
			}
		}
	}
	if referenceMode || len(input.ReferenceImages) == 0 {
		ratio := defaultString(strings.TrimSpace(input.Config.Size), "16:9")
		if referenceMode && input.Config.Size == "" {
			ratio = "adaptive"
		}
		if !referenceMode && ratio == "adaptive" {
			return nil, fmt.Errorf("自适应比例仅支持参考生成，请选择固定比例")
		}
		body["aspect_ratio"] = ratio
	}
	return body, nil
}

func h3ReferenceOrder(value interface{}) ([]string, error) {
	if order, ok := value.([]string); ok {
		return order, nil
	}
	values, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("invalid order")
	}
	order := []string{}
	for _, v := range values {
		s, ok := v.(string)
		if !ok || s == "" {
			return nil, fmt.Errorf("invalid order")
		}
		order = append(order, s)
	}
	return order, nil
}

func h3Controls(body, metadata map[string]interface{}, base bool, style string, styled bool) error {
	if !styled {
		body["prompt_expansion_mode"] = "balanced"
	}
	opts, ok := metadata["videoH3Options"].(map[string]interface{})
	if !ok {
		return nil
	}
	for k, v := range opts {
		switch k {
		case "seed":
			n, ok := v.(float64)
			if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || math.Abs(n) > 9007199254740991 {
				return fmt.Errorf("随机种子须为整数")
			}
			body[k] = v
		case "prompt_expansion_mode":
			if styled {
				continue
			}
			s, ok := v.(string)
			if !ok || s != "disabled" && s != "balanced" && s != "quality" && !(base && s == "fast") {
				return fmt.Errorf("提示词增强设置无效")
			}
			body[k] = s
		case "enable_safety_checker", "sync_mode":
			// These settings are fixed for BeefTV's task-based video pipeline.
			// Ignore values persisted by older clients instead of re-enabling them.
			continue
		case "damage_level":
			if style != "vhs" {
				continue
			}
			s, ok := v.(string)
			if !ok || s != "light" && s != "medium" && s != "heavy" {
				return fmt.Errorf("磁带磨损设置无效")
			}
			body[k] = s
		default:
			return fmt.Errorf("H3 参数不受支持: %s", k)
		}
	}
	return nil
}
