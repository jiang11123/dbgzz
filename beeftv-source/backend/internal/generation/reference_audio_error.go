package generation

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	audioDurationError  = regexp.MustCompile(`(?i)^reference audio (\d+) is (\d+(?:\.\d+)?) seconds; use audio between (\d+(?:\.\d+)?) and (\d+(?:\.\d+)?) seconds`)
	audioTotalError     = regexp.MustCompile(`(?i)^reference audio is (\d+(?:\.\d+)?) seconds in total; this model accepts at most (\d+(?:\.\d+)?) seconds of reference audio`)
	audioTotalPersisted = regexp.MustCompile(`^参考音频总时长为 (\d+(?:\.\d+)?) 秒[。，](?:该|当前)模型最多支持 (\d+(?:\.\d+)?) 秒`)
	audioNumberError    = regexp.MustCompile(`(?i)^reference audio (\d+)(?::| requires| exceeds)`)
	audioIssuePersisted = regexp.MustCompile(`^(第 \d+ 段参考音频|参考音频)(无法下载|的格式或时长无法读取|文件过大|不符合模型要求)。`)
	referenceDebugIDs   = regexp.MustCompile(`。排查编号：([^。]+)。?$`)
)

func persistedReferenceIDs(text string) (requestID, taskID string) {
	m := referenceDebugIDs.FindStringSubmatch(text)
	if len(m) != 2 {
		return
	}
	for _, part := range strings.Split(m[1], " · ") {
		if strings.HasPrefix(part, "请求 ") {
			requestID = sanitizeDebugID(strings.TrimPrefix(part, "请求 "))
		}
		if strings.HasPrefix(part, "任务 ") {
			taskID = sanitizeDebugID(strings.TrimPrefix(part, "任务 "))
		}
	}
	return
}

// Only measured numbers and known failure shapes enter user-facing copy.
func referenceAudioCopy(text string, invalidAudio bool) (categoryCopy, bool) {
	text = sanitizeProviderText(text)
	if m := audioDurationError.FindStringSubmatch(text); len(m) == 5 {
		return categoryCopy{Reason: fmt.Sprintf("第 %s 段参考音频时长为 %s 秒", m[1], m[2]), Action: fmt.Sprintf("需要 %s–%s 秒；请裁剪或更换这段素材后再提交", m[3], m[4])}, true
	}
	m := audioTotalError.FindStringSubmatch(text)
	if len(m) == 0 {
		m = audioTotalPersisted.FindStringSubmatch(text)
	}
	if len(m) == 3 {
		return categoryCopy{Reason: fmt.Sprintf("参考音频总时长为 %s 秒", m[1]), Action: fmt.Sprintf("该模型最多支持 %s 秒参考音频；请裁剪或减少参考音频后再提交", m[2])}, true
	}
	label, issue := "参考音频", ""
	numbered := audioNumberError.FindStringSubmatch(text)
	if len(numbered) == 2 {
		label = "第 " + numbered[1] + " 段参考音频"
	}
	if persisted := audioIssuePersisted.FindStringSubmatch(text); len(persisted) == 3 {
		label, issue = persisted[1], persisted[2]
	} else if invalidAudio || len(numbered) == 2 {
		lower := strings.ToLower(text)
		switch {
		case strings.Contains(lower, "15 mib"), strings.Contains(lower, "byte limit"):
			issue = "文件过大"
		case strings.Contains(lower, "duration could not be measured"), strings.Contains(lower, "invalid"), strings.Contains(lower, "unsupported"), strings.Contains(lower, "readable audio track"):
			issue = "的格式或时长无法读取"
		case strings.Contains(lower, "download"), strings.Contains(lower, "https url"), strings.Contains(lower, "url"), strings.Contains(lower, "redirect"):
			issue = "无法下载"
		default:
			issue = "不符合模型要求"
		}
	}
	actions := map[string]string{
		"无法下载":       "请重新上传音频，确认素材链接可公开访问后再提交",
		"的格式或时长无法读取": "请将音频重新导出为 MP3、WAV 或 M4A，确认文件完整且含有音轨后再上传",
		"文件过大":       "请压缩或更换音频，确保文件不超过模型的大小限制后再提交",
		"不符合模型要求":    "请检查参考音频的时长、格式和大小，调整后再提交",
	}
	if issue == "" {
		return categoryCopy{}, false
	}
	return categoryCopy{Reason: label + issue, Action: actions[issue]}, true
}
