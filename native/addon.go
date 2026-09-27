// Node-API addon for the MasterDnsVPN client.
//
// This package is not built from here: build.cjs injects it into the
// MasterDnsVPN module tree (as masterdnsvpn-go/napibind) with `go build -overlay`,
// which is what allows it to import the upstream internal/ packages.
//
// The Node-API glue lives in napi.go. This file only holds the Go side: a
// handle table of bootstrapped clients and the functions the glue calls.
package main

/*
#include <stdint.h>
#include <stdlib.h>

// Defined in napi.go.
extern void mdvRunDone(uintptr_t token, char* err);
extern void mdvLogLine(uintptr_t token, char* line);
extern void mdvLogClose(uintptr_t token);
*/
import "C"

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"
	"unsafe"

	"masterdnsvpn-go/internal/client"
	"masterdnsvpn-go/internal/config"
	"masterdnsvpn-go/internal/version"
)

type createOptions struct {
	ConfigPath    string          `json:"configPath"`
	Config        json.RawMessage `json:"config"`
	ResolversPath string          `json:"resolversPath"`
	Resolvers     []string        `json:"resolvers"`
	LogPath       string          `json:"logPath"`
	Overrides     map[string]any  `json:"overrides"`
}

type clientInfo struct {
	Version       string   `json:"version"`
	ConfigPath    string   `json:"configPath"`
	ResolversPath string   `json:"resolversPath"`
	Protocol      string   `json:"protocol"`
	ListenIP      string   `json:"listenIP"`
	ListenPort    int      `json:"listenPort"`
	Domains       []string `json:"domains"`
	Resolvers     int      `json:"resolvers"`
	LogLevel      string   `json:"logLevel"`
	Running       bool     `json:"running"`
}

type clientStatus struct {
	Running           bool  `json:"running"`
	SessionReady      bool  `json:"sessionReady"`
	SessionID         uint8 `json:"sessionId"`
	ActiveConnections int   `json:"activeConnections"`
	TotalConnections  int   `json:"totalConnections"`
}

type connectionInfo struct {
	Key               string   `json:"key"`
	Domain            string   `json:"domain"`
	Resolver          string   `json:"resolver"`
	ResolverPort      int      `json:"resolverPort"`
	ResolverLabel     string   `json:"resolverLabel"`
	Valid             bool     `json:"valid"`
	UploadMTUBytes    int      `json:"uploadMtuBytes"`
	UploadMTUChars    int      `json:"uploadMtuChars"`
	DownloadMTUBytes  int      `json:"downloadMtuBytes"`
	MTUResolveTimeMs  float64  `json:"mtuResolveTimeMs"`
	LastHealthCheckAt *int64   `json:"lastHealthCheckAt"`
	AverageRTTMs      *float64 `json:"averageRttMs"`
}

type resolverAddress struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
}

type loadedConfig struct {
	Config        map[string]any    `json:"config"`
	ConfigPath    string            `json:"configPath"`
	ResolversPath string            `json:"resolversPath"`
	Resolvers     []resolverAddress `json:"resolvers"`
}

type clientEntry struct {
	mu      sync.Mutex
	app     *client.Client
	cfg     config.ClientConfig
	logW    *os.File
	started bool
	running bool
	cancel  context.CancelFunc
}

var (
	registryMu sync.Mutex
	registry   = map[uint64]*clientEntry{}
	nextID     uint64

	// The upstream logger (and sing-box's, in the router build) writes to
	// whatever os.Stdout/os.Stderr is when it is created, so log capture swaps
	// them for a pipe around construction.
	stdioMu sync.Mutex
)

func lookup(id uint64) *clientEntry {
	registryMu.Lock()
	defer registryMu.Unlock()
	return registry[id]
}

// setErr hands an error message to C. The caller frees it.
func setErr(errOut **C.char, err error) {
	if errOut != nil {
		*errOut = C.CString(err.Error())
	}
}

func jsonResult(v any, errOut **C.char) *C.char {
	raw, err := json.Marshal(v)
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	return C.CString(string(raw))
}

//export mdvFree
func mdvFree(p *C.char) {
	C.free(unsafe.Pointer(p))
}

//export mdvVersion
func mdvVersion() *C.char {
	return C.CString(version.GetVersion())
}

// mdvLoadConfig loads and validates a config without creating a client, and
// returns the effective config as JSON, or nil with *errOut set.
//
//export mdvLoadConfig
func mdvLoadConfig(optionsJSON *C.char, errOut **C.char) *C.char {
	opts, err := parseOptions(C.GoString(optionsJSON))
	if err != nil {
		setErr(errOut, err)
		return nil
	}
	cfg, err := loadConfig(opts)
	if err != nil {
		setErr(errOut, err)
		return nil
	}

	resolvers := make([]resolverAddress, len(cfg.Resolvers))
	for i, r := range cfg.Resolvers {
		resolvers[i] = resolverAddress{IP: r.IP, Port: r.Port}
	}
	resolversPath := cfg.ResolversPath()
	if len(opts.Resolvers) > 0 {
		resolversPath = ""
	}
	return jsonResult(loadedConfig{
		Config:        tomlValues(cfg),
		ConfigPath:    cfg.ConfigPath,
		ResolversPath: resolversPath,
		Resolvers:     resolvers,
	}, errOut)
}

// mdvClientCreate loads the config and bootstraps a client. It returns the new
// handle id, or 0 with *errOut set. When logToken is non-zero, log lines are
// delivered through mdvLogLine instead of stdout, and mdvLogClose is always
// called exactly once for the token (on failure or when the client is destroyed).
//
//export mdvClientCreate
func mdvClientCreate(optionsJSON *C.char, logToken C.uintptr_t, errOut **C.char) C.uint64_t {
	logW, err := newLogPipe(logToken)
	if err != nil {
		setErr(errOut, err)
		return 0
	}

	id, err := createClient(C.GoString(optionsJSON), logW)
	if err != nil {
		if logW != nil {
			logW.Close()
		}
		setErr(errOut, err)
		return 0
	}
	return C.uint64_t(id)
}

// mdvClientStart runs the client on its own goroutine and returns nil, or an
// error message when it cannot be started. When Run returns, mdvRunDone is
// called with token and the run error (nil on a clean stop).
//
//export mdvClientStart
func mdvClientStart(id C.uint64_t, token C.uintptr_t) *C.char {
	entry := lookup(uint64(id))
	if entry == nil {
		return C.CString("client handle is closed")
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.started {
		return C.CString("client was already started; create a new client to run again")
	}

	ctx, cancel := context.WithCancel(context.Background())
	entry.started = true
	entry.running = true
	entry.cancel = cancel

	entry.app.PrintBanner()
	go func() {
		err := runClient(ctx, entry.app)

		entry.mu.Lock()
		entry.running = false
		entry.mu.Unlock()
		cancel()

		var cerr *C.char
		if err != nil {
			cerr = C.CString(err.Error())
		}
		C.mdvRunDone(token, cerr)
	}()
	return nil
}

// mdvClientStop cancels a running client. It returns 1 if the client was
// running. Completion is reported through the promise from mdvClientStart.
//
//export mdvClientStop
func mdvClientStop(id C.uint64_t) C.int {
	entry := lookup(uint64(id))
	if entry == nil {
		return 0
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if !entry.running {
		return 0
	}
	entry.cancel()
	return 1
}

// mdvClientDestroy stops the client if needed, ends log forwarding and drops
// the handle.
//
//export mdvClientDestroy
func mdvClientDestroy(id C.uint64_t) {
	registryMu.Lock()
	entry := registry[uint64(id)]
	delete(registry, uint64(id))
	registryMu.Unlock()

	if entry == nil {
		return
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.cancel != nil {
		entry.cancel()
	}
	if entry.logW != nil {
		entry.logW.Close()
		entry.logW = nil
	}
}

// mdvClientInfo returns a JSON description of the client, or nil with *errOut set.
//
//export mdvClientInfo
func mdvClientInfo(id C.uint64_t, errOut **C.char) *C.char {
	entry := lookup(uint64(id))
	if entry == nil {
		setErr(errOut, fmt.Errorf("client handle is closed"))
		return nil
	}

	entry.mu.Lock()
	cfg := entry.cfg
	running := entry.running
	entry.mu.Unlock()

	return jsonResult(clientInfo{
		Version:       version.GetVersion(),
		ConfigPath:    cfg.ConfigPath,
		ResolversPath: cfg.ResolversPath(),
		Protocol:      cfg.ProtocolType,
		ListenIP:      cfg.ListenIP,
		ListenPort:    cfg.ListenPort,
		Domains:       cfg.Domains,
		Resolvers:     len(cfg.Resolvers),
		LogLevel:      cfg.LogLevel,
		Running:       running,
	}, errOut)
}

// mdvClientStatus returns the runtime state as JSON, or nil with *errOut set.
//
//export mdvClientStatus
func mdvClientStatus(id C.uint64_t, errOut **C.char) *C.char {
	entry := lookup(uint64(id))
	if entry == nil {
		setErr(errOut, fmt.Errorf("client handle is closed"))
		return nil
	}

	entry.mu.Lock()
	running := entry.running
	entry.mu.Unlock()

	app := entry.app
	balancer := app.Balancer()
	return jsonResult(clientStatus{
		Running:           running,
		SessionReady:      running && app.SessionReady(),
		SessionID:         app.SessionID(),
		ActiveConnections: balancer.ActiveCount(),
		TotalConnections:  balancer.TotalCount(),
	}, errOut)
}

// mdvClientConnections returns every domain/resolver pair with its MTU and
// health state as JSON, or nil with *errOut set.
//
//export mdvClientConnections
func mdvClientConnections(id C.uint64_t, errOut **C.char) *C.char {
	entry := lookup(uint64(id))
	if entry == nil {
		setErr(errOut, fmt.Errorf("client handle is closed"))
		return nil
	}

	balancer := entry.app.Balancer()
	conns := balancer.AllConnections()
	result := make([]connectionInfo, len(conns))
	for i, conn := range conns {
		info := connectionInfo{
			Key:              conn.Key,
			Domain:           conn.Domain,
			Resolver:         conn.Resolver,
			ResolverPort:     conn.ResolverPort,
			ResolverLabel:    conn.ResolverLabel,
			Valid:            conn.IsValid,
			UploadMTUBytes:   conn.UploadMTUBytes,
			UploadMTUChars:   conn.UploadMTUChars,
			DownloadMTUBytes: conn.DownloadMTUBytes,
			MTUResolveTimeMs: durationMs(conn.MTUResolveTime),
		}
		if !conn.LastHealthCheckAt.IsZero() {
			at := conn.LastHealthCheckAt.UnixMilli()
			info.LastHealthCheckAt = &at
		}
		if rtt, ok := balancer.AverageRTT(conn.Key); ok {
			ms := durationMs(rtt)
			info.AverageRTTMs = &ms
		}
		result[i] = info
	}
	return jsonResult(result, errOut)
}

func durationMs(d time.Duration) float64 {
	return float64(d) / float64(time.Millisecond)
}

func parseOptions(optionsJSON string) (createOptions, error) {
	var opts createOptions
	if err := json.Unmarshal([]byte(optionsJSON), &opts); err != nil {
		return opts, fmt.Errorf("invalid client options: %w", err)
	}
	return opts, nil
}

func loadConfig(opts createOptions) (config.ClientConfig, error) {
	overrides := config.ClientConfigOverrides{}
	switch {
	case len(opts.Resolvers) > 0 && opts.ResolversPath != "":
		return config.ClientConfig{}, fmt.Errorf("only one of resolversPath and resolvers can be used")
	case len(opts.Resolvers) > 0:
		// Upstream only reads resolvers from a file; the file is only needed
		// while the config loads.
		path, err := writeTempResolvers(opts.Resolvers)
		if err != nil {
			return config.ClientConfig{}, err
		}
		defer os.Remove(path)
		overrides.ResolversFilePath = &path
	case opts.ResolversPath != "":
		resolversPath := opts.ResolversPath
		overrides.ResolversFilePath = &resolversPath
	}

	values, err := coerceOverrides(opts.Overrides)
	if err != nil {
		return config.ClientConfig{}, err
	}
	overrides.Values = values

	switch {
	case len(opts.Config) > 0 && opts.ConfigPath != "":
		return config.ClientConfig{}, fmt.Errorf("only one of configPath and config can be used")
	case len(opts.Config) > 0:
		encoded := base64.StdEncoding.EncodeToString(opts.Config)
		return config.LoadClientConfigFromJSONBase64WithOverrides(encoded, overrides)
	case opts.ConfigPath != "":
		return config.LoadClientConfigWithOverrides(opts.ConfigPath, overrides)
	default:
		return config.ClientConfig{}, fmt.Errorf("one of configPath or config is required")
	}
}

func writeTempResolvers(resolvers []string) (string, error) {
	f, err := os.CreateTemp("", "masterdnsvpn-resolvers-*.txt")
	if err != nil {
		return "", err
	}
	_, err = f.WriteString(strings.Join(resolvers, "\n") + "\n")
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

func createClient(optionsJSON string, logW *os.File) (uint64, error) {
	opts, err := parseOptions(optionsJSON)
	if err != nil {
		return 0, err
	}
	cfg, err := loadConfig(opts)
	if err != nil {
		return 0, err
	}

	app, err := bootstrap(cfg, opts.LogPath, logW)
	if err != nil {
		return 0, err
	}

	registryMu.Lock()
	defer registryMu.Unlock()
	nextID++
	registry[nextID] = &clientEntry{app: app, cfg: cfg, logW: logW}
	return nextID, nil
}

// bootstrap creates the client, pointing its logger at logW when set.
func bootstrap(cfg config.ClientConfig, logPath string, logW *os.File) (app *client.Client, err error) {
	withRedirected(&os.Stdout, logW, func() {
		app, err = client.BootstrapLoadedConfig(cfg, logPath)
	})
	return app, err
}

// withRedirected runs fn with *stream (os.Stdout or os.Stderr) set to w, or
// just runs fn when w is nil.
func withRedirected(stream **os.File, w *os.File, fn func()) {
	if w == nil {
		fn()
		return
	}
	stdioMu.Lock()
	defer stdioMu.Unlock()
	saved := *stream
	*stream = w
	defer func() { *stream = saved }()
	fn()
}

// newLogPipe returns the write end of a pipe whose lines are forwarded to the
// JS callback behind token, or nil when token is 0. mdvLogClose is called for
// the token once the write end is closed (or right away on error).
func newLogPipe(token C.uintptr_t) (*os.File, error) {
	if token == 0 {
		return nil, nil
	}
	r, w, err := os.Pipe()
	if err != nil {
		C.mdvLogClose(token)
		return nil, err
	}
	go forwardLogs(r, token)
	return w, nil
}

// forwardLogs sends each line written to r to JS until the write end closes.
func forwardLogs(r *os.File, token C.uintptr_t) {
	defer C.mdvLogClose(token)
	defer r.Close()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		C.mdvLogLine(token, C.CString(scanner.Text()))
	}
}

// runClient runs the client until ctx is cancelled. A panic on this goroutine
// is turned into an error instead of taking the Node process down.
func runClient(ctx context.Context, app *client.Client) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("client panicked: %v", r)
		}
	}()
	return app.Run(ctx)
}

// tomlValues returns the config fields keyed by their TOML names.
func tomlValues(cfg config.ClientConfig) map[string]any {
	value := reflect.ValueOf(cfg)
	typ := value.Type()
	out := make(map[string]any, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		tag := field.Tag.Get("toml")
		if !field.IsExported() || tag == "" || tag == "-" {
			continue
		}
		out[tag] = value.Field(i).Interface()
	}
	return out
}

// coerceOverrides converts JSON-decoded override values to the exact Go types
// config.applyClientConfigOverrideValues expects (int, float64, []string),
// using the ClientConfig field types. Unknown fields are passed through so
// upstream reports them.
func coerceOverrides(values map[string]any) (map[string]any, error) {
	if len(values) == 0 {
		return nil, nil
	}

	cfgType := reflect.TypeOf(config.ClientConfig{})
	out := make(map[string]any, len(values))
	for name, raw := range values {
		field, ok := cfgType.FieldByName(name)
		if !ok {
			out[name] = raw
			continue
		}

		switch field.Type.Kind() {
		case reflect.Int:
			f, ok := raw.(float64)
			if !ok || f != math.Trunc(f) {
				return nil, fmt.Errorf("invalid int override for %s", name)
			}
			out[name] = int(f)
		case reflect.Slice:
			items, ok := raw.([]any)
			if !ok || field.Type.Elem().Kind() != reflect.String {
				out[name] = raw
				continue
			}
			strs := make([]string, len(items))
			for i, item := range items {
				s, ok := item.(string)
				if !ok {
					return nil, fmt.Errorf("invalid string slice override for %s", name)
				}
				strs[i] = s
			}
			out[name] = strs
		default:
			out[name] = raw
		}
	}
	return out, nil
}

func main() {}
