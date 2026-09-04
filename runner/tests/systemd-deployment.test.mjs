import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkListenPort } from "../../deploy/check-frontend-port.mjs";
import { loadRunnerConfig } from "../src/config.mjs";

const rootUrl = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, rootUrl), "utf8");

test("systemd templates use the reviewed current/shared paths and non-root account", () => {
  const runner = read("deploy/systemd/jhc-netops-runner.service");
  const frontend = read("deploy/systemd/jhc-netops-frontend.service");
  for (const unit of [runner, frontend]) {
    assert.match(unit, /Type=simple/);
    assert.match(unit, /User=mini-pc/);
    assert.match(unit, /Group=mini-pc/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /StandardOutput=journal/);
    assert.match(unit, /StandardError=journal/);
    assert.doesNotMatch(unit, /sudo|pm2|docker|wsl\.exe/i);
  }
  assert.match(runner, /WorkingDirectory=\/var\/www\/jhc\/jhc_noc\/current/);
  assert.match(runner, /ExecStart=\/usr\/bin\/bash \/var\/www\/jhc\/jhc_noc\/current\/deploy\/run-runner\.sh/);
  assert.doesNotMatch(runner, /runner\/src\/main\.mjs|EnvironmentFile=/);
  assert.match(frontend, /WorkingDirectory=\/var\/www\/jhc\/jhc_noc\/current\/frontend/);
  assert.match(frontend, /ExecStart=\/usr\/bin\/bash \/var\/www\/jhc\/jhc_noc\/current\/deploy\/run-frontend\.sh/);
  assert.doesNotMatch(frontend, /--hostname (?:0\.0\.0\.0|::)/);
  assert.doesNotMatch(frontend, /next\/dist\/bin\/next|ExecStartPre/);
});

test("native deployment example keeps config, state, and logs outside releases", () => {
  const configUrl = new URL("deploy/runner-config.example.json", rootUrl);
  const config = JSON.parse(read("deploy/runner-config.example.json"));
  assert.doesNotThrow(() => loadRunnerConfig(fileURLToPath(configUrl), "linux"));
  assert.equal(config.native_project_root, "/var/www/jhc/jhc_noc/current");
  assert.equal(config.environment_file, "/var/www/jhc/jhc_noc/shared/runner/.env");
  assert.equal(config.data_directory, "/var/www/jhc/jhc_noc/shared/state");
  assert.equal(config.log_directory, "/var/www/jhc/jhc_noc/shared/logs");
  assert.equal(config.enable_manual_ping, true);
  assert.equal(config.enable_snmp_telemetry, true);
  assert.deepEqual(config.snmp_credential_profiles, {});
  assert.equal(config.targets[0].enabled, false);
});

test("frontend port preflight passes for an available loopback port", async () => {
  const temporary = net.createServer();
  await listen(temporary, 0);
  const address = temporary.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await close(temporary);
  await checkListenPort("127.0.0.1", port);
});

test("frontend port preflight fails clearly and does not kill an existing listener", async () => {
  const occupied = net.createServer();
  await listen(occupied, 0);
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    checkListenPort("127.0.0.1", address.port),
    (error) => error?.code === "FRONTEND_PORT_IN_USE" && /already occupied/.test(error.message),
  );
  assert.equal(occupied.listening, true);
  await close(occupied);
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
