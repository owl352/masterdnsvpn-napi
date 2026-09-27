//go:build !router

package main

// Core build: no router functions are registered, so the JS side can tell the
// two binaries apart by the presence of routerCreate.

/*
#define NAPI_VERSION 8
#include <node_api.h>

void mdv_register_router(napi_env env, napi_value exports) {}
*/
import "C"
