package skillhub

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
)

// Trust keys are provisioned separately from the catalog and desktop updater.
// Without pinned keys the transport's configured HTTPS origin is the trust source.
func VerifyRelease(r *Release) error {
	raw := os.Getenv("BEEFTV_SKILLHUB_TRUSTED_KEYS")
	if raw == "" {
		if os.Getenv("BEEFTV_SKILLHUB_REQUIRE_SIGNATURE") == "true" {
			return fmt.Errorf("尚未配置技能市场验签公钥")
		}
		return nil
	}
	var keys map[string]string
	if json.Unmarshal([]byte(raw), &keys) != nil || len(keys) == 0 {
		return fmt.Errorf("技能市场验签公钥配置无效")
	}
	a := r.Attestation
	if a == nil || a.Algorithm != "Ed25519" {
		return fmt.Errorf("技能版本缺少可信签名")
	}
	public, e := base64.StdEncoding.DecodeString(keys[a.KeyID])
	if e != nil || len(public) != ed25519.PublicKeySize {
		return fmt.Errorf("技能版本的签名密钥不受信任")
	}
	payload, e := base64.StdEncoding.DecodeString(a.Payload)
	if e != nil {
		return fmt.Errorf("技能版本签名内容无效")
	}
	sig, e := base64.StdEncoding.DecodeString(a.Signature)
	if e != nil || !ed25519.Verify(public, payload, sig) {
		return fmt.Errorf("技能版本签名校验失败")
	}
	var signed Release
	if json.Unmarshal(payload, &signed) != nil || signed.Attestation != nil {
		return fmt.Errorf("技能签名内容无法读取")
	}
	actual := *r
	actual.Attestation = nil
	if !reflect.DeepEqual(signed, actual) {
		return fmt.Errorf("技能版本内容与签名不符")
	}
	return nil
}
