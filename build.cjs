// Builds the Node-API addon for every desktop target.
//
// The addon sources in ./native are injected into the MasterDnsVPN module
// (./MasterDnsVPN, a git submodule) as the package masterdnsvpn-go/napibind via
// `go build -overlay`, so they can import the upstream internal/ packages
// without forking or patching upstream. Each target is built with
// -buildmode=c-shared and copied to binaries/<target>/masterdnsvpn.node.
//
// Env:
//   NATIVE_BUILD_TARGET  comma separated targets, or "host" (default: all)
//   MASTERDNSVPN_DIR     MasterDnsVPN checkout (default: ./MasterDnsVPN)
//   MASTERDNSVPN_VERSION version stamped into the binary (default: git describe)
//   PROFILE              "release" (default, stripped) or "debug"
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const nodeApiHeaders = require("node-api-headers");

const root = __dirname;
const upstreamDir = path.resolve(process.env.MASTERDNSVPN_DIR ?? path.join(root, "MasterDnsVPN"));
const nativeDir = path.join(root, "native");
const buildDir = path.join(root, ".build");
const binariesDir = path.join(root, "binaries");
const isRelease = (process.env.PROFILE ?? "release") === "release";
const binName = "masterdnsvpn.node";

const zig = (target) => `zig cc -target ${target}`;
const darwinLdflags = "-Wl,-undefined,dynamic_lookup";

// Target names follow `${process.platform}-${process.arch}[-gnu]`, which is what
// lib/loader.cjs resolves at runtime. There are no musl targets: a Go c-shared
// library cannot be dlopen'ed on musl (initial-exec TLS on x64, argv access in
// the runtime init on arm64; golang/go#13492).
const TARGETS = {
  "darwin-arm64": { goos: "darwin", goarch: "arm64", cc: "clang -arch arm64 -mmacosx-version-min=13.0", ldflags: darwinLdflags },
  "darwin-x64": { goos: "darwin", goarch: "amd64", cc: "clang -arch x86_64 -mmacosx-version-min=13.0", ldflags: darwinLdflags },
  "linux-x64-gnu": { goos: "linux", goarch: "amd64", cc: zig("x86_64-linux-gnu.2.28") },
  "linux-arm64-gnu": { goos: "linux", goarch: "arm64", cc: zig("aarch64-linux-gnu.2.28") },
  "win32-x64": { goos: "windows", goarch: "amd64", cc: zig("x86_64-windows-gnu"), dlltoolMachine: "i386:x86-64" },
  "win32-arm64": { goos: "windows", goarch: "arm64", cc: zig("aarch64-windows-gnu"), dlltoolMachine: "arm64" },
};

function hostTarget() {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== "linux") return base;
  const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
  return `${base}-${glibc ? "gnu" : "musl"}`;
}

function selectedTargets() {
  const raw = process.env.NATIVE_BUILD_TARGET;
  if (!raw) return Object.keys(TARGETS);
  const targets = raw.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (t === "host" ? hostTarget() : t));
  for (const t of targets) {
    if (!TARGETS[t]) throw new Error(`Unknown target ${t}. Known: ${Object.keys(TARGETS).join(", ")}`);
  }
  return targets;
}

function upstreamVersion() {
  if (process.env.MASTERDNSVPN_VERSION) return process.env.MASTERDNSVPN_VERSION;
  try {
    return execFileSync("git", ["-C", upstreamDir, "describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

// Virtually places ./native/*.go at MasterDnsVPN/napibind/ for the go tool.
// cgo runs inside the package directory, so it has to exist on disk; it stays
// empty, which git does not track, so the submodule remains clean.
function writeOverlay() {
  fs.mkdirSync(path.join(upstreamDir, "napibind"), { recursive: true });
  const replace = {};
  for (const file of fs.readdirSync(nativeDir).filter((f) => f.endsWith(".go"))) {
    replace[path.join(upstreamDir, "napibind", file)] = path.join(nativeDir, file);
  }
  const overlayPath = path.join(buildDir, "overlay.json");
  fs.writeFileSync(overlayPath, JSON.stringify({ Replace: replace }, null, 2));
  return overlayPath;
}

// MinGW import library so the DLL links its napi_* imports against node.exe.
function windowsImportLib(target, machine) {
  const out = path.join(buildDir, target, "libnode_api.a");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("zig", ["dlltool", "-m", machine, "-d", nodeApiHeaders.def_paths.node_api_def, "-l", out], { stdio: "inherit" });
  return out;
}

function build(target, overlayPath, version) {
  const spec = TARGETS[target];
  const outDir = path.join(buildDir, target);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, binName);

  const ldflags = [spec.ldflags ?? ""];
  if (spec.dlltoolMachine) ldflags.push(windowsImportLib(target, spec.dlltoolMachine));

  const goLdflags = [`-X masterdnsvpn-go/internal/version.BuildVersion=${version}`];
  if (isRelease) goLdflags.push("-s", "-w");

  const args = [
    "build",
    "-buildmode=c-shared",
    "-trimpath",
    `-overlay=${overlayPath}`,
    `-ldflags=${goLdflags.join(" ")}`,
    "-o", outFile,
    "./napibind",
  ];

  console.log(`--- ${target} ---`);
  execFileSync("go", args, {
    cwd: upstreamDir,
    stdio: "inherit",
    env: {
      ...process.env,
      CGO_ENABLED: "1",
      GOOS: spec.goos,
      GOARCH: spec.goarch,
      CC: spec.cc,
      CGO_CFLAGS: `-O2 -I${nodeApiHeaders.include_dir}`,
      CGO_LDFLAGS: ldflags.filter(Boolean).join(" "),
      // zig keeps a global cache; point it inside the build dir so CI caches it.
      ZIG_GLOBAL_CACHE_DIR: process.env.ZIG_GLOBAL_CACHE_DIR ?? path.join(buildDir, "zig-cache"),
    },
  });

  const dest = path.join(binariesDir, target, binName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(outFile, dest);
  console.log(`built ${path.relative(root, dest)}`);
}

function main() {
  if (!fs.existsSync(path.join(upstreamDir, "go.mod"))) {
    throw new Error(`MasterDnsVPN not found at ${upstreamDir}. Run: git submodule update --init`);
  }
  fs.mkdirSync(buildDir, { recursive: true });
  const overlayPath = writeOverlay();
  const version = upstreamVersion();
  const targets = selectedTargets();
  console.log(`MasterDnsVPN ${version} on ${os.platform()}-${os.arch()}, targets: ${targets.join(", ")}`);

  const failed = [];
  for (const target of targets) {
    try {
      build(target, overlayPath, version);
    } catch (error) {
      console.error(`FAILED ${target}: ${error.message}`);
      failed.push(target);
    }
  }
  if (failed.length > 0) {
    console.error(`Failed targets: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main();
