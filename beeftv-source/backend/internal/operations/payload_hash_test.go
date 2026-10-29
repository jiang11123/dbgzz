package operations

import (
	"bytes"
	"testing"
)

func TestCanonicalJSONIgnoresObjectKeyOrder(t *testing.T) {
	goSorted := []byte(`{"canvasId":"c","nodeId":"n","outputIndex":0,"taskId":"t"}`)
	jsInsert := []byte(`{"canvasId":"c","taskId":"t","nodeId":"n","outputIndex":0}`)
	pretty := []byte(`{
  "canvasId": "c",
  "taskId": "t",
  "nodeId": "n",
  "outputIndex": 0
}`)
	canonical := CanonicalJSON(jsInsert)
	if !bytes.Equal(canonical, goSorted) {
		t.Fatalf("canonical = %s", canonical)
	}
	if !bytes.Equal(CanonicalJSON(pretty), goSorted) {
		t.Fatalf("pretty canonical = %s", CanonicalJSON(pretty))
	}
	if PayloadHash("canvas.task.bind", CanonicalJSON(jsInsert)) != PayloadHash("canvas.task.bind", CanonicalJSON(goSorted)) {
		t.Fatal("canonical hashes diverged")
	}
	if PayloadHash("canvas.task.bind", jsInsert) == PayloadHash("canvas.task.bind", goSorted) {
		t.Fatal("raw JS insertion order must stay a distinct hash")
	}
}

func TestCanonicalJSONPreservesSemanticDifference(t *testing.T) {
	left := CanonicalJSON([]byte(`{"canvasId":"a","taskId":"t","nodeId":"n","outputIndex":0}`))
	right := CanonicalJSON([]byte(`{"taskId":"t","nodeId":"n","outputIndex":0,"canvasId":"b"}`))
	if bytes.Equal(left, right) {
		t.Fatal("different canvasId became the same canonical payload")
	}
}

func TestCanonicalJSONEmptyAndInvalid(t *testing.T) {
	if got := string(CanonicalJSON(nil)); got != "{}" {
		t.Fatalf("nil canonical = %q", got)
	}
	if got := string(CanonicalJSON([]byte("  "))); got != "{}" {
		t.Fatalf("whitespace canonical = %q", got)
	}
	invalid := []byte(`{"canvasId":`)
	if !bytes.Equal(CanonicalJSON(invalid), invalid) {
		t.Fatal("invalid JSON must keep original bytes")
	}
}

func TestCanonicalJSONKeepsIntegerPrecision(t *testing.T) {
	left := CanonicalJSON([]byte(`{"outputIndex":9007199254740992}`))
	right := CanonicalJSON([]byte(`{"outputIndex":9007199254740993}`))
	if string(left) != `{"outputIndex":9007199254740992}` {
		t.Fatalf("left = %s", left)
	}
	if string(right) != `{"outputIndex":9007199254740993}` {
		t.Fatalf("right = %s", right)
	}
	if bytes.Equal(left, right) {
		t.Fatal("integers above float64 exactness must not share a canonical payload")
	}
	if PayloadHash("canvas.task.bind", left) == PayloadHash("canvas.task.bind", right) {
		t.Fatal("large integer payloads must not share a hash")
	}
}

func TestCanonicalJSONSortsNestedObjectKeys(t *testing.T) {
	input := []byte(`{"z":{"b":1,"a":2},"a":0}`)
	want := []byte(`{"a":0,"z":{"a":2,"b":1}}`)
	if got := CanonicalJSON(input); !bytes.Equal(got, want) {
		t.Fatalf("canonical = %s", got)
	}
}

func TestCanonicalJSONKeepsInvalidAndTrailingBytes(t *testing.T) {
	for _, payload := range [][]byte{
		[]byte(`{"canvasId":`),
		[]byte(`{"canvasId":"c"}{"canvasId":"d"}`),
		[]byte(`{"canvasId":"c"}  {"x":1}`),
		[]byte(`{"canvasId":"c"} true`),
	} {
		if got := CanonicalJSON(payload); !bytes.Equal(got, payload) {
			t.Fatalf("payload %s canonicalized to %s", payload, got)
		}
	}
}

func TestPayloadHashAcceptedMatchesCanonicalOrRaw(t *testing.T) {
	op := "canvas.task.bind"
	js := []byte(`{"canvasId":"c","taskId":"t","nodeId":"n","outputIndex":0}`)
	canonical := PayloadHash(op, CanonicalJSON(js))
	raw := PayloadHash(op, js)
	if canonical == raw {
		t.Fatal("fixture must keep raw JS order different from canonical")
	}
	req := RunRequest{PayloadHash: canonical, AlternatePayloadHash: raw}
	if !payloadHashAccepted(canonical, req) {
		t.Fatal("stored canonical hash must match")
	}
	if !payloadHashAccepted(raw, req) {
		t.Fatal("stored raw JS hash must match via alternate")
	}
	other := PayloadHash(op, CanonicalJSON([]byte(`{"canvasId":"other","nodeId":"n","outputIndex":0,"taskId":"t"}`)))
	if payloadHashAccepted(other, req) {
		t.Fatal("different canvasId must not match")
	}
}
