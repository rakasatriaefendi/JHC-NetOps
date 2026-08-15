"use client";

import { useState } from "react";

import { DiagnosticsPanel } from "@/components/dashboard/diagnostics-panel";
import { OneClickDiagnostics } from "@/components/diagnostics/one-click-diagnostics";
import type { DiagnosticJobState } from "@/lib/diagnostic-jobs";
import type { DiagnosticsData } from "@/lib/diagnostics";

type Props = { initialState: DiagnosticJobState; initialDiagnostics: DiagnosticsData; loadError: boolean; diagnosticsLoadError: boolean; prefillTarget?: string; role: "admin" | "viewer" };

export function DiagnosticsWorkspace({ initialState, initialDiagnostics, loadError, diagnosticsLoadError, prefillTarget, role }: Props) {
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  return <><OneClickDiagnostics initialState={initialState} diagnostics={diagnostics} onDiagnosticsChange={setDiagnostics} loadError={loadError} prefillTarget={prefillTarget} role={role} /><DiagnosticsPanel data={diagnostics} loadError={diagnosticsLoadError} /></>;
}
