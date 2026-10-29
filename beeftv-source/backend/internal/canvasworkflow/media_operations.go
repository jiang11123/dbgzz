package canvasworkflow

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Media operations have a closed, typed parameter surface: never raw ffmpeg arguments.
func MediaOperations() []Operation {
	crop := []Field{{Key: "x", Label: "左侧比例", Type: "number"}, {Key: "y", Label: "顶部比例", Type: "number"}, {Key: "width", Label: "宽度比例", Type: "number"}, {Key: "height", Label: "高度比例", Type: "number"}}
	return []Operation{
		{ID: "image.crop", Version: 1, Name: "裁切", OutputType: "image", Inputs: []InputPort{{"image", "图片", "image", true, false}}, Fields: crop},
		{ID: "image.resize", Version: 1, Name: "调整尺寸", OutputType: "image", Inputs: []InputPort{{"image", "图片", "image", true, false}}, Fields: []Field{{Key: "longEdge", Label: "长边像素", Type: "number"}, {Key: "algorithm", Label: "插值算法", Type: "select", Options: []FieldOption{{Label: "高质量", Value: "high"}, {Label: "双线性", Value: "bilinear"}, {Label: "最近邻", Value: "nearest"}}}}},
		{ID: "video.crop", Version: 1, Name: "画面裁切", OutputType: "video", Inputs: []InputPort{{"video", "视频", "video", true, false}}, Fields: crop},
		{ID: "video.frame", Version: 1, Name: "关键帧截取", OutputType: "image", Inputs: []InputPort{{"video", "视频", "video", true, false}}, Fields: []Field{{Key: "seconds", Label: "截帧秒数", Type: "number"}}},
		{ID: "video.audio", Version: 1, Name: "音视频分离", OutputType: "audio", Inputs: []InputPort{{"video", "视频", "video", true, false}}, Fields: []Field{}},
	}
}

func IsMediaOperation(id string) bool {
	for _, op := range MediaOperations() {
		if op.ID == id {
			return true
		}
	}
	return false
}

func ValidateMediaConfig(n Node) error {
	switch n.OperationID {
	case "image.crop", "video.crop":
		x, y, w, h := operationNumber(n.Config["x"]), operationNumber(n.Config["y"]), operationNumber(n.Config["width"]), operationNumber(n.Config["height"])
		if x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > 1.000001 || y+h > 1.000001 {
			return fmt.Errorf("裁切区域必须在 0 到 1 的画面比例内")
		}
	case "image.resize":
		value := operationNumber(n.Config["longEdge"])
		if value < 16 || value > 4096 || math.Trunc(value) != value {
			return fmt.Errorf("图片长边需为 16 到 4096 的整数")
		}
		if value, ok := n.Config["algorithm"]; ok && value != "high" && value != "bilinear" && value != "nearest" {
			return fmt.Errorf("不支持的图片插值算法")
		}
	case "video.frame":
		value := operationNumber(n.Config["seconds"])
		if value < 0 || value > 43200 {
			return fmt.Errorf("截帧时间无效")
		}
	}
	return nil
}

func MediaCommand(n Node, width, height int) (args []string, extension, mime string, err error) {
	if !IsMediaOperation(n.OperationID) {
		return nil, "", "", fmt.Errorf("不支持的媒体处理")
	}
	if err = ValidateOperation(n); err != nil {
		return
	}
	extension, mime = ".png", "image/png"
	switch n.OperationID {
	case "image.crop", "video.crop":
		if width <= 0 || height <= 0 {
			err = fmt.Errorf("素材缺少有效尺寸")
			return
		}
		x, y := int(operationNumber(n.Config["x"])*float64(width)), int(operationNumber(n.Config["y"])*float64(height))
		w, h := int(operationNumber(n.Config["width"])*float64(width)), int(operationNumber(n.Config["height"])*float64(height))
		if n.OperationID == "image.crop" {
			w = int(math.Ceil(operationNumber(n.Config["width"]) * float64(width)))
			h = int(math.Ceil(operationNumber(n.Config["height"]) * float64(height)))
		}
		if n.OperationID == "video.crop" {
			w = w / 2 * 2
			h = h / 2 * 2
			x = x / 2 * 2
			y = y / 2 * 2
			extension, mime = ".mp4", "video/mp4"
		}
		if w < 1 || h < 1 {
			err = fmt.Errorf("裁切区域过小")
			return
		}
		args = []string{"-vf", fmt.Sprintf("crop=%d:%d:%d:%d", w, h, x, y)}
	case "image.resize":
		if width <= 0 || height <= 0 {
			err = fmt.Errorf("素材缺少有效尺寸")
			return
		}
		edge := int(operationNumber(n.Config["longEdge"]))
		w, h := edge, max(1, int(math.Round(float64(height)*float64(edge)/float64(width))))
		if height > width {
			h = edge
			w = max(1, int(math.Round(float64(width)*float64(edge)/float64(height))))
		}
		algorithm := "bicubic"
		if n.Config["algorithm"] == "bilinear" {
			algorithm = "bilinear"
		}
		if n.Config["algorithm"] == "nearest" {
			algorithm = "neighbor"
		}
		filters := []string{}
		if algorithm == "bicubic" {
			for sw, sh := width, height; sw*2 < w && sh*2 < h; {
				sw, sh = sw*2, sh*2
				filters = append(filters, fmt.Sprintf("scale=%d:%d:flags=bicubic", sw, sh))
			}
		}
		filters = append(filters, fmt.Sprintf("scale=%d:%d:flags=%s", w, h, algorithm))
		args = []string{"-vf", strings.Join(filters, ",")}
	case "video.frame":
		args = []string{"-ss", strconv.FormatFloat(operationNumber(n.Config["seconds"]), 'f', 3, 64)}
	case "video.audio":
		return []string{"-vn", "-c:a", "aac"}, ".m4a", "audio/mp4", nil
	}
	if n.MediaType == "image" {
		args = append(args, "-frames:v", "1", "-an")
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart")
	}
	return
}
