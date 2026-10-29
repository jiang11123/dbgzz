package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPStartupTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	start := time.Now()
	err := run([]string{"mcp", "serve"})
	if cliErr, ok := err.(*cliError); !ok || cliErr.reason != "mcp_startup_timeout" {
		t.Fatalf("expected startup timeout, got %v", err)
	}
	if elapsed := time.Since(start); elapsed < 4*time.Second || elapsed > 7*time.Second {
		t.Fatalf("startup deadline not bounded to 5 seconds: %s", elapsed)
	}
}

// The test executable runs the real main function so stdout and process exit
// behavior are exercised without building or launching a desktop/database.
func TestMCPProcessHelper(t *testing.T) {
	if os.Getenv("BEEFTV_TEST_PROCESS") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			main()
		}
	}
	os.Exit(99)
}

func TestMCPFailureKeepsStdoutPure(t *testing.T) {
	t.Setenv("BEEFTV_BASE_URL", "")
	t.Setenv("BEEFTV_DATA_DIR", t.TempDir())
	for _, args := range [][]string{{"mcp", "serve"}, {"mcp", "serve", "--json"}} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestMCPProcessHelper$", "--"}, args...)...)
		cmd.Env = append(os.Environ(), "BEEFTV_TEST_PROCESS=1")
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		cancel()
		if err == nil || stdout.Len() != 0 || stderr.Len() == 0 {
			t.Fatalf("args=%v err=%v stdout=%q stderr=%q", args, err, stdout.String(), stderr.String())
		}
	}
}

func TestMCPExitsWhenPipeCloses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[]}}`))
	}))
	defer server.Close()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMCPProcessHelper$", "--", "mcp", "serve")
	cmd.Env = append(os.Environ(), "BEEFTV_TEST_PROCESS=1")
	cmd.Stdin = strings.NewReader("")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("closed pipe did not exit cleanly: %v, stderr=%s", err, stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("unexpected protocol stdout: %s", stdout.String())
	}
}

func TestMCPFixtureHandshakeAndCancellation(t *testing.T) {
	requestStarted := make(chan struct{})
	requestCancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"code":0,"data":{"ops":[{"id":"canvas.get","summary":"fixture","readOnly":true,"params":{"type":"object"}}]}}`))
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		close(requestStarted)
		<-r.Context().Done()
		close(requestCancelled)
	}))
	defer server.Close()
	defer server.CloseClientConnections()
	t.Setenv("BEEFTV_BASE_URL", server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.Command(os.Args[0], "-test.run=^TestMCPProcessHelper$", "--", "mcp", "serve")
	cmd.Env = append(os.Environ(), "BEEFTV_TEST_PROCESS=1")
	client := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listed, err := session.ListTools(ctx, nil)
	if err != nil || len(listed.Tools) != 1 || listed.Tools[0].Name != "canvas.get" {
		t.Fatalf("unexpected tools: %+v, %v", listed, err)
	}
	callCtx, cancelCall := context.WithCancel(ctx)
	defer cancelCall()
	done := make(chan error, 1)
	go func() {
		_, err := session.CallTool(callCtx, &mcp.CallToolParams{Name: "canvas.get", Arguments: map[string]any{}})
		done <- err
	}()
	select {
	case <-requestStarted:
	case <-ctx.Done():
		t.Fatal("tool request never reached workspace")
	}
	cancelCall()
	select {
	case <-requestCancelled:
	case <-ctx.Done():
		t.Fatal("MCP cancellation did not cancel workspace HTTP request")
	}
	if err := <-done; err == nil {
		t.Fatal("cancelled tool call succeeded")
	}
}
