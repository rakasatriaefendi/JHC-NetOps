import assert from "node:assert/strict";
import test from "node:test";

import {
  canLaunchActiveInspection,
  detectedLabel,
  inspectionErrorDetails,
  operatorIdentityConflict,
  shouldOfferHealthPromotion,
  type DeviceFingerprint,
} from "../lib/device-inspector.ts";

test("Device Inspector errors show a friendly action and keep the code as technical detail", () => {
  const context = inspectionErrorDetails("INSPECTION_NETWORK_CONTEXT_UNAVAILABLE");
  assert.match(context.title, /Konteks jaringan Windows/);
  assert.match(context.action, /route Windows/);
  assert.doesNotMatch(`${context.title} ${context.action}`, /raw output/i);
});

test("unknown Device Inspector errors have a safe fallback", () => {
  const fallback = inspectionErrorDetails("SOME_INTERNAL_DETAIL");
  assert.match(fallback.title, /tidak dapat diselesaikan/);
  assert.match(fallback.action, /Local Runner/);
});

test("a completed weak fingerprint is labelled as insufficient evidence", () => {
  const fingerprint = {
    detected_identity: { likely_label: null, model: null },
    likely_device_type: "unknown",
  } as DeviceFingerprint;
  assert.equal(detectedLabel(fingerprint), "Insufficient evidence");
});

test("operator-facing detected label prefers normalized identity", () => {
  const fingerprint = {
    detected_identity: { likely_label: "TP-Link Archer AX53", model: "Archer AX53" },
    likely_device_type: "router",
  } as DeviceFingerprint;
  assert.equal(detectedLabel(fingerprint), "TP-Link Archer AX53");
});

test("self-device evidence warns on conflicting infrastructure identity without mutating it", () => {
  const fingerprint = {
    network_context: { is_this_device: true, automated_role: "this_device" },
  } as DeviceFingerprint;
  const savedOperatorType = "router";
  assert.equal(operatorIdentityConflict(savedOperatorType, fingerprint), true);
  assert.equal(savedOperatorType, "router");
  assert.equal(operatorIdentityConflict("workstation", fingerprint), false);
});

test("active inspection is admin-only and Health promotion is not duplicated", () => {
  assert.equal(canLaunchActiveInspection("admin"), true);
  assert.equal(canLaunchActiveInspection("viewer"), false);
  assert.equal(shouldOfferHealthPromotion(false, "node-1", "runner-1"), true);
  assert.equal(shouldOfferHealthPromotion(true, "node-1", "runner-1"), false);
  assert.equal(shouldOfferHealthPromotion(null, "node-1", "runner-1"), false);
});
