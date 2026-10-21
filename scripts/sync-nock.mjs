// nock-core/ is a copy of the NOCK (Nockchain) wallet core, the Rust crate the native app links as
// NockMobile.xcframework. Its source is tools/nock-mobile in the prl-hub repository (MIT); change it
// there first, then copy it here and rebuild the WebAssembly module (npm run build:nock):
//   npm run sync:nock                          from ../prl-hub/tools/nock-mobile
//   npm run sync:nock -- <nock-mobile path>    from another checkout
//   npm run sync:nock -- --check               list the differences and exit 1; change nothing
// Only what the WebAssembly build and the crate's tests use is copied: not the Apple packaging
// (build-xcframework.sh, include/) or its README.
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "nock-core");
const args = process.argv.slice(2), check = args.includes("--check");
const source = resolve(args.find((arg) => arg !== "--check") || join(root, "../prl-hub/tools/nock-mobile"));
try { await access(join(source, "src/lib.rs")); }
catch { throw new Error(`No NOCK core at ${source}; pass the path to prl-hub/tools/nock-mobile`); }

const files = async (directory) => (await readdir(join(source, directory), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => relative(source, join(entry.parentPath, entry.name)));
const wanted = new Set(["Cargo.toml", "Cargo.lock", "build.rs", "LICENSE", ".gitignore", ...await files("src"), ...await files("proto"), ...await files("tests")]);

const changed = [];
for (const name of wanted) {
  const text = await readFile(join(source, name)), current = await readFile(join(core, name)).catch(() => null);
  if (current?.equals(text)) continue;
  changed.push(`nock-core/${name}`);
  if (!check) { await mkdir(dirname(join(core, name)), { recursive: true }); await writeFile(join(core, name), text); }
}
for (const entry of await readdir(core, { recursive: true, withFileTypes: true }).catch(() => [])) {
  const name = relative(core, join(entry.parentPath, entry.name));
  if (!entry.isFile() || wanted.has(name) || name.startsWith("target/")) continue;
  changed.push(`nock-core/${name} (not in the source)`);
  if (!check) await rm(join(core, name));
}

if (!changed.length) console.log(`nock-core/ matches ${source}`);
else if (check) { console.log(`nock-core/ differs from ${source}:\n  ${changed.join("\n  ")}`); process.exitCode = 1; }
else console.log(`Updated from ${source}:\n  ${changed.join("\n  ")}\nRebuild the module: npm run build:nock`);
