package appearance

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
)

func TestValidateUploadSniffsBytesInsteadOfDeclaredMIME(t *testing.T) {
	pngHeader := multipartFileHeader(t, "logo.png", "text/plain", append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{0}, 32)...))
	if mimeType, err := ValidateUpload(AssetLogo, pngHeader); err != nil || mimeType != "image/png" {
		t.Fatalf("ValidateUpload(png) = %q, %v", mimeType, err)
	}
	darkPNGHeader := multipartFileHeader(t, "logo-dark.png", "text/plain", append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{0}, 32)...))
	if mimeType, err := ValidateUpload(AssetDarkLogo, darkPNGHeader); err != nil || mimeType != "image/png" {
		t.Fatalf("ValidateUpload(dark png) = %q, %v", mimeType, err)
	}
	fakeImage := multipartFileHeader(t, "fake.png", "image/png", []byte("not an image"))
	if _, err := ValidateUpload(AssetLogo, fakeImage); err == nil {
		t.Fatal("declared image MIME accepted non-image bytes")
	}
	mp4Bytes := append([]byte{0x00, 0x00, 0x00, 0x14}, []byte("ftypisom\x00\x00\x00\x00isom")...)
	mp4Header := multipartFileHeader(t, "hero.mp4", "application/octet-stream", mp4Bytes)
	if mimeType, err := ValidateUpload(AssetVideo, mp4Header); err != nil || mimeType != "video/mp4" {
		t.Fatalf("ValidateUpload(mp4) = %q, %v", mimeType, err)
	}
	fakeMP4 := multipartFileHeader(t, "fake.mp4", "video/mp4", append([]byte{0x00, 0x00, 0x10, 0x00}, []byte("ftypisom")...))
	if _, err := ValidateUpload(AssetVideo, fakeMP4); err == nil {
		t.Fatal("invalid MP4 box size accepted")
	}
}

func multipartFileHeader(t *testing.T, name string, contentType string, data []byte) *multipart.FileHeader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+name+`"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if err := req.ParseMultipartForm(int64(body.Len()) + 1024); err != nil {
		t.Fatal(err)
	}
	return req.MultipartForm.File["file"][0]
}
