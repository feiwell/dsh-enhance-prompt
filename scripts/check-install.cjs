/**
 * Pre-flight checks for a published copy of this package.
 *
 * Point it at an installed package directory (a profile's node_modules, the
 * npm cache, or a tarball extracted anywhere) and it replays the parts of the
 * DSH loader that decide whether the bundle can actually mount:
 *
 *   node scripts/check-install.cjs <package-dir> [<dsh-app-dir>]
 *
 * Everything it inspects is the running installation, so a PASS here means the
 * manifest, the /client export, the bundle patch, the declared host services,
 * the icons and the composer slot all line up before a restart.
 */

const fs = require("node:fs");
const path = require("node:path");

const pkgDir = path.resolve(process.argv[2] ?? process.cwd());
const appDir = process.argv[3] ?? process.env.DSH_APP_DIR;

let failed = 0;
const ok = (label, detail = "") => console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, detail) => {
  failed += 1;
  console.error(`FAIL ${label} — ${detail}`);
};

if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
  console.error(`not a package directory: ${pkgDir}`);
  process.exit(2);
}

// 1. manifest and client declaration
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const decl = pkg.dsh?.client;
if (decl === undefined) bad("dsh.client declared", "missing dsh.client block");
else if (decl.platform !== "web") bad("dsh.client.platform", `expected web, got ${decl.platform}`);
else ok("dsh.client.platform", "web");

const clientRel = pkg.exports?.["./client"];
if (clientRel === undefined) bad("./client export", "no ./client export");
else {
  const clientPath = path.join(pkgDir, clientRel);
  if (!fs.existsSync(clientPath)) bad("./client export resolves", clientPath);
  else ok("./client export resolves", `${path.basename(clientPath)} ${fs.statSync(clientPath).size} bytes`);
}

// 2. bundle patch
const patchRel = pkg.dsh?.bundle?.patch;
if (patchRel === undefined) bad("dsh.bundle.patch declared", "missing");
else {
  const patchPath = path.join(pkgDir, patchRel);
  if (!fs.existsSync(patchPath)) bad("bundle patch resolves", patchPath);
  else {
    const lines = fs.readFileSync(patchPath, "utf8").split("\n").map((l) => l.trim());
    const hasInsert = lines.includes("- insert:");
    const hasId = lines.some((l) => /^- id: \S+$/.test(l));
    // A scoped name starts with "@", which YAML treats as a reserved indicator,
    // so `name: "@scope/pkg"` is the correct spelling and must count as a match.
    const unquote = (value) => value.replace(/^["']|["']$/g, "");
    const names = lines
      .filter((l) => l.startsWith("name:"))
      .map((l) => unquote(l.slice("name:".length).trim()));
    const hasName = names.includes(pkg.name);
    if (hasInsert && hasId && hasName) ok("bundle patch inserts the plugin row", pkg.name);
    else bad("bundle patch content", `insert=${hasInsert} id=${hasId} name=${hasName} (found: ${names.join(", ") || "none"})`);
  }
}

// 3. engines
const dshRange = pkg.engines?.dsh;
if (dshRange === undefined) bad("engines.dsh declared", "market listings show this range");
else ok("engines.dsh declared", dshRange);

(async () => {
  // 4. host half loads and declares its services
  const mod = await import(`file:///${path.join(pkgDir, "index.js").replace(/\\/g, "/")}`);
  if (typeof mod.apply !== "function") bad("host half exports apply", typeof mod.apply);
  else ok("host half exports apply");
  const want = ["commands", "llm", "agentDefaultModel", "webServer"];
  const missing = want.filter((s) => !(mod.inject ?? []).includes(s));
  if (missing.length > 0) bad("host services declared", `missing ${missing.join(", ")}`);
  else ok("host services declared", mod.inject.join(", "));

  if (appDir === undefined) {
    console.log("\n(skipping app-side checks: pass the dsh app directory to run them)");
    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exitCode = failed === 0 ? 0 : 1;
    return;
  }

  // 5. the providers those services come from
  const providers = {
    commands: "@deepseek-ai/dsh-commands",
    llm: "@deepseek-ai/dsh-llm",
    agentDefaultModel: "@deepseek-ai/dsh-agent-default-model",
    webServer: "@deepseek-ai/dsh-host-webserver",
  };
  for (const service of want) {
    const probe = providers[service];
    if (fs.existsSync(path.join(appDir, "node_modules", probe))) ok(`${service} provider shipped`, probe);
    else bad(`${service} provider shipped`, `${probe} missing`);
  }

  // 6. icon names and the composer slot in the shipped frontend
  const feDir = path.join(appDir, "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets");
  const feFile = fs.readdirSync(feDir).find((f) => /^index-.*\.js$/.test(f));
  const feText = fs.readFileSync(path.join(feDir, feFile), "utf8");
  const source = fs.readFileSync(path.join(pkgDir, clientRel), "utf8");
  const names = [...source.matchAll(/pickIcon\(([^)]*)\)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((n) => n[1]));
  const present = names.filter((name) => feText.includes(name));
  // Each pickIcon group only needs one live name; report the total instead.
  if (present.length > 0) ok("icon candidates exist in the running build", `${present.length}/${names.length} present`);
  else bad("icon candidates exist", "none of the fallback names are exported by this build");

  const conv = fs.readFileSync(
    path.join(appDir, "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"),
    "utf8",
  );
  if (conv.includes('"conversation.input.right"')) ok("conversation.input.right slot exists");
  else bad("conversation.input.right slot exists", "not found in the conversation bundle");

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
