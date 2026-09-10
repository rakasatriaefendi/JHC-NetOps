import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { NMAP_XML_MAX_BYTES } from "./nmap-parser.js";
import { normalizePrivateCidr, normalizePrivateIpv4 } from "./scan-contract.js";

export type NmapExecutionMode = "discovery" | "fingerprint";

export interface NmapExecutor {
  available(): Promise<boolean>;
  run(mode: NmapExecutionMode, target: string, signal: AbortSignal): Promise<string>;
}

export class PrivilegedNmapExecutor implements NmapExecutor {
  constructor(
    private readonly helperPath: string,
    private readonly sudoPath = "/usr/bin/sudo",
    private readonly nmapPath = "/usr/bin/nmap",
    private readonly spawnProcess = spawn,
  ) {}

  async available(): Promise<boolean> {
    try {
      const [helper] = await Promise.all([
        stat(this.helperPath), access(this.helperPath, constants.X_OK),
        access(this.sudoPath, constants.X_OK), access(this.nmapPath, constants.X_OK),
      ]);
      return helper.uid === 0 && (helper.mode & 0o022) === 0;
    } catch { return false; }
  }

  run(mode: NmapExecutionMode, target: string, signal: AbortSignal): Promise<string> {
    const normalized = mode === "discovery" ? normalizePrivateCidr(target) : normalizePrivateIpv4(target);
    if (!normalized || normalized !== target) return Promise.reject(new ScanExecutionError("SCAN_TARGET_INVALID"));
    return runChild(this.spawnProcess(this.sudoPath, ["-n", this.helperPath, mode, normalized], {
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }), signal);
  }
}

export class ScanExecutionError extends Error {
  constructor(readonly code: "SCAN_TARGET_INVALID" | "NMAP_FAILED" | "NMAP_OUTPUT_TOO_LARGE" | "NMAP_CANCELLED") {
    super(code);
    this.name = "ScanExecutionError";
  }
}

function runChild(child: ChildProcessByStdio<null, Readable, Readable>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let outputTooLarge = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(stdout);
    };
    const abort = () => {
      terminate(child, "SIGTERM");
      const forceTimer = setTimeout(() => terminate(child, "SIGKILL"), 1_000);
      forceTimer.unref();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputTooLarge) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > NMAP_XML_MAX_BYTES) {
        outputTooLarge = true;
        terminate(child, "SIGTERM");
      }
    });
    child.stderr.resume();
    child.once("error", () => finish(new ScanExecutionError(signal.aborted ? "NMAP_CANCELLED" : "NMAP_FAILED")));
    child.once("close", (code) => finish(
      signal.aborted ? new ScanExecutionError("NMAP_CANCELLED")
        : outputTooLarge ? new ScanExecutionError("NMAP_OUTPUT_TOO_LARGE")
          : code === 0 ? undefined : new ScanExecutionError("NMAP_FAILED"),
    ));
  });
}

function terminate(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
  }
  child.kill(signal);
}
