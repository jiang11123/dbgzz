package app

import (
	"encoding/binary"
	"fmt"
	"math"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Sample timing belongs to the video track, not the movie/audio duration.
// FourCC identifies the encoding without treating unfamiliar codecs as invalid.
func referenceVideoEncoding(data []byte) (codec string, fps float64) {
	moov := firstMP4Payload(data, 0, len(data), "moov")
	for _, track := range mp4Payloads(moov, "trak") {
		if trakHandlerType(track) != "vide" {
			continue
		}
		mdia := firstMP4Payload(track, 0, len(track), "mdia")
		mdhd := firstMP4Payload(mdia, 0, len(mdia), "mdhd")
		minf := firstMP4Payload(mdia, 0, len(mdia), "minf")
		stbl := firstMP4Payload(minf, 0, len(minf), "stbl")
		stsd := firstMP4Payload(stbl, 0, len(stbl), "stsd")
		if len(stsd) >= 16 && binary.BigEndian.Uint32(stsd[4:8]) > 0 {
			codec = string(stsd[12:16])
		}
		scaleAt := 12
		if len(mdhd) > 0 && mdhd[0] == 1 {
			scaleAt = 20
		}
		if len(mdhd) < scaleAt+4 {
			return codec, 0
		}
		scale := binary.BigEndian.Uint32(mdhd[scaleAt : scaleAt+4])
		stts := firstMP4Payload(stbl, 0, len(stbl), "stts")
		if len(stts) < 8 {
			return codec, 0
		}
		entries := uint64(binary.BigEndian.Uint32(stts[4:8]))
		if entries > uint64((len(stts)-8)/8) {
			return codec, 0
		}
		var samples, ticks float64
		for i := uint64(0); i < entries; i++ {
			at := 8 + int(i)*8
			count, delta := binary.BigEndian.Uint32(stts[at:at+4]), binary.BigEndian.Uint32(stts[at+4:at+8])
			if count > 0 && delta == 0 {
				return codec, 0
			}
			samples += float64(count)
			ticks += float64(count) * float64(delta)
		}
		if ticks > 0 && scale > 0 {
			fps = samples * float64(scale) / ticks
		}
		if scale > 0 {
			tkhd := firstMP4Payload(track, 0, len(track), "tkhd")
			idAt := 12
			if len(tkhd) > 0 && tkhd[0] == 1 {
				idAt = 20
			}
			if len(tkhd) >= idAt+4 {
				fragmentSamples, fragmentTicks := referenceFragmentSamples(data, binary.BigEndian.Uint32(tkhd[idAt:idAt+4]))
				samples += fragmentSamples
				ticks += fragmentTicks
				if ticks > 0 {
					fps = samples * float64(scale) / ticks
				}
			}
		}
		return codec, fps
	}
	return "", 0
}

func referenceFragmentSamples(data []byte, trackID uint32) (samples, ticks float64) {
	moov := firstMP4Payload(data, 0, len(data), "moov")
	mvex := firstMP4Payload(moov, 0, len(moov), "mvex")
	var defaultDelta uint32
	for _, trex := range mp4Payloads(mvex, "trex") {
		if len(trex) >= 16 && binary.BigEndian.Uint32(trex[4:8]) == trackID {
			defaultDelta = binary.BigEndian.Uint32(trex[12:16])
		}
	}
	for _, moof := range mp4Payloads(data, "moof") {
		for _, traf := range mp4Payloads(moof, "traf") {
			tfhd := firstMP4Payload(traf, 0, len(traf), "tfhd")
			if len(tfhd) < 8 || binary.BigEndian.Uint32(tfhd[4:8]) != trackID {
				continue
			}
			flags := binary.BigEndian.Uint32(tfhd[:4]) & 0xffffff
			delta, at := defaultDelta, 8
			if flags&1 != 0 {
				at += 8
			}
			if flags&2 != 0 {
				at += 4
			}
			if flags&8 != 0 {
				if len(tfhd) < at+4 {
					return 0, 0
				}
				delta = binary.BigEndian.Uint32(tfhd[at : at+4])
			}
			for _, run := range mp4Payloads(traf, "trun") {
				if len(run) < 8 {
					return 0, 0
				}
				flags := binary.BigEndian.Uint32(run[:4]) & 0xffffff
				count := uint64(binary.BigEndian.Uint32(run[4:8]))
				at := 8
				if flags&1 != 0 {
					at += 4
				}
				if flags&4 != 0 {
					at += 4
				}
				stride := 0
				for _, bit := range []uint32{0x100, 0x200, 0x400, 0x800} {
					if flags&bit != 0 {
						stride += 4
					}
				}
				if at > len(run) || (stride > 0 && count > uint64((len(run)-at)/stride)) {
					return 0, 0
				}
				if flags&0x100 == 0 {
					if count > 0 && delta == 0 {
						return 0, 0
					}
					ticks += float64(count) * float64(delta)
				} else {
					for i := uint64(0); i < count; i++ {
						d := binary.BigEndian.Uint32(run[at : at+4])
						if d == 0 {
							return 0, 0
						}
						ticks += float64(d)
						at += stride
					}
				}
				samples += float64(count)
			}
		}
	}
	return samples, ticks
}

func seedanceFrameRatePreflight(config providerConfig) bool {
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(config.InterfaceType)) {
		return isSeedance2Family(config.InterfaceType, config.Model)
	}
	u, err := url.Parse(config.BaseURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	// Managed BeefAPI routing is checked by the gateway, where the actual
	// upstream is known. Direct WhatsToken still validates locally.
	return host == "whatstoken.ai" || host == "www.whatstoken.ai"
}

func referenceVideoFrameRateError(config providerConfig, index int, fps float64) error {
	if !seedanceFrameRatePreflight(config) {
		return nil
	}
	if fps <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) {
		return BadAuthRequest(fmt.Sprintf("第 %d 个参考视频帧率无法读取，请重新导出 MP4/MOV 后上传", index+1))
	}
	if fps > 0 && (fps < 24-1e-6 || fps > 60+1e-6) {
		return BadAuthRequest(fmt.Sprintf("第 %d 个参考视频平均帧率为 %.3f FPS，需要 24–60 FPS；请将参考视频重新导出为 24–60 FPS 后再提交", index+1, fps))
	}
	return nil
}
