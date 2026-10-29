package handler

import (
	"net/http"
	"testing"
	"time"
)

func TestAssistantUISessionExpiryAndOwner(t *testing.T) {
	now := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	store := newUISessionStore()
	store.now = func() time.Time { return now }
	issued := store.issue("owner")
	if _, ok := store.verify(issued.Token, "other"); ok {
		t.Fatal("session accepted for another owner")
	}
	now = issued.ExpiresAt.Add(-time.Nanosecond)
	if _, ok := store.verify(issued.Token, "owner"); !ok {
		t.Fatal("session expired early")
	}
	now = issued.ExpiresAt
	if _, ok := store.verify(issued.Token, "owner"); ok {
		t.Fatal("session accepted at expiry")
	}
	renewed := store.issue("owner")
	if renewed.Token == issued.Token {
		t.Fatal("renewal reused expired token")
	}
	if _, ok := store.verify(renewed.Token, "owner"); !ok {
		t.Fatal("renewed session rejected")
	}
}

func TestAssistantAdmissionRejectionAndHostFailure(t *testing.T) {
	chatHits := 0
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/chat" {
				chatHits++
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"reason":"unauthenticated"}`))
				return
			}
			_, _ = w.Write([]byte(`{"turns":[]}`))
		})
	})
	body := `{"canvasId":"` + env.canvasID + `","message":"hello"}`
	rejected := env.callWithHeaders(t, http.MethodPost, "/assistant/chat", body, map[string]string{"X-Beeftv-Ui-Session": "expired"})
	if rejected.Code != http.StatusForbidden || rejected.Header().Get("X-Beeftv-Turn-Admission") != "rejected" || chatHits != 0 {
		t.Fatalf("authentication rejection incorrectly admitted: %d %v hits=%d", rejected.Code, rejected.Header(), chatHits)
	}
	forwarded := env.call(t, http.MethodPost, "/assistant/chat", body)
	if forwarded.Code != http.StatusForbidden || forwarded.Header().Get("X-Beeftv-Turn-Admission") != "admitted" || chatHits != 1 {
		t.Fatalf("post-admission host failure lost uncertainty: %d %v hits=%d", forwarded.Code, forwarded.Header(), chatHits)
	}
}

func TestAssistantInvalidSkillIsNotAdmitted(t *testing.T) {
	hits := 0
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; _, _ = w.Write([]byte(`{}`)) })
	})
	body := `{"canvasId":"` + env.canvasID + `","message":"hello","skills":[{"skillId":"missing","versionId":"v1","contentHash":"bad"}]}`
	response := env.call(t, http.MethodPost, "/assistant/chat", body)
	if response.Code != 400 || response.Header().Get("X-Beeftv-Turn-Admission") != "rejected" || hits != 0 {
		t.Fatalf("invalid skill left an unknown turn: %d %v hits=%d", response.Code, response.Header(), hits)
	}
}

func TestAssistantHostBodyRejectionIsNotAdmitted(t *testing.T) {
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			_, _ = w.Write([]byte(`{"reason":"body_too_large"}`))
		})
	})
	response := env.call(t, http.MethodPost, "/assistant/chat", `{"canvasId":"`+env.canvasID+`","message":"hello"}`)
	if response.Code != 413 || response.Header().Get("X-Beeftv-Turn-Admission") != "rejected" {
		t.Fatalf("body rejection: %d %v", response.Code, response.Header())
	}
}

func TestAssistantSnapshotFailureIsRejectedAndCanRetry(t *testing.T) {
	hits := 0
	env := newAssistantTestEnv(t, func(env *assistantTestEnv) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits++
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"reason":"unauthenticated"}`))
		})
	})
	db := env.service.Database()
	if err := db.Exec(`CREATE TRIGGER reject_turn BEFORE INSERT ON assistant_turns BEGIN SELECT RAISE(ABORT, 'test write failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	body := `{"canvasId":"` + env.canvasID + `","message":"hello"}`
	response := env.call(t, http.MethodPost, "/assistant/chat", body)
	if response.Code < 400 || response.Header().Get("X-Beeftv-Turn-Admission") != "rejected" || hits != 0 {
		t.Fatalf("snapshot failure left recovery pending: %d %v hits=%d", response.Code, response.Header(), hits)
	}
	if err := db.Exec(`DROP TRIGGER reject_turn`).Error; err != nil {
		t.Fatal(err)
	}
	response = env.call(t, http.MethodPost, "/assistant/chat", body)
	if response.Header().Get("X-Beeftv-Turn-Admission") != "admitted" || hits != 1 {
		t.Fatalf("retry not admitted: %d %v hits=%d", response.Code, response.Header(), hits)
	}
}
