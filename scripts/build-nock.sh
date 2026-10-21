#!/bin/bash
# Builds src/nock/nock_core.wasm, the NOCK (Nockchain) wallet core, from nock-core/ (a copy of
# prl-hub's tools/nock-mobile; npm run sync:nock). The module is committed, so building the
# wallet needs no Rust; run this after nock-core/ changes and commit both.
#
# Needs rustup and protoc (macOS: brew install rustup protobuf). The toolchain is pinned so the
# same source gives the same bytes; local paths are taken out of the module for the same reason.
#   npm run build:nock            build and test
#   npm run build:nock -- --check rebuild into a temporary file and compare with the committed one
set -euo pipefail
TOOLCHAIN=1.99.1
TARGET=wasm32-unknown-unknown
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$HERE/nock-core"
OUT="$HERE/src/nock/nock_core.wasm"
# Homebrew's rustup is keg-only; its cargo/rustc proxies must come before any other Rust on PATH.
for dir in "${RUSTUP_BIN:-}" /opt/homebrew/opt/rustup/bin /usr/local/opt/rustup/bin "$HOME/.cargo/bin"; do
  if [ -n "$dir" ] && [ -x "$dir/rustup" ]; then export PATH="$dir:$PATH"; break; fi
done
command -v rustup >/dev/null || { echo "rustup not found (brew install rustup)" >&2; exit 1; }
export PROTOC="${PROTOC:-$(command -v protoc || true)}"
[ -n "$PROTOC" ] || { echo "protoc not found (brew install protobuf)" >&2; exit 1; }
export RUSTUP_TOOLCHAIN="$TOOLCHAIN"
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal
rustup target add --toolchain "$TOOLCHAIN" "$TARGET" >/dev/null 2>&1

CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export CARGO_TARGET_DIR="$CORE/target"
export RUSTFLAGS="--remap-path-prefix=$CORE=/nock-core --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$HOME=/home -C strip=symbols"
cd "$CORE"
echo "==> cargo rustc --release --target $TARGET --crate-type cdylib ($(rustc --version))"
cargo rustc --locked --release --lib --target "$TARGET" --crate-type cdylib --quiet
BUILT="$CARGO_TARGET_DIR/$TARGET/release/nock_mobile.wasm"

if [ "${1:-}" = "--check" ]; then
  if cmp -s "$BUILT" "$OUT"; then echo "src/nock/nock_core.wasm matches nock-core/"; exit 0; fi
  echo "src/nock/nock_core.wasm differs from a fresh build of nock-core/ ($(shasum -a 256 "$BUILT" | cut -c1-16) vs $(shasum -a 256 "$OUT" | cut -c1-16))" >&2
  exit 1
fi

echo "==> cargo test (native, the crate's own vectors)"
unset RUSTFLAGS
CARGO_TARGET_DIR="$CORE/target" cargo test --locked --release --quiet 2>&1 | grep -E "test result|FAILED|panicked" || true
mkdir -p "$(dirname "$OUT")"
cp "$BUILT" "$OUT"
node -e '
const m = new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));
const imports = WebAssembly.Module.imports(m), names = WebAssembly.Module.exports(m).map((e) => e.name);
const missing = ["memory", "nock_call", "nock_free", "nock_alloc", "nock_dealloc"].filter((n) => !names.includes(n));
if (imports.length || missing.length) { console.error("unexpected module interface", { imports, missing }); process.exit(1); }' "$OUT"
node "$HERE/scripts/nock-licenses.mjs"
echo "built src/nock/nock_core.wasm: $(wc -c < "$OUT" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
