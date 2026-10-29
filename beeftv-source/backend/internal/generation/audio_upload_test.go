package generation

import (
	"bytes"
	"mime/multipart"
	"strings"
	"testing"
)

func TestMP3MultipartUsesSupportedFilenameExtension(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	media := Media{ID: "sample", DataURL: DataURL("audio/mpeg", []byte("ID3 synthetic fixture"))}
	if err := writeMediaPart(writer, "file", media); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	part, err := multipart.NewReader(&body, writer.Boundary()).NextPart()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(part.FileName(), ".mp3") || part.FormName() != "file" || part.Header.Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("unsupported MP3 upload: filename=%s headers=%v", part.FileName(), part.Header)
	}
}
