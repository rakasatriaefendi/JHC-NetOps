import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, rootUrl), "utf8");

test("runner launcher is a foreground, fail-fast, process-manager-neutral entrypoint", () => {
  const script = read("deploy/run-runner.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash\r?\nset -Eeuo pipefail/m);
  assert.match(script, /NODE_BIN="\/home\/mini-pc\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node"/);
  assert.match(script, /PROJECT_ROOT="\/var\/www\/jhc\/jhc_noc\/current"/);
  assert.match(script, /RUNNER_ENV="\/var\/www\/jhc\/jhc_noc\/shared\/runner\/\.env"/);
  assert.match(script, /RUNNER_CONFIG="\/var\/www\/jhc\/jhc_noc\/shared\/runner\/config\.json"/);
  assert.match(script, /\. "\$RUNNER_ENV"/);
  assert.match(script, /exec "\$NODE_BIN" "\$RUNNER_MAIN" --config "\$RUNNER_CONFIG"/);
  assert.doesNotMatch(script, /nohup|pm2|sudo|systemctl|daemon|pid file|&\s*$/im);
  assert.doesNotMatch(script, /eyJ|community|auth_password|priv_password/i);
  assert.doesNotMatch(script, /SUPABASE_(?:URL|SERVICE_ROLE_KEY)=['"][^$]/);
});

test("frontend build launcher resolves the release containing itself and validates build-time public variables", () => {
  const script = read("deploy/build-frontend.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash\r?\nset -Eeuo pipefail/m);
  assert.match(script, /BASH_SOURCE\[0\]/);
  assert.match(script, /RELEASE_ROOT="\$\(cd -- "\$\{SCRIPT_DIR\}\/\.\." && pwd -P\)"/);
  assert.match(script, /FRONTEND_ENV="\/var\/www\/jhc\/jhc_noc\/shared\/frontend\/\.env"/);
  assert.match(script, /NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SITE_URL/);
  assert.match(script, /NPM_BIN="\$\{NODE_DIR\}\/npm"/);
  assert.match(script, /"\$NPM_BIN" run build/);
  assert.doesNotMatch(script, /\/var\/www\/jhc\/jhc_noc\/current|sudo|systemctl|pm2|ln\s+-s|service_role/i);
});

test("frontend runtime launcher is bounded, foreground, and pinned to Node 22", () => {
  const script = read("deploy/run-frontend.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m);
  assert.match(script, /NODE_BIN="\/home\/mini-pc\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node"/);
  assert.match(script, /FRONTEND_ENV="\/var\/www\/jhc\/jhc_noc\/shared\/frontend\/\.env"/);
  assert.match(script, /FRONTEND_ROOT.*\.next/);
  assert.match(script, /check-frontend-port\.mjs/);
  assert.match(script, /FRONTEND_HOST="192\.168\.1\.130"/);
  assert.match(script, /FRONTEND_PORT="3401"/);
  assert.match(script, /exec "\$NODE_BIN" "\$NEXT_BIN" start --hostname "\$FRONTEND_HOST" --port "\$FRONTEND_PORT"/);
  assert.doesNotMatch(script, /nohup|pm2|sudo|systemctl|--port 3402|&\s*$/im);
});

test("Linux deployment text is protected from CRLF", () => {
  const attributes = read(".gitattributes");
  assert.match(attributes, /^\*\.sh text eol=lf$/m);
  assert.match(attributes, /^\*\.service text eol=lf$/m);
  for (const path of ["deploy/run-runner.sh", "deploy/build-frontend.sh", "deploy/run-frontend.sh"]) {
    assert.equal(read(path).includes("\r\n"), false, `${path} must use LF`);
  }
});

test("deployment launchers have valid Bash syntax on a native Linux test host", { skip: process.platform !== "linux" }, () => {
  for (const relativePath of ["deploy/run-runner.sh", "deploy/build-frontend.sh", "deploy/run-frontend.sh"]) {
    const filePath = new URL(relativePath, rootUrl);
    const result = spawnSync("/usr/bin/bash", ["-n", filePath.pathname], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("PM2 ecosystem delegates exactly two fork processes to the reviewed Bash launchers", async () => {
  const configUrl = new URL(`deploy/ecosystem.config.cjs?test=${Date.now()}`, rootUrl);
  const imported = await import(configUrl.href);
  const config = imported.default;

  assert.deepEqual(Object.keys(config), ["apps"]);
  assert.equal(config.apps.length, 2);
  assert.deepEqual(
    config.apps.map(({ name, script }) => ({ name, script })),
    [
      { name: "jhc-netops-runner", script: "deploy/run-runner.sh" },
      { name: "jhc-netops-frontend", script: "deploy/run-frontend.sh" },
    ],
  );

  for (const app of config.apps) {
    assert.equal(app.cwd, "/var/www/jhc/jhc_noc/current");
    assert.equal(app.interpreter, "/usr/bin/bash");
    assert.equal(app.exec_mode, "fork");
    assert.equal(app.instances, 1);
    assert.equal(app.autorestart, true);
    assert.equal(app.watch, false);
  }

  const source = read("deploy/ecosystem.config.cjs");
  assert.doesNotMatch(source, /supabase|service.role|secret|password|community|npm|python/i);
  assert.doesNotMatch(source, /deploy\s*:|cluster|pm2 save/i);
});

test("deployment guide documents the reviewed PM2 start path and systemd exclusion", () => {
  const guide = read("docs/UBUNTU_ALWAYS_ON_DEPLOYMENT.md");
  assert.match(guide, /hentikan kedua unit systemd NetOps/i);
  assert.match(
    guide,
    /cd \/var\/www\/jhc\/jhc_noc\/current\r?\npm2 start deploy\/ecosystem\.config\.cjs/,
  );
  assert.match(guide, /Jangan memakai `pm2 start npm`/);
  assert.match(guide, /`pm2 save` secara otomatis/);
});
