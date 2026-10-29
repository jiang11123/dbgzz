package beefapi

import (
	"encoding/json"
	"math"
)

func NormalizeCatalogVideoPricing(raw json.RawMessage) (map[string]any, bool) {
	var value struct {
		Currency            string   `json:"currency"`
		Mode                string   `json:"mode"`
		ReferenceImage      *float64 `json:"reference_image"`
		FreeReferenceImages *int     `json:"free_reference_images"`
		ReferenceInvoice    *struct {
			USDCNY     float64 `json:"usd_cny"`
			ReserveUSD float64 `json:"reserve_usd"`
		} `json:"reference_invoice"`
		Rates map[string]struct {
			Output         float64 `json:"output"`
			ReferenceVideo float64 `json:"reference_video"`
		} `json:"rates"`
	}
	if json.Unmarshal(raw, &value) != nil || value.Currency != "CNY" || value.Mode != "tokens" && value.Mode != "seconds" || len(value.Rates) == 0 {
		return nil, false
	}
	rates := map[string]any{}
	for resolution, rate := range value.Rates {
		if resolution != "480p" && resolution != "720p" && resolution != "768p" && resolution != "1080p" && resolution != "2k" && resolution != "4k" {
			return nil, false
		}
		if rate.Output <= 0 || value.Mode == "tokens" && rate.ReferenceVideo <= 0 || value.Mode == "seconds" && rate.ReferenceVideo != 0 || math.IsNaN(rate.Output) || math.IsInf(rate.Output, 0) || math.IsNaN(rate.ReferenceVideo) || math.IsInf(rate.ReferenceVideo, 0) {
			return nil, false
		}
		rates[resolution] = map[string]any{"output": rate.Output, "reference_video": rate.ReferenceVideo}
	}
	result := map[string]any{"currency": "CNY", "mode": value.Mode, "rates": rates}
	if invoice := value.ReferenceInvoice; invoice != nil {
		if value.Mode != "seconds" || invoice.USDCNY < 5 || invoice.USDCNY > 10 || invoice.ReserveUSD <= 0 || invoice.ReserveUSD > 100 || math.IsNaN(invoice.USDCNY) || math.IsInf(invoice.USDCNY, 0) || math.IsNaN(invoice.ReserveUSD) || math.IsInf(invoice.ReserveUSD, 0) {
			return nil, false
		}
		result["reference_invoice"] = map[string]any{"usd_cny": invoice.USDCNY, "reserve_usd": invoice.ReserveUSD}
	}
	if value.ReferenceImage != nil || value.FreeReferenceImages != nil {
		if value.Mode != "seconds" || value.ReferenceImage == nil || value.FreeReferenceImages == nil || *value.ReferenceImage < 0 || math.IsNaN(*value.ReferenceImage) || math.IsInf(*value.ReferenceImage, 0) || *value.FreeReferenceImages < 0 || *value.FreeReferenceImages > 12 {
			return nil, false
		}
		result["reference_image"], result["free_reference_images"] = *value.ReferenceImage, *value.FreeReferenceImages
	}
	return result, true
}
