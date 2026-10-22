#!/usr/bin/env node
/**
 * One-shot release: .npmrc -> publish -> verify the live tarball -> re-run the
 * install self-check against the published bytes.
 *
 *   NPM_TOKEN=npm_xxx node scripts/release.cjs
 *
 * The token is written to ~/.npmrc for the duration of the run and removed
 * afterwards, so nothing long-lived is left on disk.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TOKEN = process.env.NPM_TOKEN;
const REGISTRY = "https://registry.npmjs.org/";
const NPMRC = path.join(os.homedir(), ".npmrc");

if (!TOKEN) {
  console.error("NPM_TOKEN is required (npmjs.com -> Access Tokens -> Generate New Token -> Publish)");
  process.exit(2);
}

const run = (cmd, args, options = {}) => {
  const result = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  return result.trim();
};

function writeNpmrc() {
  if (fs.existsSync(NPMRC)) {
    const backup = `${NPMRC}.bak-release`;
    fs.copyFileSync(NPMRC, backup);
    console.log(`existing ~/.npmrc backed up to ${path.basename(backup)}`);
  }
  const line = `//registry.npmjs.org/:_authToken=${TOKEN}\n`;
  fs.appendFileSync(NPMRC, line, "utf8");
  console.log("token written to ~/.npmrc");
}

function removeToken() {
  const backup = `${NPMRC}.bak-release`;
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, NPMRC);
    fs.unlinkSync(backup);
    console.log("~/.npmrc restored from backup");
    return;
  }
  // the file was created by this run: drop it entirely rather than leave an
  // empty config behind
  if (fs.existsSync(NPMRC)) {
    fs.unlinkSync(NPMRC);
    console.log("~/.npmrc removed (it did not exist before this run)");
  }
}

(async () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
  console.log(`\n=== releasing ${pkg.name}@${pkg.version} ===\n`);

  writeNpmrc();
  try {
    console.log("\n--- whoami ---");
    console.log(run("npm", ["whoami", `--registry=${REGISTRY}`]));

    console.log("\n--- test ---");
    console.log(run("npm", ["test"]) .split("\n").slice(-6).join("\n"));

    console.log("\n--- publish ---");
    console.log(run("npm", ["publish", "--access", "public", `--registry=${REGISTRY}`]));

    console.log("\n--- verify the live package ---");
    const version = run("npm", ["view", pkg.name, "version", `--registry=${REGISTRY}`]);
    const tarball = run("npm", ["view", pkg.name, "dist.tarball", `--registry=${REGISTRY}`]);
    const shasum = run("npm", ["view", pkg.name, "dist.shasum", `--registry=${REGISTRY}`]);
    console.log(`version : ${version}`);
    console.log(`tarball : ${tarball}`);
    console.log(`shasum  : ${shasum}`);
    if (version !== pkg.version) throw new Error(`registry reports ${version}, manifest says ${pkg.version}`);

    // pull the published bytes back and check them, so the release is verified
    // as shipped rather than as built
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-release-"));
    console.log(`\n--- re-check the published tarball in ${tmp} ---`);
    run("npm", ["pack", `${pkg.name}@${pkg.version}`, `--registry=${REGISTRY}`, "--pack-destination", tmp]);
    const tarballPath = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    run("tar", ["-xzf", path.join(tmp, tarballPath), "-C", tmp]);
    const extracted = path.join(tmp, "package");
    const checkScript = path.resolve(__dirname, "check-install.cjs");
    console.log(run(process.execPath, [checkScript, extracted]));

    console.log("\n=== RELEASED ===");
    console.log(`https://www.npmjs.com/package/${pkg.name}`);
    console.log(`install: dsh plugin --profile desktop add ${pkg.name}`);
  } finally {
    removeToken();
  }
})().catch((error) => {
  console.error(`\nRELEASE FAILED: ${error.message}`);
  process.exitCode = 1;
});
