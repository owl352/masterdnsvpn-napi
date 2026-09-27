// Builds the Node-API addon for every desktop target, in two flavors:
//
//   core    MasterDnsVPN client only           -> packages/core/binaries
//   router  client + embedded sing-box router  -> packages/router/binaries
//
// The addon sources in ./native are injected into the MasterDnsVPN module
// (./MasterDnsVPN, a git submodule) as the package masterdnsvpn-go/napibind via
// `go build -overlay`, so they can import the upstream internal/ packages
// without forking or patching upstream. Each target is built with
// -buildmode=c-shared and copied to <package>/binaries/<target>/masterdnsvpn.node.
//
// The router flavor adds sing-box, which upstream's go.mod does not have, so it
// builds with `-modfile=native/router.mod` (upstream's requirements plus
// sing-box). Regenerate it with `npm run router:deps` after bumping the
// submodule or SING_BOX_VERSION.
//
// Env:
//   NATIVE_BUILD_TARGET  comma separated targets, or "host" (default: all)
//   FLAVOR               core, router or all (default: all)
//   MASTERDNSVPN_DIR     MasterDnsVPN checkout (default: ./MasterDnsVPN)
//   MASTERDNSVPN_VERSION version stamped into the binary (default: git describe)
//   PROFILE              "release" (default, stripped) or "debug"
//   SING_BOX_VERSION     sing-box version for --update-router-deps
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const nodeApiHeaders = require("node-api-headers");

const root = __dirname;
const upstreamDir = path.resolve(process.env.MASTERDNSVPN_DIR ?? path.join(root, "MasterDnsVPN"));
const nativeDir = path.join(root, "native");
const buildDir = path.join(root, ".build");
const isRelease = (process.env.PROFILE ?? "release") === "release";
const binName = "masterdnsvpn.node";
const singBoxVersion = process.env.SING_BOX_VERSION ?? "v1.14.2";

const FLAVORS = {
  core: { tags: [], modfile: null, outDir: path.join(root, "packages", "core", "binaries") },
  router: {
    // with_gvisor enables the gvisor and mixed TUN stacks.
    tags: ["router", "with_gvisor"],
    modfile: path.join(nativeDir, "router.mod"),
    outDir: path.join(root, "packages", "router", "binaries"),
  },
};

const zig = (target) => `zig cc -target ${target}`;
const darwinLdflags = "-Wl,-undefined,dynamic_lookup";

// Target names follow `${process.platform}-${process.arch}[-gnu]`, which is what
// packages/core/lib/loader.cjs resolves at runtime. There are no musl targets:
// a Go c-shared library cannot be dlopen'ed on musl (initial-exec TLS on x64,
// argv access in the runtime init on arm64; golang/go#13492).
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

function selectedFlavors() {
  const raw = process.env.FLAVOR ?? "all";
  if (raw === "all") return Object.keys(FLAVORS);
  if (!FLAVORS[raw]) throw new Error(`Unknown flavor ${raw}. Known: all, ${Object.keys(FLAVORS).join(", ")}`);
  return [raw];
}

function upstreamVersion() {
  if (process.env.MASTERDNSVPN_VERSION) return process.env.MASTERDNSVPN_VERSION;
  try {
    return execFileSync("git", ["-C", upstreamDir, "describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

function nativeSources() {
  return fs.readdirSync(nativeDir).filter((f) => f.endsWith(".go"));
}

// Virtually places ./native/*.go at MasterDnsVPN/napibind/ for the go tool.
// cgo runs inside the package directory, so it has to exist on disk; it stays
// empty, which git does not track, so the submodule remains clean.
function writeOverlay() {
  fs.mkdirSync(path.join(upstreamDir, "napibind"), { recursive: true });
  const replace = {};
  for (const file of nativeSources()) {
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

function goEnv(spec, ldflags) {
  return {
    ...process.env,
    CGO_ENABLED: "1",
    GOOS: spec.goos,
    GOARCH: spec.goarch,
    CC: spec.cc,
    CGO_CFLAGS: `-O2 -I${nodeApiHeaders.include_dir}`,
    CGO_LDFLAGS: ldflags.filter(Boolean).join(" "),
    // zig keeps a global cache; point it inside the build dir so CI caches it.
    ZIG_GLOBAL_CACHE_DIR: process.env.ZIG_GLOBAL_CACHE_DIR ?? path.join(buildDir, "zig-cache"),
  };
}

function build(flavorName, target, overlayPath, version) {
  const flavor = FLAVORS[flavorName];
  const spec = TARGETS[target];
  const outDir = path.join(buildDir, flavorName, target);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, binName);

  const ldflags = [spec.ldflags ?? ""];
  if (spec.dlltoolMachine) ldflags.push(windowsImportLib(target, spec.dlltoolMachine));

  const goLdflags = [`-X masterdnsvpn-go/internal/version.BuildVersion=${version}`];
  if (isRelease) goLdflags.push("-s", "-w");

  const args = ["build", "-buildmode=c-shared", "-trimpath", `-overlay=${overlayPath}`];
  if (flavor.tags.length > 0) args.push(`-tags=${flavor.tags.join(",")}`);
  if (flavor.modfile) args.push(`-modfile=${flavor.modfile}`);
  args.push(`-ldflags=${goLdflags.join(" ")}`, "-o", outFile, "./napibind");

  console.log(`--- ${flavorName} ${target} ---`);
  execFileSync("go", args, { cwd: upstreamDir, stdio: "inherit", env: goEnv(spec, ldflags) });

  const dest = path.join(flavor.outDir, target, binName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Replace rather than overwrite: macOS caches code signatures per inode and
  // SIGKILLs a process loading a dylib rewritten in place.
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(outFile, dest);
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`built ${path.relative(root, dest)} (${size} MB)`);
}

// Regenerates native/router.mod/.sum: upstream's go.mod/go.sum plus sing-box.
// `go mod tidy` does not read overlays, so the sources are copied into
// MasterDnsVPN/napibind for the duration and removed afterwards.
function updateRouterDeps() {
  const modfile = FLAVORS.router.modfile;
  const sumfile = modfile.replace(/\.mod$/, ".sum");
  fs.copyFileSync(path.join(upstreamDir, "go.mod"), modfile);
  fs.copyFileSync(path.join(upstreamDir, "go.sum"), sumfile);

  const pkgDir = path.join(upstreamDir, "napibind");
  fs.mkdirSync(pkgDir, { recursive: true });
  const copied = nativeSources().map((file) => {
    const dest = path.join(pkgDir, file);
    fs.copyFileSync(path.join(nativeDir, file), dest);
    return dest;
  });
  try {
    const run = (...args) => execFileSync("go", args, { cwd: upstreamDir, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "1" } });
    run("get", `-modfile=${modfile}`, `github.com/sagernet/sing-box@${singBoxVersion}`);
    run("mod", "tidy", `-modfile=${modfile}`);
  } finally {
    for (const file of copied) fs.rmSync(file, { force: true });
  }
  console.log(`updated ${path.relative(root, modfile)} with sing-box ${singBoxVersion}`);
}

function main() {
  if (!fs.existsSync(path.join(upstreamDir, "go.mod"))) {
    throw new Error(`MasterDnsVPN not found at ${upstreamDir}. Run: git submodule update --init`);
  }
  fs.mkdirSync(buildDir, { recursive: true });

  if (process.argv.includes("--update-router-deps")) {
    updateRouterDeps();
    return;
  }

  const overlayPath = writeOverlay();
  const version = upstreamVersion();
  const targets = selectedTargets();
  const flavors = selectedFlavors();
  console.log(`MasterDnsVPN ${version} on ${os.platform()}-${os.arch()}, flavors: ${flavors.join(", ")}, targets: ${targets.join(", ")}`);

  const failed = [];
  for (const flavor of flavors) {
    for (const target of targets) {
      try {
        build(flavor, target, overlayPath, version);
      } catch (error) {
        console.error(`FAILED ${flavor} ${target}: ${error.message}`);
        failed.push(`${flavor} ${target}`);
      }
    }
  }
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main();
