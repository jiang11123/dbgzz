package skills

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skillhub"
)

// RefreshPublication reads the current cloud draft without reuploading the local
// snapshot. A changed preview always requires another explicit submit action.
func (s *Service) RefreshPublication(ctx context.Context, user, id string) (*PublishPlan, error) {
	unlock := s.lockMarket(user)
	defer unlock()
	p, e := s.PublishPlan(user, id)
	if e != nil {
		return nil, e
	}
	if p.SubmissionID == "" {
		return nil, kernel.BadAuthRequest("请先确认上传文件")
	}
	c, e := marketClient()
	if e != nil {
		return nil, e
	}
	token, e := s.marketToken(user, c)
	if e != nil {
		return nil, e
	}
	return s.refreshPublication(ctx, user, c, token, p)
}
func (s *Service) refreshPublication(ctx context.Context, user string, c *skillhub.Client, token string, p *PublishPlan) (*PublishPlan, error) {
	var draft skillhub.Draft
	if e := c.JSON(ctx, "GET", "submissions/"+p.SubmissionID, token, "", nil, &draft); e != nil {
		return nil, e
	}
	file, _ := s.planFile(user, p.ID)
	p.ReviewReason = draft.ReviewReason
	// Discard stale authorization before any network or parsing failure can return.
	p.Preview = nil
	p.Revision = draft.Revision
	p.Metadata = draft.Metadata
	p.Files = draft.Files
	p.Instruction = ""
	p.Status = "needs_preview"
	if e := writeMarketJSON(file, p); e != nil {
		return nil, e
	}
	if draft.Status == "submitted" || draft.Status == "in_review" || draft.Status == "published" || draft.Status == "withdrawn" || draft.Status == "rejected" {
		p.Status = draft.Status
		if e := writeMarketJSON(file, p); e != nil {
			return nil, e
		}
		return p, nil
	}
	if e := c.JSON(ctx, "POST", "submissions/"+p.SubmissionID+"/validate", token, "", map[string]int64{"revision": draft.Revision}, &draft); e != nil {
		return nil, e
	}
	var preview skillhub.Preview
	if e := c.JSON(ctx, "GET", "submissions/"+p.SubmissionID+"/preview", token, "", nil, &preview); e != nil {
		return nil, e
	}
	data, e := c.ArchiveWithToken(ctx, "submissions/"+p.SubmissionID+"/archive", token)
	if e != nil {
		return nil, e
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != draft.ArchiveSHA256 || int64(len(data)) != draft.ArchiveBytes {
		return nil, kernel.NewAppError(409, "稿件文件已变化，请重新读取预览")
	}
	archive, e := archiveFromZip(data, "")
	if e != nil {
		return nil, e
	}
	if archive.ContentHash != draft.ContentHash || len(archive.Files) != len(preview.Files) || preview.Revision != draft.Revision {
		return nil, kernel.NewAppError(409, "稿件预览已变化，请重新读取")
	}
	seen := map[string]bool{}
	for _, f := range preview.Files {
		b, ok := archive.Files[f.Path]
		h := sha256.Sum256(b)
		if !ok || seen[f.Path] || int64(len(b)) != f.Size || hex.EncodeToString(h[:]) != f.SHA256 {
			return nil, kernel.NewAppError(409, "稿件预览与文件不一致")
		}
		seen[f.Path] = true
	}
	p.Preview = &preview
	p.Metadata = preview.Metadata
	p.Files = preview.Files
	p.Instruction = string(archive.Files["SKILL.md"])
	p.Revision = preview.Revision
	p.Status = "awaiting_submit_confirmation"
	if e = writeMarketJSON(file, p); e != nil {
		return nil, e
	}
	return p, nil
}
