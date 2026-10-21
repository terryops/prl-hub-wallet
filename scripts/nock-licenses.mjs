// Writes public/licenses/nock-core.txt: the open-source components compiled into src/nock/nock_core.wasm
// (the Rust crates `cargo tree` links for wasm32-unknown-unknown) with their licenses, and the full texts
// those licenses ask to be passed on. Run by scripts/build-nock.sh after a build; needs the crates
// fetched (any cargo build of nock-core/ does that).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "nock-core");
const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
const tree = execFileSync("cargo", ["tree", "--locked", "--target", "wasm32-unknown-unknown", "-e", "normal", "--prefix", "none", "-f", "{p}|{l}|{r}"], { cwd: core, encoding: "utf8" });
const crates = [...new Map(tree.split("\n").filter(Boolean).map((line) => {
  const [package_, license, repository] = line.replace(/ \(\*\)$/, "").split("|");
  const [name, version] = package_.split(" ");
  return [`${name} ${version}`, { name, version: version.replace(/^v/, ""), license, repository }];
})).values()].filter((c) => c.name !== "nock-mobile").sort((a, b) => a.name.localeCompare(b.name));

// Where a crate's own license files are: the registry's source, or the git checkout (iris-rs).
const registry = join(cargoHome, "registry", "src");
const registries = existsSync(registry) ? readdirSync(registry).map((d) => join(registry, d)) : [];
function crateDir(c) {
  for (const r of registries) if (existsSync(join(r, `${c.name}-${c.version}`))) return join(r, `${c.name}-${c.version}`);
  const git = join(cargoHome, "git", "checkouts");
  for (const repo of existsSync(git) ? readdirSync(git).filter((d) => d.startsWith("iris-rs-")) : [])
    for (const rev of readdirSync(join(git, repo))) return join(git, repo, rev);
  return null;
}
const text = (dir, names) => { for (const n of names) if (dir && existsSync(join(dir, n))) return readFileSync(join(dir, n), "utf8").trim(); return null; };
const find = (name) => crates.find((c) => c.name === name);
const section = (title, body) => `\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n\n${body}\n`;

let out = `NOCK wallet core — open-source components

src/nock/nock_core.wasm is built from nock-core/ (the native Pearl Hub app's tools/nock-mobile
Rust crate, MIT, Copyright (c) 2026 Terry (terryops); see nock-core/LICENSE) together with the
Rust crates below, each under the license shown. The Nockchain transaction engine and
cryptography come from NockBox's Iris Wallet SDK (iris-rs); the protobuf definitions in
nock-core/proto/ come from Zorp's Nockchain repository (MIT, nock-core/proto/LICENSE-MIT).

`;
out += crates.map((c) => `${c.name} ${c.version} — ${c.license}${c.repository ? ` — ${c.repository}` : ""}`).join("\n") + "\n";

const iris = crateDir(find("iris-crypto"));
out += section("iris-rs (iris-crypto, iris-ztd, iris-nockchain-types, iris-grpc-proto) — MIT", text(iris, ["LICENSE", "LICENSE-MIT", "LICENSE.md"]) || "MIT License, Copyright (c) 2025 NockBox inc.");
out += section("Nockchain protocol definitions (nock-core/proto/) — MIT", readFileSync(join(core, "proto", "LICENSE-MIT"), "utf8").trim());
for (const c of crates.filter((c) => /BSD/.test(c.license)))
  out += section(`${c.name} ${c.version} — ${c.license}`, text(crateDir(c), ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) || `${c.license}; see ${c.repository}`);
const unicode = crates.find((c) => /Unicode/.test(c.license));
if (unicode) out += section(`Unicode License v3 (${crates.filter((c) => /Unicode/.test(c.license)).map((c) => c.name).join(", ")})`, text(crateDir(unicode), ["LICENSE-UNICODE"]) || "See https://www.unicode.org/license.txt");
out += section("CC0-1.0 crates (" + crates.filter((c) => c.license === "CC0-1.0").map((c) => c.name).join(", ") + ")",
  "Dedicated to the public domain under Creative Commons CC0 1.0 Universal:\nhttps://creativecommons.org/publicdomain/zero/1.0/legalcode");
out += section("MIT License (crates licensed MIT, or MIT among their options)", text(crateDir(find("serde_json")), ["LICENSE-MIT"]) || "");
out += section("Apache License 2.0 (crates licensed Apache-2.0, or Apache-2.0 among their options)", text(crateDir(find("prost")), ["LICENSE"]) || text(crateDir(find("serde_json")), ["LICENSE-APACHE"]) || "");

writeFileSync(join(root, "public", "licenses", "nock-core.txt"), out);
console.log(`public/licenses/nock-core.txt: ${crates.length} crates`);
