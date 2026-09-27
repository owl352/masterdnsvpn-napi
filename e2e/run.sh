#!/usr/bin/env bash
# Runs e2e/client.mjs in proxy and TUN mode against a MasterDnsVPN server, each
# in its own container on a private network, so the client's resolver is a
# real non-local address (as it is for users). Needs Docker, Go, and built
# packages (npm run build:full, at least for linux-<arch>-gnu).
set -euo pipefail
cd "$(dirname "$0")/.."

arch=$(docker info --format '{{.Architecture}}')
case "$arch" in
  x86_64|amd64) goarch=amd64 ;;
  aarch64|arm64) goarch=arm64 ;;
  *) echo "unsupported docker arch $arch"; exit 1 ;;
esac

work=.build/e2e
mkdir -p "$work"
(cd MasterDnsVPN && CGO_ENABLED=0 GOOS=linux GOARCH=$goarch go build -trimpath -o "../$work/mdv-server" ./cmd/server)
cat > "$work/server_config.toml" <<'TOML'
DOMAIN = ["t.example.com"]
PROTOCOL_TYPE = "SOCKS5"
UDP_HOST = "0.0.0.0"
UDP_PORT = 53
DATA_ENCRYPTION_METHOD = 1
ENCRYPTION_KEY_FILE = "/tmp/key.txt"
TOML

cleanup() { docker rm -f mdv-e2e-server mdv-e2e-client >/dev/null 2>&1 || true; docker network rm mdv-e2e >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create mdv-e2e >/dev/null

docker run -d --name mdv-e2e-server --network mdv-e2e -v "$PWD/$work":/e2e:ro debian:bookworm-slim \
  sh -c 'cp /e2e/server_config.toml /tmp/ && cd /tmp && /e2e/mdv-server -config /tmp/server_config.toml -nowait' >/dev/null
for _ in $(seq 1 30); do docker exec mdv-e2e-server test -s /tmp/key.txt 2>/dev/null && break; sleep 1; done
key=$(docker exec mdv-e2e-server cat /tmp/key.txt | tr -d '\n')
server_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' mdv-e2e-server)

docker run -d --name mdv-e2e-client --network mdv-e2e --cap-add NET_ADMIN --device /dev/net/tun \
  -v "$PWD":/app:ro -w /app node:22-bookworm-slim sleep infinity >/dev/null
docker exec mdv-e2e-client sh -c 'apt-get update -qq >/dev/null && apt-get install -y -qq curl >/dev/null'
# Docker's embedded DNS is on loopback, which never enters a TUN; use a normal
# resolver like a desktop would.
docker exec mdv-e2e-client sh -c 'echo "nameserver 9.9.9.9" > /etc/resolv.conf'

for mode in proxy tun; do
  echo "=== $mode mode"
  docker exec -e MDV_KEY="$key" mdv-e2e-client timeout 300 node e2e/client.mjs "$mode" "$server_ip"
done
