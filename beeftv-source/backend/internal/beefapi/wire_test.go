package beefapi

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTokenAndConnectionDecodeNumericIDsFromWire(t *testing.T) {
	tokenRaw := []byte(`{"api_key":"ent-secret-key","base_url":"http://enterprise.localhost:35184/v1","market":"enterprise","group":"enterprise","key_name":"BeefTV","token_id":9001,"account":{"id":42,"username":"ender","display_name":"Ender","email":"e@example.com"}}`)
	var token tokenSuccess
	if err := json.Unmarshal(tokenRaw, &token); err != nil {
		t.Fatal(err)
	}
	accountID, tokenID, err := validateTokenSuccess("http://enterprise.localhost:35184", token)
	if err != nil {
		t.Fatal(err)
	}
	if accountID != "42" || tokenID != "9001" {
		t.Fatalf("normalized ids account=%q token=%q", accountID, tokenID)
	}

	connectionRaw := []byte(`{"market":"enterprise","token_id":9001,"key_name":"BeefTV","account":{"id":42,"username":"ender","display_name":"Ender"}}`)
	var view connectionView
	if err := json.Unmarshal(connectionRaw, &view); err != nil {
		t.Fatal(err)
	}
	accountID, err = positiveIdentity(view.Account.ID, "企业账号无效")
	if err != nil {
		t.Fatal(err)
	}
	tokenID, err = positiveIdentity(view.TokenID, "企业授权凭证无效")
	if err != nil {
		t.Fatal(err)
	}
	if accountID != "42" || tokenID != "9001" {
		t.Fatalf("connection ids account=%q token=%q", accountID, tokenID)
	}
}

func TestValidateTokenSuccessRejectsMissingMarketGroupAndNonPositiveIDs(t *testing.T) {
	origin := "http://enterprise.localhost:35184"
	valid := tokenSuccess{
		APIKey: "ent-secret-key", BaseURL: origin + "/v1", Market: "enterprise", Group: "enterprise",
		KeyName: "BeefTV", TokenID: "9001", Account: Account{ID: "42", Username: "ender"},
	}
	if _, _, err := validateTokenSuccess(origin, valid); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		token tokenSuccess
	}{
		{name: "missing market", token: withToken(valid, func(item *tokenSuccess) { item.Market = "" })},
		{name: "wrong market", token: withToken(valid, func(item *tokenSuccess) { item.Market = "domestic" })},
		{name: "missing group", token: withToken(valid, func(item *tokenSuccess) { item.Group = "" })},
		{name: "wrong group", token: withToken(valid, func(item *tokenSuccess) { item.Group = "gpt-pro" })},
		{name: "empty key", token: withToken(valid, func(item *tokenSuccess) { item.APIKey = "" })},
		{name: "zero account", token: withToken(valid, func(item *tokenSuccess) { item.Account.ID = "0" })},
		{name: "negative token", token: withToken(valid, func(item *tokenSuccess) { item.TokenID = "-3" })},
		{name: "string account", token: withToken(valid, func(item *tokenSuccess) { item.Account.ID = "acct-1" })},
	}
	for _, test := range cases {
		_, _, err := validateTokenSuccess(origin, test.token)
		if err == nil {
			t.Fatalf("%s: accepted", test.name)
		}
		if strings.Contains(err.Error(), "ent-secret-key") {
			t.Fatalf("%s leaked secret: %v", test.name, err)
		}
	}
}

func withToken(base tokenSuccess, patch func(*tokenSuccess)) tokenSuccess {
	patch(&base)
	return base
}
