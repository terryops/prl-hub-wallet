// shared/ holds copies of the Pearl Hub Web frontend files the wallet uses, and ICONS.md.
// Their source is web/src in the prl-hub-web repository; after they change there, copy them
// again (every file the wallet's src/ and test/ import from shared/, and what those import):
//   npm run sync:shared                       from ../prl-hub-web/web/src
//   npm run sync:shared -- <web/src path>     from another checkout
//   npm run sync:shared -- --check            list the differences and exit 1; change nothing
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const shared = join(root, "shared");
const args = process.argv.slice(2), check = args.includes("--check");
const webSrc = resolve(args.find((arg) => arg !== "--check") || join(root, "../prl-hub-web/web/src"));
try { await access(join(webSrc, "security-overview.ts")); }
catch { throw new Error(`No Web frontend source at ${webSrc}; pass the path to prl-hub-web/web/src`); }

const importPattern = /(?:from\s*|import\(\s*|@import\s+url\(|import\s+)["']([^"']+)["']/g;
const relativeImports = (text) => [...text.matchAll(importPattern)].map((match) => match[1]).filter((spec) => spec.startsWith("."));
const sources = async (directory) => (await readdir(join(root, directory), { recursive: true }))
  .filter((name) => /\.(tsx?|css)$/.test(name)).map((name) => join(root, directory, name));

const queue = [];
for (const file of [...await sources("src"), ...await sources("test")]) {
  for (const spec of relativeImports(await readFile(file, "utf8"))) {
    const name = relative(shared, normalize(join(dirname(file), spec)));
    if (!name.startsWith("..")) queue.push(name);
  }
}
const wanted = new Set();
while (queue.length) {
  const name = queue.pop();
  if (wanted.has(name)) continue;
  wanted.add(name);
  if (!/\.(tsx?|css)$/.test(name)) continue;
  for (const spec of relativeImports(await readFile(join(webSrc, name), "utf8"))) {
    const next = relative(webSrc, normalize(join(webSrc, dirname(name), spec)));
    if (next.startsWith("..")) throw new Error(`${name} imports ${spec} outside web/src`);
    queue.push(next);
  }
}

const changed = [];
const pairs = [...[...wanted].map((name) => [join(webSrc, name), join(shared, name)]), [join(webSrc, "../ICONS.md"), join(root, "ICONS.md")]];
for (const [from, to] of pairs) {
  const text = await readFile(from), current = await readFile(to).catch(() => null);
  if (current?.equals(text)) continue;
  changed.push(relative(root, to));
  if (!check) { await mkdir(dirname(to), { recursive: true }); await writeFile(to, text); }
}
for (const entry of await readdir(shared, { recursive: true, withFileTypes: true })) {
  const name = relative(shared, join(entry.parentPath, entry.name));
  if (!entry.isFile() || wanted.has(name)) continue;
  changed.push(`shared/${name} (no longer imported)`);
  if (!check) await rm(join(shared, name));
}

if (!changed.length) console.log(`shared/ matches ${webSrc}`);
else if (check) { console.log(`shared/ differs from ${webSrc}:\n  ${changed.join("\n  ")}`); process.exitCode = 1; }
else console.log(`Updated from ${webSrc}:\n  ${changed.join("\n  ")}`);
