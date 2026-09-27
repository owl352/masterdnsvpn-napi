//go:build router

// Router flavor: an embedded sing-box instance in front of the MasterDnsVPN
// client, for TUN mode, a system proxy and direct/proxy/block rules. Built only
// with `-tags router` (the masterdnsvpn-node-router package); its dependencies
// come from native/router.mod via `go build -modfile`.
//
// The JS side generates the sing-box options. This file adds the parts that
// depend on the client: the "proxy" outbound pointing at the client's SOCKS5
// listener, and TUN route exclusions for the client's resolvers so the DNS
// tunnel's own packets do not loop back into the TUN.
package main

/*
#include <stdint.h>
#include <stdlib.h>

// Defined in napi.go.
extern void mdvRunDone(uintptr_t token, char* err);
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"runtime/debug"
	"sync"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter/certificate"
	"github.com/sagernet/sing-box/adapter/endpoint"
	"github.com/sagernet/sing-box/adapter/inbound"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/adapter/service"
	"github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/dns/transport"
	"github.com/sagernet/sing-box/dns/transport/fakeip"
	"github.com/sagernet/sing-box/dns/transport/hosts"
	"github.com/sagernet/sing-box/dns/transport/local"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/direct"
	"github.com/sagernet/sing-box/protocol/mixed"
	"github.com/sagernet/sing-box/protocol/socks"
	"github.com/sagernet/sing-box/protocol/tun"
	sjson "github.com/sagernet/sing/common/json"

	"masterdnsvpn-go/internal/config"
)

// proxyOutboundTag is the outbound the router adds for the MasterDnsVPN tunnel.
const proxyOutboundTag = "proxy"

type routerEntry struct {
	mu      sync.Mutex
	box     *box.Box
	cancel  context.CancelFunc
	logW    *os.File
	started bool
}

var (
	routersMu    sync.Mutex
	routers      = map[uint64]*routerEntry{}
	nextRouterID uint64
)

//export mdvRouterVersion
func mdvRouterVersion() *C.char {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/sagernet/sing-box" {
				return C.CString(dep.Version)
			}
		}
	}
	return C.CString("unknown")
}

// mdvRouterCreate builds (but does not start) a sing-box instance routing to
// the client with handle clientID. Returns the router id, or 0 with *errOut
// set. Log token handling matches mdvClientCreate.
//
//export mdvRouterCreate
func mdvRouterCreate(clientID C.uint64_t, optionsJSON *C.char, logToken C.uintptr_t, errOut **C.char) C.uint64_t {
	logW, err := newLogPipe(logToken)
	if err != nil {
		setErr(errOut, err)
		return 0
	}

	id, err := createRouter(uint64(clientID), []byte(C.GoString(optionsJSON)), logW)
	if err != nil {
		if logW != nil {
			logW.Close()
		}
		setErr(errOut, err)
		return 0
	}
	return C.uint64_t(id)
}

// mdvRouterStart starts sing-box on a goroutine and settles token when done.
//
//export mdvRouterStart
func mdvRouterStart(id C.uint64_t, token C.uintptr_t) *C.char {
	routersMu.Lock()
	entry := routers[uint64(id)]
	routersMu.Unlock()
	if entry == nil {
		return C.CString("router is closed")
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.started {
		return C.CString("router was already started; create a new router to start again")
	}
	entry.started = true

	go func() {
		var cerr *C.char
		if err := entry.box.Start(); err != nil {
			cerr = C.CString(err.Error())
		}
		C.mdvRunDone(token, cerr)
	}()
	return nil
}

// mdvRouterClose shuts sing-box down (restoring routes and the system proxy)
// on a goroutine and settles token when done. Closing twice is a no-op.
//
//export mdvRouterClose
func mdvRouterClose(id C.uint64_t, token C.uintptr_t) *C.char {
	routersMu.Lock()
	entry := routers[uint64(id)]
	delete(routers, uint64(id))
	routersMu.Unlock()

	go func() {
		var cerr *C.char
		if entry != nil {
			entry.mu.Lock()
			err := entry.box.Close()
			entry.cancel()
			if entry.logW != nil {
				entry.logW.Close()
			}
			entry.mu.Unlock()
			if err != nil {
				cerr = C.CString(err.Error())
			}
		}
		C.mdvRunDone(token, cerr)
	}()
	return nil
}

func createRouter(clientID uint64, raw []byte, logW *os.File) (uint64, error) {
	client := lookup(clientID)
	if client == nil {
		return 0, fmt.Errorf("client handle is closed")
	}
	client.mu.Lock()
	cfg := client.cfg
	client.mu.Unlock()

	if cfg.ProtocolType != "SOCKS5" {
		return 0, fmt.Errorf("the router needs a client with PROTOCOL_TYPE SOCKS5, got %s", cfg.ProtocolType)
	}

	raw, err := injectClientOptions(raw, cfg)
	if err != nil {
		return 0, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	ctx = routerContext(ctx)
	options, err := sjson.UnmarshalExtendedContext[option.Options](ctx, raw)
	if err != nil {
		cancel()
		return 0, fmt.Errorf("invalid router options: %w", err)
	}

	var instance *box.Box
	// sing-box logs to whatever os.Stderr is when its logger is created.
	withRedirected(&os.Stderr, logW, func() {
		instance, err = box.New(box.Options{Context: ctx, Options: options})
	})
	if err != nil {
		cancel()
		return 0, err
	}

	routersMu.Lock()
	defer routersMu.Unlock()
	nextRouterID++
	routers[nextRouterID] = &routerEntry{box: instance, cancel: cancel, logW: logW}
	return nextRouterID, nil
}

// routerContext registers only the sing-box protocols the router uses, which
// keeps the binary far smaller than a full sing-box build.
func routerContext(ctx context.Context) context.Context {
	inbounds := inbound.NewRegistry()
	tun.RegisterInbound(inbounds)
	mixed.RegisterInbound(inbounds)

	outbounds := outbound.NewRegistry()
	direct.RegisterOutbound(outbounds)
	socks.RegisterOutbound(outbounds)

	dnsTransports := dns.NewTransportRegistry()
	transport.RegisterTCP(dnsTransports)
	transport.RegisterUDP(dnsTransports)
	transport.RegisterTLS(dnsTransports)
	transport.RegisterHTTPS(dnsTransports)
	hosts.RegisterTransport(dnsTransports)
	local.RegisterTransport(dnsTransports)
	fakeip.RegisterTransport(dnsTransports)

	return box.Context(ctx, inbounds, outbounds, endpoint.NewRegistry(), dnsTransports, service.NewRegistry(), certificate.NewRegistry())
}

// injectClientOptions adds the "proxy" outbound for the client's SOCKS5
// listener and excludes the client's resolvers from TUN routes.
func injectClientOptions(raw []byte, cfg config.ClientConfig) ([]byte, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("invalid router options: %w", err)
	}

	outbounds, _ := doc["outbounds"].([]any)
	for _, item := range outbounds {
		if ob, ok := item.(map[string]any); ok && ob["tag"] == proxyOutboundTag {
			return nil, fmt.Errorf("outbound tag %q is reserved for the MasterDnsVPN tunnel", proxyOutboundTag)
		}
	}
	proxy := map[string]any{
		"type":        "socks",
		"tag":         proxyOutboundTag,
		"server":      dialableHost(cfg.ListenIP),
		"server_port": cfg.ListenPort,
		"version":     "5",
	}
	if cfg.SOCKS5Auth {
		proxy["username"] = cfg.SOCKS5User
		proxy["password"] = cfg.SOCKS5Pass
	}
	doc["outbounds"] = append(outbounds, proxy)

	inbounds, _ := doc["inbounds"].([]any)
	for _, item := range inbounds {
		ib, ok := item.(map[string]any)
		if !ok || ib["type"] != "tun" {
			continue
		}
		if err := checkTunAddress(ib["address"], cfg); err != nil {
			return nil, err
		}
		excludes, _ := ib["route_exclude_address"].([]any)
		ib["route_exclude_address"] = append(excludes, resolverPrefixes(cfg)...)
	}

	return json.Marshal(doc)
}

// checkTunAddress rejects TUN subnets that contain a resolver: packets to it
// would be routed into the TUN's own subnet despite the route exclusion, and
// the tunnel would feed itself until the process runs out of memory.
func checkTunAddress(raw any, cfg config.ClientConfig) error {
	var values []any
	switch v := raw.(type) {
	case []any:
		values = v
	case string:
		values = []any{v}
	}
	for _, value := range values {
		s, _ := value.(string)
		prefix, err := netip.ParsePrefix(s)
		if err != nil {
			continue
		}
		prefix = prefix.Masked()
		for _, resolver := range cfg.Resolvers {
			if addr, err := netip.ParseAddr(resolver.IP); err == nil && prefix.Contains(addr.Unmap()) {
				return fmt.Errorf("TUN address %s contains resolver %s; choose another tun.address", s, resolver.IP)
			}
		}
	}
	return nil
}

// dialableHost turns a wildcard listen address into a loopback one.
func dialableHost(listenIP string) string {
	switch listenIP {
	case "", "0.0.0.0":
		return "127.0.0.1"
	case "::", "[::]":
		return "::1"
	}
	return listenIP
}

func resolverPrefixes(cfg config.ClientConfig) []any {
	seen := make(map[netip.Addr]struct{}, len(cfg.Resolvers))
	prefixes := make([]any, 0, len(cfg.Resolvers))
	for _, resolver := range cfg.Resolvers {
		addr, err := netip.ParseAddr(resolver.IP)
		if err != nil {
			continue
		}
		addr = addr.Unmap()
		if _, dup := seen[addr]; dup {
			continue
		}
		seen[addr] = struct{}{}
		prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()).String())
	}
	return prefixes
}
