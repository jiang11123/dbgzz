package outbound

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestValidatedDialFallsBackFromStalledIPv6(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	stalledCancelled := make(chan struct{})
	client, server := net.Pipe()
	defer server.Close()
	conn, err := dialValidatedAddresses(ctx, "tcp", "443", []net.IP{
		net.ParseIP("2001:db8::1"), net.ParseIP("2001:db8::2"), net.ParseIP("192.0.2.1"),
	}, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "192.0.2.1:443" {
			return client, nil
		}
		if address != "[2001:db8::1]:443" {
			t.Errorf("second IPv6 dialed before the IPv4 fallback: %s", address)
		}
		<-ctx.Done()
		close(stalledCancelled)
		return nil, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case <-stalledCancelled:
	case <-time.After(time.Second):
		t.Fatal("losing dial was not cancelled")
	}
}

func TestValidatedDialTriesRemainingAddressesAndHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	want := errors.New("route unavailable")
	_, err := dialValidatedAddresses(ctx, "tcp", "443", []net.IP{net.ParseIP("192.0.2.1"), net.ParseIP("192.0.2.2")}, func(context.Context, string, string) (net.Conn, error) {
		return nil, want
	})
	if !errors.Is(err, want) {
		t.Fatalf("all-address failure = %v", err)
	}
	cancel()
	_, err = dialValidatedAddresses(ctx, "tcp", "443", []net.IP{net.ParseIP("192.0.2.1")}, func(ctx context.Context, _, _ string) (net.Conn, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled dial = %v", err)
	}
}
