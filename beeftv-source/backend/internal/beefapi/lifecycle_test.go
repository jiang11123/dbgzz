package beefapi

import (
	"context"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func awaitLifecycle(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("connection worker did not finish after shutdown")
	}
}

func TestCloseCancelsInFlightAuthorizationRequests(t *testing.T) {
	for _, endpoint := range []string{"/api/oauth/device/code", "/api/oauth/device/token", "/api/oauth/device/complete"} {
		t.Run(endpoint, func(t *testing.T) {
			svc, _, dir := testService(t, &fakeEnterprise{})
			original := svc.httpClient.Transport
			entered, exited := make(chan struct{}), make(chan struct{})
			var once sync.Once
			svc.httpClient.Transport = brandTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != endpoint {
					return original.RoundTrip(r)
				}
				once.Do(func() { close(entered) })
				<-r.Context().Done()
				close(exited)
				return nil, r.Context().Err()
			})
			startDone := make(chan struct{})
			go func() { defer close(startDone); _, _ = svc.Start(context.Background()) }()
			awaitLifecycle(t, entered)
			closed := make(chan struct{})
			go func() { svc.Close(); close(closed) }()
			awaitLifecycle(t, closed)
			awaitLifecycle(t, exited)
			awaitLifecycle(t, startDone)
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.Start(context.Background()); err == nil {
				t.Fatal("Start admitted after Close")
			}
			if err := svc.Recover(context.Background()); err == nil {
				t.Fatal("Recover admitted after Close")
			}
		})
	}
}

func TestCloseJoinsCatalogCallbackWithoutHoldingServiceMutex(t *testing.T) {
	svc, _, dir := testService(t, &fakeEnterprise{})
	entered, release, callbackDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	svc.fetchCatalog = func(string, string) ([]CatalogModel, error) {
		close(entered)
		<-release
		// A callback completing during Close must be able to acquire the service lock.
		_ = svc.Status()
		close(callbackDone)
		return nil, nil
	}
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitLifecycle(t, entered)
	closed := make(chan struct{})
	go func() { svc.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("Close returned while the admitted catalog callback was running")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	awaitLifecycle(t, closed)
	awaitLifecycle(t, callbackDone)
	if svc.Status().State == StateConnected {
		t.Fatal("cancelled catalog work reported connected")
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	// Close joins all disk work, so no worker may recreate the removed workspace.
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("workspace remains: %v", err)
	}
}

func TestCloseInterruptsProductionPollDelay(t *testing.T) {
	svc, _, _ := testService(t, &fakeEnterprise{mode: "pending"})
	svc.sleep = nil // Exercise the real timer, rather than the test's instant sleep.
	entered := make(chan struct{})
	var once sync.Once
	original := svc.httpClient.Transport
	svc.httpClient.Transport = brandTransport(func(r *http.Request) (*http.Response, error) {
		resp, err := original.RoundTrip(r)
		if r.URL.Path == "/api/oauth/device/token" {
			once.Do(func() { close(entered) })
		}
		return resp, err
	})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitLifecycle(t, entered)
	closed := make(chan struct{})
	go func() { svc.Close(); close(closed) }()
	awaitLifecycle(t, closed)
}

func TestCloseJoinsRecoveredConnectionVerification(t *testing.T) {
	svc, _, _ := testService(t, &fakeEnterprise{})
	if _, err := svc.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, svc, StateConnected)
	entered, exited := make(chan struct{}), make(chan struct{})
	svc.httpClient.Transport = brandTransport(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		close(exited)
		return nil, r.Context().Err()
	})
	if err := svc.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitLifecycle(t, entered)
	closed := make(chan struct{})
	go func() { svc.Close(); close(closed) }()
	awaitLifecycle(t, closed)
	awaitLifecycle(t, exited)
	if svc.Status().State != StateConnected {
		t.Fatal("shutdown verification changed saved connection")
	}
}

func TestConcurrentStartRecoverAndCloseNeverAdmitsAfterShutdown(t *testing.T) {
	svc, _, _ := testService(t, &fakeEnterprise{})
	var requests atomic.Int32
	svc.httpClient.Transport = brandTransport(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	var callers sync.WaitGroup
	for i := 0; i < 40; i++ {
		callers.Add(1)
		go func() {
			defer callers.Done()
			_, _ = svc.Start(context.Background())
			_ = svc.Recover(context.Background())
		}()
	}
	svc.Close()
	callers.Wait()
	before := requests.Load()
	for i := 0; i < 10; i++ {
		if _, err := svc.Start(context.Background()); err == nil {
			t.Fatal("Start admitted after shutdown")
		}
		if err := svc.Recover(context.Background()); err == nil {
			t.Fatal("Recover admitted after shutdown")
		}
		svc.Close()
	}
	if requests.Load() != before {
		t.Fatal("network requests started after shutdown")
	}
}
