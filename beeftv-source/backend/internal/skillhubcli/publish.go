package skillhubcli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"strconv"
	"time"

	"infinite-canvas/backend/internal/skillhub"
)

func runPublishing(ctx context.Context, c *skillhub.Client, a arguments, out io.Writer) error {
	if a.command == "inspect" || a.command == "publish" {
		if len(a.positional) != 1 {
			return fail("directory_required", "请指定要检查的技能目录")
		}
		b, err := inspectBundle(a.positional[0], a.options["metadata"])
		if err != nil {
			return err
		}
		return emit(out, map[string]any{"bundle": b, "uploaded": false, "submitted": false, "next": "请让用户确认文件清单和摘要，再 authorize、poll、upload；公开送审另行 preview 和 submit。"})
	}
	stateFile := a.options["state"]
	unlock, err := lockState(stateFile)
	if err != nil {
		return err
	}
	defer unlock()
	state, err := loadState(stateFile, c.BaseURL(), a.command == "authorize")
	if err != nil {
		return err
	}
	if a.command == "authorize" {
		var auth skillhub.Authorization
		if err = c.JSON(ctx, "POST", "authorizations", "", "", map[string]string{"clientName": "BeefTV Skills CLI"}, &auth); err != nil {
			return err
		}
		state.DeviceCode = auth.DeviceCode
		state.AccessToken = ""
		state.ExpiresAt = 0
		if err = saveState(stateFile, state); err != nil {
			return err
		}
		return emit(out, map[string]any{"userCode": auth.UserCode, "verificationUrl": auth.VerificationURL, "expiresIn": auth.ExpiresIn, "interval": auth.Interval, "next": "请用户在浏览器确认授权，再运行 poll。"})
	}
	if a.command == "poll" {
		if state.DeviceCode == "" {
			return fail("authorization_required", "请先 authorize")
		}
		var token skillhub.Token
		if err = c.JSON(ctx, "POST", "authorizations/token", "", "", map[string]string{"deviceCode": state.DeviceCode}, &token); err != nil {
			return err
		}
		if token.AccessToken == "" || token.ExpiresIn <= 0 {
			return fail("invalid_token_response", "投稿授权响应无效")
		}
		var account skillhub.PublishingAccount
		if err = c.JSON(ctx, "GET", "session", token.AccessToken, "", nil, &account); err != nil {
			return err
		}
		if account.UserID < 1 {
			return fail("invalid_account", "无法确认投稿账号")
		}
		if state.Account.UserID != 0 && state.Account.UserID != account.UserID {
			return &Error{Code: 4, Reason: "account_changed", Message: "这份投稿属于另一个账号，请用原账号重新授权或为新投稿使用新状态文件"}
		}
		state.Account = account
		state.AccessToken = token.AccessToken
		state.ExpiresAt = time.Now().Unix() + token.ExpiresIn
		if err = saveState(stateFile, state); err != nil {
			return err
		}
		return emit(out, map[string]any{"authorized": true, "account": state.Account, "expiresAt": state.ExpiresAt})
	}
	if state.AccessToken == "" || state.ExpiresAt <= time.Now().Unix() {
		return fail("authorization_required", "投稿授权缺失或已过期，请 authorize 后继续，现有草稿会保留")
	}
	if a.command == "revoke" {
		if err = c.JSON(ctx, "POST", "authorizations/revoke", state.AccessToken, "", nil, nil); err != nil {
			return err
		}
		state.AccessToken = ""
		state.DeviceCode = ""
		state.ExpiresAt = 0
		if err = saveState(stateFile, state); err != nil {
			return err
		}
		return emit(out, map[string]bool{"revoked": true})
	}
	if a.command == "upload" {
		if err = checkPublishingAccount(ctx, c, state); err != nil {
			return err
		}
		return uploadBundle(ctx, c, a, state, stateFile, out)
	}
	if state.SubmissionID == "" {
		return fail("submission_required", "尚无已上传的私有草稿")
	}
	route := "submissions/" + state.SubmissionID
	switch a.command {
	case "preview":
		var result skillhub.Preview
		if err = c.JSON(ctx, "GET", route+"/preview", state.AccessToken, "", nil, &result); err != nil {
			return err
		}
		return emit(out, result)
	case "status":
		var result skillhub.Draft
		if err = c.JSON(ctx, "GET", route, state.AccessToken, "", nil, &result); err != nil {
			return err
		}
		return emit(out, result)
	case "submit":
		if err = checkPublishingAccount(ctx, c, state); err != nil {
			return err
		}
		revision, err := strconv.ParseInt(a.options["revision"], 10, 64)
		digest := a.options["preview-digest"]
		if err != nil || revision < 1 || digest == "" || a.options["confirm-submit"] != "true" {
			return fail("submit_confirmation_required", "请用户确认完整预览，再提供 --confirm-submit、--revision 和 --preview-digest")
		}
		var preview skillhub.Preview
		if err = c.JSON(ctx, "GET", route+"/preview", state.AccessToken, "", nil, &preview); err != nil {
			return err
		}
		if preview.Revision != revision || preview.PreviewDigest != digest {
			return &Error{Code: 4, Reason: "preview_changed", Message: "公开内容已改变，请重新预览并确认"}
		}
		var result skillhub.Draft
		key := "cli-submit-" + skillhub.Digest([]byte(state.SubmissionID+"\x00"+digest))
		if err = c.JSON(ctx, "POST", route+"/submit", state.AccessToken, key, map[string]any{"revision": revision, "previewDigest": digest}, &result); err != nil {
			return err
		}
		return emit(out, map[string]any{"submissionId": result.SubmissionID, "revision": result.Revision, "status": result.Status, "account": state.Account})
	}
	return fail("unknown_command", "未知投稿命令")
}

func checkPublishingAccount(ctx context.Context, c *skillhub.Client, state *publishingState) error {
	var account skillhub.PublishingAccount
	if err := c.JSON(ctx, "GET", "session", state.AccessToken, "", nil, &account); err != nil {
		return err
	}
	if state.Account.UserID < 1 || account.UserID != state.Account.UserID {
		return &Error{Code: 4, Reason: "account_changed", Message: "投稿账号与当前授权不一致，请重新核对账号"}
	}
	return nil
}

func uploadBundle(ctx context.Context, c *skillhub.Client, a arguments, state *publishingState, stateFile string, out io.Writer) error {
	if len(a.positional) != 1 {
		return fail("directory_required", "请指定技能目录")
	}
	b, err := inspectBundle(a.positional[0], a.options["metadata"])
	if err != nil {
		return err
	}
	if a.options["confirm-upload"] != "true" || a.options["content-hash"] != b.ContentHash || a.options["archive-sha256"] != b.ArchiveSHA256 {
		return fail("upload_confirmation_required", "请用户确认 inspect 的确切文件清单，并提供相同内容摘要和 ZIP 摘要")
	}
	metadataJSON, err := json.Marshal(b.Metadata)
	if err != nil {
		return err
	}
	metadataHash := skillhub.Digest(metadataJSON)
	if state.ContentHash != "" && (state.ContentHash != b.ContentHash || state.MetadataHash != metadataHash) {
		return &Error{Code: 4, Reason: "bundle_changed", Message: "这份状态文件对应其他投稿内容；请检查原草稿，使用新状态文件准备新投稿"}
	}
	state.ContentHash = b.ContentHash
	state.MetadataHash = metadataHash
	if state.CreateKey == "" {
		state.CreateKey, err = newCreateKey()
		if err != nil {
			return err
		}
	}
	if err = saveState(stateFile, state); err != nil {
		return err
	}
	var draft skillhub.Draft
	if state.SubmissionID == "" {
		if err = c.JSON(ctx, "POST", "submissions", state.AccessToken, state.CreateKey, b.Metadata, &draft); err != nil {
			return err
		}
		state.SubmissionID = draft.SubmissionID
		if err = saveState(stateFile, state); err != nil {
			return err
		}
	}
	route := "submissions/" + state.SubmissionID
	if err = c.JSON(ctx, "GET", route, state.AccessToken, "", nil, &draft); err != nil {
		return err
	}
	if draft.ContentHash != "" && (draft.ContentHash != b.ContentHash || draft.ArchiveSHA256 != b.ArchiveSHA256) {
		return &Error{Code: 4, Reason: "draft_changed", Message: "服务器草稿文件已改变，请先检查草稿"}
	}
	if draft.Status == "submitted" || draft.Status == "published" {
		return emit(out, map[string]any{"submissionId": draft.SubmissionID, "status": draft.Status})
	}
	if draft.ContentHash == "" {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, err := form.CreateFormFile("file", "skill.zip")
		if err != nil {
			return err
		}
		if _, err = part.Write(b.Archive); err != nil {
			return err
		}
		if err = form.WriteField("revision", strconv.FormatInt(draft.Revision, 10)); err != nil {
			return err
		}
		if err = form.Close(); err != nil {
			return err
		}
		response, err := c.Request(ctx, "POST", route+"/uploads", state.AccessToken, form.FormDataContentType(), "", &body)
		if err != nil {
			return err
		}
		if err = skillhub.Decode(response, &draft); err != nil {
			return err
		}
	}
	if err = c.JSON(ctx, "POST", route+"/validate", state.AccessToken, "", map[string]any{"revision": draft.Revision}, &draft); err != nil {
		return err
	}
	if draft.ContentHash != b.ContentHash {
		return &Error{Code: 4, Reason: "draft_changed", Message: "服务器校验的内容与确认的文件不符"}
	}
	var preview skillhub.Preview
	if err = c.JSON(ctx, "GET", route+"/preview", state.AccessToken, "", nil, &preview); err != nil {
		return err
	}
	return emit(out, map[string]any{"submissionId": draft.SubmissionID, "status": draft.Status, "account": state.Account, "preview": preview, "submitted": false, "next": "请用户确认此次公开预览，再显式 submit。"})
}
