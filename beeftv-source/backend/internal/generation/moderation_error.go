package generation

import (
	"regexp"
	"strings"
)

var moderationCodePattern = regexp.MustCompile(`^(input|output)(text|image|video|audio)(?:sensitivecontentdetected|riskdetection)(?:\.(policyviolation|privacyinformation|deepfake))?$`)
var moderationSubjectPattern = regexp.MustCompile(`\b(input|output|reference)\s+(text|image|video|audio)\b`)
var moderationMessagePattern = regexp.MustCompile(`may contain sensitive information|includes sensitive content|content (?:safety|policy)|safety policy|copyright restrictions|may contain real person|counterfeit documents or credentials`)

// Ark codes encode direction, medium and cause independently. In this family
// PolicyViolation means copyright, while PrivacyInformation concerns likeness.
func moderationErrorCopy(code, message string) (Failure, bool) {
	m := moderationCodePattern.FindStringSubmatch(strings.ToLower(code))
	direction, media, cause := "", "", ""
	if len(m) != 0 {
		direction, media, cause = m[1], m[2], m[3]
	} else {
		message = strings.ToLower(message)
		if strings.Contains(message, "prompt or reference ") || strings.Contains(message, "prompt or input ") {
			return Failure{}, false
		}
		if strings.Contains(message, "output may contain sensitive information") {
			return Failure{Category: CategoryModerationOutput, Reason: "生成结果未通过内容安全审核", Action: "请调整提示词或参考素材后重新生成"}, true
		}
		m = moderationSubjectPattern.FindStringSubmatch(message)
		if len(m) == 0 || !moderationMessagePattern.MatchString(message) {
			return Failure{}, false
		}
		direction, media = m[1], m[2]
		if direction == "reference" {
			direction = "input"
		}
		switch {
		case strings.Contains(message, "copyright restrictions"):
			cause = "policyviolation"
		case strings.Contains(message, "may contain real person"):
			cause = "privacyinformation"
		case strings.Contains(message, "counterfeit documents or credentials"):
			cause = "deepfake"
		}
	}
	labels := map[string]string{"text": "输入文本", "image": "参考图片", "video": "参考视频", "audio": "参考音频"}
	category := CategoryModerationReference
	if direction == "output" {
		labels = map[string]string{"text": "生成文字", "image": "生成图片", "video": "生成视频", "audio": "生成音频"}
		category = CategoryModerationOutput
	} else if media == "text" {
		category = CategoryModerationInput
	}
	label := labels[media]
	f := Failure{Category: category, Reason: label + "未通过内容安全审核", Action: "请检查并更换" + label + "后重新生成"}
	if direction == "output" {
		f.Action = "请调整提示词；如使用了参考素材，请检查并更换后重新生成"
	} else if media == "text" {
		f.Action = "请调整提示词后重新生成"
	}
	switch cause {
	case "policyviolation":
		f.Reason = label + "未通过上游版权审核"
		if direction == "output" && media == "audio" {
			f.Action = "请调整音乐或音频相关提示词；如使用了参考音频，请检查并更换后重新生成"
		}
	case "privacyinformation":
		f.Reason = label + "未通过隐私审核"
		if direction == "input" && (media == "image" || media == "video") {
			f.Reason = label + "疑似包含真人形象，该模型拒绝生成"
		}
	case "deepfake":
		f.Reason = label + "未通过伪造内容审核"
	}
	return f, true
}

func persistedModerationCopy(text string) (Failure, bool) {
	for _, direction := range []string{"input", "output"} {
		for _, media := range []string{"text", "image", "video", "audio"} {
			for _, suffix := range []string{"", ".PolicyViolation", ".PrivacyInformation", ".DeepFake"} {
				f, _ := moderationErrorCopy(direction+media+"SensitiveContentDetected"+suffix, "")
				if strings.HasPrefix(text, f.Reason+"。"+f.Action+"。") {
					return f, true
				}
			}
		}
	}
	return Failure{}, false
}
