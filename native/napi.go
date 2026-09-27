package main

// Node-API glue. The C code lives in this preamble rather than in addon.go
// because cgo only allows definitions in files without //export directives.
// node_api.h comes from the node-api-headers package; build.cjs puts it on
// CGO_CFLAGS. Node-API symbols resolve against the host node process at load
// time (dynamic_lookup on macOS, an import library for node.exe on Windows).
//
// The mdv_* helpers are not static so the router glue (router_napi.go, only
// in the router build) can use them; it declares their prototypes itself.

/*
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define NAPI_VERSION 8
#include <node_api.h>

// Implemented in addon.go.
extern void mdvFree(char* p);
extern char* mdvVersion(void);
extern char* mdvLoadConfig(char* optionsJSON, char** errOut);
extern uint64_t mdvClientCreate(char* optionsJSON, uintptr_t logToken, char** errOut);
extern char* mdvClientStart(uint64_t id, uintptr_t token);
extern int mdvClientStop(uint64_t id);
extern void mdvClientDestroy(uint64_t id);
extern char* mdvClientInfo(uint64_t id, char** errOut);
extern char* mdvClientStatus(uint64_t id, char** errOut);
extern char* mdvClientConnections(uint64_t id, char** errOut);

// Defined in router_napi.go (router build) or router_stub.go (core build).
extern void mdv_register_router(napi_env env, napi_value exports);

#define MDV_CHECK(env, call)                                     \
	do {                                                         \
		if ((call) != napi_ok) {                                 \
			mdv_throw_last_error(env);                           \
			return NULL;                                         \
		}                                                        \
	} while (0)

void mdv_throw_last_error(napi_env env) {
	bool pending = false;
	napi_is_exception_pending(env, &pending);
	if (pending) {
		return;
	}
	const napi_extended_error_info* info = NULL;
	napi_get_last_error_info(env, &info);
	napi_throw_error(env, NULL, info && info->error_message ? info->error_message : "Node-API call failed");
}

// Throws msg as a JS Error and frees it (it was allocated by Go).
napi_value mdv_throw_owned(napi_env env, char* msg) {
	napi_throw_error(env, NULL, msg);
	mdvFree(msg);
	return NULL;
}

napi_value mdv_string_owned(napi_env env, char* s) {
	napi_value result = NULL;
	napi_status status = napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &result);
	mdvFree(s);
	if (status != napi_ok) {
		mdv_throw_last_error(env);
		return NULL;
	}
	return result;
}

// Reads the first `count` arguments of the current call, throwing if fewer were passed.
bool mdv_args(napi_env env, napi_callback_info info, size_t count, napi_value* argv) {
	size_t argc = count;
	if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
		mdv_throw_last_error(env);
		return false;
	}
	if (argc < count) {
		napi_throw_type_error(env, NULL, "missing arguments");
		return false;
	}
	return true;
}

char* mdv_get_string(napi_env env, napi_value value) {
	size_t len = 0;
	if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) {
		napi_throw_type_error(env, NULL, "expected a string argument");
		return NULL;
	}
	char* buf = malloc(len + 1);
	napi_get_value_string_utf8(env, value, buf, len + 1, &len);
	return buf;
}

bool mdv_get_id(napi_env env, napi_value value, uint64_t* id) {
	double d = 0;
	if (napi_get_value_double(env, value, &d) != napi_ok || d < 1) {
		napi_throw_type_error(env, NULL, "expected a handle");
		return false;
	}
	*id = (uint64_t)d;
	return true;
}

static napi_value mdv_version(napi_env env, napi_callback_info info) {
	return mdv_string_owned(env, mdvVersion());
}

// loadConfig(optionsJson: string): string (JSON)
static napi_value mdv_load_config(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	if (!mdv_args(env, info, 1, argv)) return NULL;
	char* options = mdv_get_string(env, argv[0]);
	if (options == NULL) return NULL;

	char* err = NULL;
	char* json = mdvLoadConfig(options, &err);
	free(options);
	if (err != NULL) return mdv_throw_owned(env, err);
	return mdv_string_owned(env, json);
}

// Runs on the JS thread for each captured log line; calls onLog(line).
static void mdv_log_js(napi_env env, napi_value js_cb, void* context, void* data) {
	char* line = data;
	if (env != NULL && js_cb != NULL) {
		napi_value undefined, arg;
		napi_get_undefined(env, &undefined);
		if (napi_create_string_utf8(env, line, NAPI_AUTO_LENGTH, &arg) == napi_ok) {
			napi_call_function(env, undefined, js_cb, 1, &arg, NULL);
		}
	}
	mdvFree(line);
}

// Called from the Go log forwarding goroutine (any thread).
void mdvLogLine(uintptr_t token, char* line) {
	if (napi_call_threadsafe_function((napi_threadsafe_function)token, line, napi_tsfn_blocking) != napi_ok) {
		mdvFree(line);
	}
}

void mdvLogClose(uintptr_t token) {
	napi_release_threadsafe_function((napi_threadsafe_function)token, napi_tsfn_release);
}

// Turns an optional onLog argument into a threadsafe function for mdvLogLine.
// Sets *out to NULL for undefined/null. Returns false with an exception pending
// if the value is not a function.
bool mdv_create_log_tsfn(napi_env env, napi_value fn, napi_threadsafe_function* out) {
	*out = NULL;
	napi_valuetype type;
	if (napi_typeof(env, fn, &type) != napi_ok) {
		mdv_throw_last_error(env);
		return false;
	}
	if (type == napi_undefined || type == napi_null) return true;
	if (type != napi_function) {
		napi_throw_type_error(env, NULL, "onLog must be a function");
		return false;
	}
	napi_value name;
	if (napi_create_string_utf8(env, "masterdnsvpn:log", NAPI_AUTO_LENGTH, &name) != napi_ok ||
		napi_create_threadsafe_function(env, fn, NULL, name, 0, 1, NULL, NULL, NULL, mdv_log_js, out) != napi_ok) {
		mdv_throw_last_error(env);
		return false;
	}
	// Logging alone must not keep the process alive; running work does.
	napi_unref_threadsafe_function(env, *out);
	return true;
}

// clientCreate(optionsJson: string, onLog?: (line: string) => void): number
// With onLog, log lines go to the callback instead of stdout.
static napi_value mdv_client_create(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	MDV_CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
	if (argc < 1) {
		napi_throw_type_error(env, NULL, "missing arguments");
		return NULL;
	}

	napi_threadsafe_function log_tsfn = NULL;
	if (argc > 1 && !mdv_create_log_tsfn(env, argv[1], &log_tsfn)) return NULL;

	char* options = mdv_get_string(env, argv[0]);
	if (options == NULL) {
		if (log_tsfn != NULL) napi_release_threadsafe_function(log_tsfn, napi_tsfn_release);
		return NULL;
	}

	// From here on Go owns log_tsfn and releases it through mdvLogClose.
	char* err = NULL;
	uint64_t id = mdvClientCreate(options, (uintptr_t)log_tsfn, &err);
	free(options);
	if (err != NULL) return mdv_throw_owned(env, err);

	napi_value result;
	MDV_CHECK(env, napi_create_double(env, (double)id, &result));
	return result;
}

typedef struct {
	napi_deferred deferred;
	napi_threadsafe_function tsfn;
} mdv_run_ctx;

// Runs on the JS thread once the Go run goroutine reports completion.
static void mdv_run_done_js(napi_env env, napi_value js_cb, void* context, void* data) {
	mdv_run_ctx* ctx = context;
	char* err = data;

	if (env != NULL) {
		if (err != NULL) {
			napi_value msg, error;
			napi_create_string_utf8(env, err, NAPI_AUTO_LENGTH, &msg);
			napi_create_error(env, NULL, msg, &error);
			napi_reject_deferred(env, ctx->deferred, error);
		} else {
			napi_value undefined;
			napi_get_undefined(env, &undefined);
			napi_resolve_deferred(env, ctx->deferred, undefined);
		}
	}

	if (err != NULL) mdvFree(err);
	napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);
	free(ctx);
}

// Called from a Go goroutine (any thread) to settle a promise from mdv_async_begin.
void mdvRunDone(uintptr_t token, char* err) {
	mdv_run_ctx* ctx = (mdv_run_ctx*)token;
	napi_call_threadsafe_function(ctx->tsfn, err, napi_tsfn_blocking);
}

// Creates a promise that Go settles later with mdvRunDone(token, err). While
// pending it keeps the event loop alive. Returns 0 with an exception pending
// on failure.
uintptr_t mdv_async_begin(napi_env env, const char* name, napi_value* promise) {
	mdv_run_ctx* ctx = calloc(1, sizeof(mdv_run_ctx));
	napi_value resource_name;
	if (napi_create_promise(env, &ctx->deferred, promise) != napi_ok ||
		napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resource_name) != napi_ok ||
		napi_create_threadsafe_function(env, NULL, NULL, resource_name, 0, 1, NULL, NULL, ctx, mdv_run_done_js, &ctx->tsfn) != napi_ok) {
		free(ctx);
		mdv_throw_last_error(env);
		return 0;
	}
	return (uintptr_t)ctx;
}

// Rejects a promise from mdv_async_begin with err (owned) when the work
// could not be handed to Go.
void mdv_async_fail(napi_env env, uintptr_t token, char* err) {
	mdv_run_ctx* ctx = (mdv_run_ctx*)token;
	napi_value msg, error;
	napi_create_string_utf8(env, err, NAPI_AUTO_LENGTH, &msg);
	napi_create_error(env, NULL, msg, &error);
	napi_reject_deferred(env, ctx->deferred, error);
	napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_abort);
	free(ctx);
	mdvFree(err);
}

// clientStart(id: number): Promise<void>, settled when the client stops.
static napi_value mdv_client_start(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	uint64_t id;
	if (!mdv_args(env, info, 1, argv) || !mdv_get_id(env, argv[0], &id)) return NULL;

	napi_value promise;
	uintptr_t token = mdv_async_begin(env, "masterdnsvpn:client", &promise);
	if (token == 0) return NULL;

	char* err = mdvClientStart(id, token);
	if (err != NULL) mdv_async_fail(env, token, err);
	return promise;
}

// clientStop(id: number): boolean
static napi_value mdv_client_stop(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	uint64_t id;
	if (!mdv_args(env, info, 1, argv) || !mdv_get_id(env, argv[0], &id)) return NULL;

	napi_value result;
	MDV_CHECK(env, napi_get_boolean(env, mdvClientStop(id) != 0, &result));
	return result;
}

// clientDestroy(id: number): void
static napi_value mdv_client_destroy(napi_env env, napi_callback_info info) {
	napi_value argv[1];
	uint64_t id;
	if (!mdv_args(env, info, 1, argv) || !mdv_get_id(env, argv[0], &id)) return NULL;
	mdvClientDestroy(id);
	return NULL;
}

typedef char* (*mdv_json_getter)(uint64_t id, char** errOut);

static napi_value mdv_client_json(napi_env env, napi_callback_info info, mdv_json_getter getter) {
	napi_value argv[1];
	uint64_t id;
	if (!mdv_args(env, info, 1, argv) || !mdv_get_id(env, argv[0], &id)) return NULL;

	char* err = NULL;
	char* json = getter(id, &err);
	if (err != NULL) return mdv_throw_owned(env, err);
	return mdv_string_owned(env, json);
}

// clientInfo / clientStatus / clientConnections(id: number): string (JSON)
static napi_value mdv_client_info(napi_env env, napi_callback_info info) {
	return mdv_client_json(env, info, mdvClientInfo);
}

static napi_value mdv_client_status(napi_env env, napi_callback_info info) {
	return mdv_client_json(env, info, mdvClientStatus);
}

static napi_value mdv_client_connections(napi_env env, napi_callback_info info) {
	return mdv_client_json(env, info, mdvClientConnections);
}

NAPI_MODULE_INIT() {
	napi_property_descriptor props[] = {
		{"version", NULL, mdv_version, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientCreate", NULL, mdv_client_create, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientStart", NULL, mdv_client_start, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientStop", NULL, mdv_client_stop, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientDestroy", NULL, mdv_client_destroy, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientInfo", NULL, mdv_client_info, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientStatus", NULL, mdv_client_status, NULL, NULL, NULL, napi_enumerable, NULL},
		{"clientConnections", NULL, mdv_client_connections, NULL, NULL, NULL, napi_enumerable, NULL},
		{"loadConfig", NULL, mdv_load_config, NULL, NULL, NULL, napi_enumerable, NULL},
	};
	if (napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props) != napi_ok) {
		mdv_throw_last_error(env);
		return NULL;
	}
	mdv_register_router(env, exports);
	return exports;
}
*/
import "C"
