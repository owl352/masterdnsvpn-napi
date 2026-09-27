//go:build router

package main

// Node-API glue for the router (sing-box) functions. Definitions only, no
// //export (see napi.go); shared helpers come from napi.go.

/*
#include <stdint.h>
#include <stdlib.h>

#define NAPI_VERSION 8
#include <node_api.h>

// napi.go
extern void mdv_throw_last_error(napi_env env);
extern napi_value mdv_throw_owned(napi_env env, char* msg);
extern bool mdv_args(napi_env env, napi_callback_info info, size_t count, napi_value* argv);
extern char* mdv_get_string(napi_env env, napi_value value);
extern bool mdv_get_id(napi_env env, napi_value value, uint64_t* id);
extern bool mdv_create_log_tsfn(napi_env env, napi_value fn, napi_threadsafe_function* out);
extern uintptr_t mdv_async_begin(napi_env env, const char* name, napi_value* promise);
extern void mdv_async_fail(napi_env env, uintptr_t token, char* err);

// router.go
extern char* mdvRouterVersion(void);
extern uint64_t mdvRouterCreate(uint64_t clientID, char* optionsJSON, uintptr_t logToken, char** errOut);
extern char* mdvRouterStart(uint64_t id, uintptr_t token);
extern char* mdvRouterClose(uint64_t id, uintptr_t token);

// routerCreate(clientId: number, optionsJson: string, onLog?: (line: string) => void): number
static napi_value mdv_router_create(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value argv[3];
	if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
		mdv_throw_last_error(env);
		return NULL;
	}
	if (argc < 2) {
		napi_throw_type_error(env, NULL, "missing arguments");
		return NULL;
	}

	uint64_t client_id;
	if (!mdv_get_id(env, argv[0], &client_id)) return NULL;

	napi_threadsafe_function log_tsfn = NULL;
	if (argc > 2 && !mdv_create_log_tsfn(env, argv[2], &log_tsfn)) return NULL;

	char* options = mdv_get_string(env, argv[1]);
	if (options == NULL) {
		if (log_tsfn != NULL) napi_release_threadsafe_function(log_tsfn, napi_tsfn_release);
		return NULL;
	}

	// From here on Go owns log_tsfn and releases it through mdvLogClose.
	char* err = NULL;
	uint64_t id = mdvRouterCreate(client_id, options, (uintptr_t)log_tsfn, &err);
	free(options);
	if (err != NULL) return mdv_throw_owned(env, err);

	napi_value result;
	if (napi_create_double(env, (double)id, &result) != napi_ok) {
		mdv_throw_last_error(env);
		return NULL;
	}
	return result;
}

typedef char* (*mdv_router_async_fn)(uint64_t id, uintptr_t token);

static napi_value mdv_router_async(napi_env env, napi_callback_info info, const char* name, mdv_router_async_fn fn) {
	napi_value argv[1];
	uint64_t id;
	if (!mdv_args(env, info, 1, argv) || !mdv_get_id(env, argv[0], &id)) return NULL;

	napi_value promise;
	uintptr_t token = mdv_async_begin(env, name, &promise);
	if (token == 0) return NULL;

	char* err = fn(id, token);
	if (err != NULL) mdv_async_fail(env, token, err);
	return promise;
}

// routerStart(id: number): Promise<void>, settled once sing-box has started.
static napi_value mdv_router_start(napi_env env, napi_callback_info info) {
	return mdv_router_async(env, info, "masterdnsvpn:router-start", mdvRouterStart);
}

// routerClose(id: number): Promise<void>, settled once sing-box has shut down.
static napi_value mdv_router_close(napi_env env, napi_callback_info info) {
	return mdv_router_async(env, info, "masterdnsvpn:router-close", mdvRouterClose);
}

static napi_value mdv_router_version(napi_env env, napi_callback_info info) {
	char* version = mdvRouterVersion();
	napi_value result;
	napi_status status = napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &result);
	free(version);
	if (status != napi_ok) {
		mdv_throw_last_error(env);
		return NULL;
	}
	return result;
}

void mdv_register_router(napi_env env, napi_value exports) {
	napi_property_descriptor props[] = {
		{"routerVersion", NULL, mdv_router_version, NULL, NULL, NULL, napi_enumerable, NULL},
		{"routerCreate", NULL, mdv_router_create, NULL, NULL, NULL, napi_enumerable, NULL},
		{"routerStart", NULL, mdv_router_start, NULL, NULL, NULL, napi_enumerable, NULL},
		{"routerClose", NULL, mdv_router_close, NULL, NULL, NULL, napi_enumerable, NULL},
	};
	napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
}
*/
import "C"
