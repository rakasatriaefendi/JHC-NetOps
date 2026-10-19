const PRIORITY = ["manual_ping", "traffic", "discovery", "device_inspector"];
const CLAIMS = { manual_ping: "claimManualPing", traffic: "claimTraffic", discovery: "claimDiscovery", device_inspector: "claimInspection" };

export function controlDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Serial dispatch only; Health/SNMP/heartbeat continue in their independent loops. */
export async function runControlPlane({ backend, runnerId, manualPingEnabled, execute, signal,
  once = false, legacyIntervalMs = 2_000, sleep = controlDelay, now = Date.now, random = Math.random }) {
  if (signal.aborted) return;
  let legacyUntil = 0;
  let failures = 0;
  do {
    try {
      let available = PRIORITY;
      if (!once && now() >= legacyUntil) {
        const work = await backend.waitForWork(runnerId, signal);
        if (signal.aborted) break;
        if (work.supported) {
          failures = 0;
          available = work.available;
          // A successful idle timeout is NOT a request to issue empty claims.
          if (work.timed_out) continue;
        } else legacyUntil = now() + 60_000;
      }
      let executed = false;
      for (const kind of PRIORITY) {
        if (signal.aborted) break;
        if (!available.includes(kind) || (kind === "manual_ping" && !manualPingEnabled)) continue;
        const claimed = await backend[CLAIMS[kind]](runnerId);
        if (!claimed) continue; // Lost an atomic claim race; never execute the hint.
        await execute[kind](claimed);
        backend.control?.reconcile?.(); // Next durable queue read, not another empty HTTP claim.
        executed = true;
        break;
      }
      failures = 0;
      if (!once && !signal.aborted) {
        if (now() < legacyUntil) await sleep(legacyIntervalMs, signal);
        else if (!executed) await sleep(250, signal); // stale hint / competing runner process
      }
    } catch {
      if (signal.aborted) break;
      failures = Math.min(failures + 1, 6);
      const base = Math.min(30_000, 1_000 * 2 ** (failures - 1));
      const delay = Math.min(30_000, Math.round(base * (0.8 + random() * 0.4)));
      if (!once) await sleep(delay, signal);
    }
  } while (!once && !signal.aborted);
}
