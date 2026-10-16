// Chrome Web Store releases through the API (v2), without the dashboard.
//
//   node scripts/store-release.mjs status            current published / submitted versions
//   node scripts/store-release.mjs submit [--staged] upload pearl-hub-wallet-<version>-store.zip
//                                                    and submit it for review; --staged waits for
//                                                    a manual publish after approval
//
// Auth: the publisher's one service account (Developer Dashboard → Account), impersonated through
// gcloud as the publisher's Google account, so no key file exists. Setup is in store/SUBMIT.md.
import { execFileSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PUBLISHER = "308e3089-7670-4841-9726-f118780cba3a", ITEM = "amomopjmejbdinidepgbhlkgknkonhah";
const SERVICE_ACCOUNT = process.env.CWS_SERVICE_ACCOUNT || "cws-publisher@pearl-hub-store-release.iam.gserviceaccount.com";
const ACCOUNT = process.env.CWS_GCLOUD_ACCOUNT || "breathlex@gmail.com";
const API = "https://chromewebstore.googleapis.com", NAME = `publishers/${PUBLISHER}/items/${ITEM}`;
const extension = fileURLToPath(new URL("../", import.meta.url));

function token() {
  try {
    return execFileSync("gcloud", ["auth", "print-access-token", `--impersonate-service-account=${SERVICE_ACCOUNT}`,
      "--scopes=https://www.googleapis.com/auth/chromewebstore", `--account=${ACCOUNT}`], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (error) {
    throw new Error(`gcloud could not impersonate ${SERVICE_ACCOUNT} as ${ACCOUNT}:\n${String(error.stderr).trim()}`);
  }
}
async function call(path, init = {}) {
  const response = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${token()}`, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} → ${response.status}: ${body.error?.message || JSON.stringify(body)}` +
    (response.status === 403 ? `\nIs ${SERVICE_ACCOUNT} added under Developer Dashboard → Account?` : ""));
  return body;
}
const status = () => call(`/v2/${NAME}:fetchStatus`);
const describe = (revision) => revision ? `${revision.state} ${revision.distributionChannels?.map((c) => `${c.crxVersion} (${c.deployPercentage ?? "?"}%)`).join(", ") || ""}`.trim() : "none";
function report(s) {
  console.log(`published: ${describe(s.publishedItemRevisionStatus)}`);
  console.log(`submitted: ${describe(s.submittedItemRevisionStatus)}`);
  if (s.lastAsyncUploadState) console.log(`last upload: ${s.lastAsyncUploadState}`);
  if (s.takenDown || s.warned) console.log(`policy: ${s.takenDown ? "taken down" : "warned"}`);
}

async function submit(staged) {
  const { version } = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
  const zip = join(extension, `pearl-hub-wallet-${version}-store.zip`);
  await access(zip).catch(() => { throw new Error(`${zip} is missing; run npm run package first`); });
  // The store rejects `key` and versions it has seen; check the package before uploading.
  const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"]).toString());
  if (manifest.version !== version || "key" in manifest) throw new Error(`${zip} has version ${manifest.version}${"key" in manifest ? " and a key" : ""}; expected the store package for ${version}`);
  const before = await status();
  if (before.submittedItemRevisionStatus?.state === "PENDING_REVIEW") throw new Error("A submission is already in review. Cancel it in the dashboard (or :cancelSubmission) first.");
  if (before.publishedItemRevisionStatus?.distributionChannels?.some((c) => c.crxVersion === version)) throw new Error(`${version} is already published`);

  console.log(`uploading ${zip}`);
  const upload = await call(`/upload/v2/${NAME}:upload`, { method: "POST", headers: { "Content-Type": "application/zip" }, body: await readFile(zip) });
  let state = upload.uploadState, crx = upload.crxVersion;
  for (let i = 0; /IN_PROGRESS/.test(state); i++) {
    if (i === 60) throw new Error("The upload is still processing after 5 minutes; check `status` later.");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    state = (await status()).lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload ${state}: ${JSON.stringify(upload)}`);
  if (crx && crx !== version) throw new Error(`The store read version ${crx} from the upload, expected ${version}`);
  console.log(`uploaded ${version}`);

  const published = await call(`/v2/${NAME}:publish`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: staged ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH" }) });
  console.log(`submitted: ${published.state}${staged ? " (staged: publish manually after approval)" : " (published automatically after approval)"}`);
  for (const w of published.warningInfo?.warnings || []) console.log(`warning ${w.reason}: ${w.description}`);
  report(await status());
}

const [command = "status", ...flags] = process.argv.slice(2);
try {
  if (command === "status") report(await status());
  else if (command === "submit") await submit(flags.includes("--staged"));
  else { console.error("Usage: node scripts/store-release.mjs status | submit [--staged]"); process.exit(2); }
} catch (error) {
  console.error(error.message); process.exit(1);
}
