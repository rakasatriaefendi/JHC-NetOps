"use client";

import { useState } from "react";

import { executeCutoverCanary } from "@/app/actions/cutover-canary";
import { Button } from "@/components/ui/button";

type CanaryResult = Readonly<{
  ok: boolean;
  canaryId?: string;
  writeOk?: boolean;
  readOk?: boolean;
  cleanupOk?: boolean;
  error?: string;
}>;

export function P13CutoverCanaryControl() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CanaryResult | null>(null);

  async function runCanary() {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const response = await executeCutoverCanary();
      setResult({
        ok: response.ok,
        ...(response.canaryId ? { canaryId: response.canaryId } : {}),
        ...(response.writeOk !== undefined ? { writeOk: response.writeOk } : {}),
        ...(response.readOk !== undefined ? { readOk: response.readOk } : {}),
        ...(response.cleanupOk !== undefined ? { cleanupOk: response.cleanupOk } : {}),
        ...(response.error ? { error: response.error.slice(0, 200) } : {}),
      });
    } catch {
      setResult({ ok: false, error: "Canary request failed" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-5">
      <p className="text-meta font-medium uppercase tracking-wide text-accent">P13 internal verification</p>
      <h2 className="mt-2 text-section font-semibold">Cutover canary</h2>
      <p className="mt-2 text-body text-text-secondary">
        Runs the approved write, read, verify, and cleanup check without creating domain records.
      </p>
      <Button className="mt-4" disabled={running} onClick={() => void runCanary()}>
        {running ? "Running P13 Cutover Canary..." : "Run P13 Cutover Canary"}
      </Button>
      {result ? (
        <pre aria-live="polite" className="mt-4 max-h-64 overflow-auto rounded-control border border-border bg-bg-base p-3 font-data text-meta text-text-secondary">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}
