const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows/release.yml"), "utf8"));
const steps = workflow.jobs.release.steps;
const tagCheck = steps.find((step) => step.id === "release-tag");

test("release workflow binds checkout to the requested existing tag and checks archive consumer", () => {
  assert.match(steps[0].with.ref, /inputs.tag/);
  assert.match(steps[0].with.ref, /github.ref_name/);
  assert.equal(steps[0].with["fetch-depth"], 0);
  assert.match(tagCheck.env.REQUESTED_TAG, /inputs.tag/);
  assert.ok(steps.some((step) => step.name === "Verify archived consumer" && /npm test/.test(step.run) && /npm run validate/.test(step.run)));
  const archive = steps.find((step) => step.name === "Build suite archive");
  assert.match(archive.run, /LICENSE/);
  assert.match(archive.run, /suite-release.json/);
  assert.match(archive.run, /\.github\/workflows\/release.yml/);
  assert.match(archive.run, /sha256sum/);
  assert.match(steps.find((step) => step.name === "Create GitHub release").run, /--verify-tag/);
  for (const step of steps.filter((value) => value.run)) {
    assert.equal(spawnSync("bash", ["-n"], { input: step.run }).status, 0);
    assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
  }
});

test("tag gate rejects missing tags version mismatches wrong commits and missing license", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kalshicore-release-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  fs.writeFileSync(path.join(root, "LICENSE"), "Test fixture only.\n");
  git("add", "package.json", "LICENSE");
  git("commit", "-qm", "test fixture");
  git("tag", "v0.1.0");
  const check = (tag) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", tagCheck.run], {
    cwd: root, env: { ...process.env, REQUESTED_TAG: tag, GITHUB_OUTPUT: path.join(root, "output") }, encoding: "utf8"
  });
  assert.equal(check("v0.1.0").status, 0);
  assert.match(fs.readFileSync(path.join(root, "output"), "utf8"), /value=v0.1.0/);
  for (const tag of ["main", "v0.1.0; touch injected", "v0.1.1", "v01.1.0"]) assert.notEqual(check(tag).status, 0);
  assert.equal(fs.existsSync(path.join(root, "injected")), false);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  assert.notEqual(check("v0.1.0").status, 0);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  fs.rmSync(path.join(root, "LICENSE"));
  assert.notEqual(check("v0.1.0").status, 0);
  git("restore", "LICENSE");
  fs.writeFileSync(path.join(root, "extra"), "another commit");
  git("add", "extra");
  git("commit", "-qm", "advance head");
  assert.notEqual(check("v0.1.0").status, 0);
});
