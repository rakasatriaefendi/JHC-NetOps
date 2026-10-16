import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appendFeedback, FeedbackAttempts, FeedbackSwipe, FeedbackTimer, FEEDBACK_MAX_VISIBLE,
  FEEDBACK_SUCCESS_MS, type FeedbackClock } from "../lib/action-feedback.ts";
import { MutationGate } from "../lib/mutation-feedback.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
function fakeClock() {
  let time = 0, nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const clock: FeedbackClock = {
    now: () => time,
    schedule: (callback, delay) => {
      const id = ++nextId;
      pending.set(id, { at: time + delay, callback });
      return () => { pending.delete(id); };
    },
  };
  return {
    clock,
    size: () => pending.size,
    callback: () => [...pending.values()][0]!.callback,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
  };
}

test("success dismisses at 3500ms, once; repeated starts do not reset its remaining lifetime", () => {
  const clock = fakeClock(); const dismissed: number[] = [];
  const timer = new FeedbackTimer(FEEDBACK_SUCCESS_MS, () => dismissed.push(1), clock.clock);
  assert.equal(FEEDBACK_SUCCESS_MS, 3_500);
  timer.start(); clock.advance(2_000); timer.start();
  assert.equal(clock.size(), 1);
  clock.advance(1_499); assert.deepEqual(dismissed, []);
  clock.advance(1); assert.deepEqual(dismissed, [1]);
  timer.start(); clock.advance(10_000);
  assert.deepEqual(dismissed, [1]);
});

test("important failures remain persistent without scheduling any timer", () => {
  const clock = fakeClock(); let dismissed = false;
  const timer = new FeedbackTimer(null, () => { dismissed = true; }, clock.clock);
  timer.start(); timer.pause("hover"); timer.resume("hover");
  timer.pause("focus"); timer.resume("focus");
  clock.advance(60_000);
  assert.equal(clock.size(), 0);
  assert.equal(dismissed, false);
  const component = source("../components/ui/action-feedback.tsx");
  assert.match(component, /new FeedbackTimer\(item\.success \? FEEDBACK_SUCCESS_MS : null/);
});

test("hover and keyboard focus independently pause/resume the remaining duration, including overlapping reasons", () => {
  const clock = fakeClock(); let dismissed = 0;
  const timer = new FeedbackTimer(FEEDBACK_SUCCESS_MS, () => { dismissed++; }, clock.clock);
  timer.start(); clock.advance(1_000);
  timer.pause("hover"); clock.advance(10_000);
  timer.pause("focus"); timer.resume("hover"); clock.advance(10_000);
  assert.equal(clock.size(), 0);
  assert.equal(dismissed, 0);
  timer.resume("focus"); clock.advance(2_499);
  assert.equal(dismissed, 0);
  clock.advance(1); assert.equal(dismissed, 1);
  // Focus alone (not only simultaneous hover) also suspends auto-dismiss.
  const keyboard = new FeedbackTimer(FEEDBACK_SUCCESS_MS, () => { dismissed++; }, clock.clock);
  keyboard.start(); clock.advance(500); keyboard.pause("focus"); clock.advance(20_000);
  assert.equal(dismissed, 1);
  keyboard.resume("focus"); clock.advance(2_999); assert.equal(dismissed, 1);
  clock.advance(1); assert.equal(dismissed, 2);
});

test("ID-scoped timers clean up on dismissal/unmount; Strict Mode setup-cleanup-setup retains remaining time", () => {
  const clock = fakeClock(); const dismissed: number[] = [];
  const first = new FeedbackTimer(FEEDBACK_SUCCESS_MS, () => dismissed.push(1), clock.clock);
  const second = new FeedbackTimer(FEEDBACK_SUCCESS_MS, () => dismissed.push(2), clock.clock);
  first.start(); const staleCallback = clock.callback();
  second.start(); clock.advance(1_000);
  first.stop(); staleCallback(); // Even an already-dispatched stale callback cannot dismiss.
  assert.deepEqual(dismissed, []);
  assert.equal(clock.size(), 1);
  second.stop(); assert.equal(clock.size(), 0);
  second.start(); second.stop(); second.start();
  assert.equal(clock.size(), 1);
  clock.advance(2_499); assert.deepEqual(dismissed, []);
  clock.advance(1); assert.deepEqual(dismissed, [2]);
  first.stop(); second.stop(); assert.equal(clock.size(), 0);
  const component = source("../components/ui/action-feedback.tsx");
  assert.match(component, /<ActionNotification key=\{item\.id\} item=\{item\} dismiss=\{dismiss\}/);
  assert.match(component, /return \(\) => \{ timer\.stop\(\); swipe\.cancel\(\); \}/);
});

test("horizontal swipe reaches threshold in either direction; short/vertical/diagonal gestures cannot dismiss", () => {
  const swipe = new FeedbackSwipe();
  swipe.begin(1, 0, 0); assert.equal(swipe.end(1, 64, 2), true);
  swipe.begin(2, 100, 10); assert.equal(swipe.end(2, 30, 12), true);
  swipe.begin(3, 0, 0); assert.equal(swipe.end(3, 63, 0), false);
  swipe.begin(4, 0, 0); swipe.move(4, 2, 30);
  assert.equal(swipe.end(4, 100, 31), false, "vertical intent is not later reinterpreted as horizontal");
  swipe.begin(5, 0, 0); assert.equal(swipe.end(5, 10, 100), false);
  swipe.begin(6, 0, 0); assert.equal(swipe.end(6, 70, 60), false);
  const component = source("../components/ui/action-feedback.tsx");
  assert.match(component, /touch-pan-y/);
  assert.doesNotMatch(component, /preventDefault\(|touch-none/);
});

test("pointer cancel/lost capture and interrupted multi-touch do not dismiss and resume timer", () => {
  const clock = fakeClock(); const swipe = new FeedbackSwipe(); let dismissed = 0;
  const timer = new FeedbackTimer(FEEDBACK_SUCCESS_MS, () => { dismissed++; }, clock.clock);
  timer.start(); clock.advance(1_000);
  swipe.begin(1, 0, 0); timer.pause("swipe"); clock.advance(10_000);
  swipe.cancel(); timer.resume("swipe");
  assert.equal(swipe.end(1, 100, 0), false);
  clock.advance(2_499); assert.equal(dismissed, 0);
  clock.advance(1); assert.equal(dismissed, 1);
  swipe.begin(2, 0, 0); assert.equal(swipe.end(99, 100, 0), false);
  assert.equal(swipe.begin(3, 0, 0), false);
  assert.equal(swipe.end(2, 100, 0), false);
  const component = source("../components/ui/action-feedback.tsx");
  assert.match(component, /const cancelSwipe = \(\) => \{ swipe\.cancel\(\); timer\.resume\("swipe"\); \}/);
  assert.match(component, /onPointerCancel=\{cancelSwipe\} onLostPointerCapture=\{cancelSwipe\}/);
  assert.match(component, /if \(!event\.isPrimary\) \{ cancelSwipe\(\); return; \}/);
  assert.match(component, /closest\("button"\)/, "touching Close must retain native button interaction");
});

test("Close is a localized native keyboard button with visible focus and adequate click target", () => {
  const component = source("../components/ui/action-feedback.tsx");
  // A native button supplies Enter/Space semantics; no custom keyboard handler intercepts them.
  assert.match(component, /<button type="button" className="[^"]*h-12 w-12[^"]*focus-visible:outline/);
  assert.match(component, /aria-label=\{t\("actions\.close"\)\} onClick=\{\(\) => dismiss\(item\.id\)\}/);
  assert.doesNotMatch(component, /onKeyDown|tabIndex=\{-1\}/);
  assert.match(component, /onFocusCapture=\{\(\) => timer\.pause\("focus"\)\}/);
  assert.match(component, /currentTarget\.contains\(event\.relatedTarget\)/);
  for (const locale of ["en", "id"]) {
    const copy = JSON.parse(source(`../i18n/${locale}/common.json`));
    assert.ok(copy.actions.close);
  }
});

test("only identical explicit attempts deduplicate; distinct attempts and absent evidence are never message-deduped", () => {
  const evidence = new FeedbackAttempts(); let visible: string[] = [];
  const notifySameMessage = (attemptId?: string) => {
    if (evidence.accept(attemptId)) visible = appendFeedback(visible, "Changes saved.");
  };
  notifySameMessage("save:1"); notifySameMessage("save:1");
  assert.equal(visible.length, 1);
  visible = []; // Dismissal must not make the same attempt appear again.
  notifySameMessage("save:1"); assert.equal(visible.length, 0);
  notifySameMessage("save:2"); notifySameMessage("save:3");
  notifySameMessage(); notifySameMessage();
  assert.equal(visible.length, 4, "identical messages from distinct attempts remain visible");
  const attempts = new FeedbackAttempts();
  assert.equal(attempts.accept("request:123"), true);
  assert.equal(attempts.accept("request:123"), false);
  assert.equal(attempts.accept("request:124"), true);
  assert.equal(attempts.accept(), true);
  assert.equal(attempts.accept(), true);
  assert.equal(attempts.accept("x".repeat(129)), true, "unbounded evidence is not retained");
  for (let i = 0; i < 128; i++) assert.equal(attempts.accept(`attempt:${i}`), true);
  assert.equal(attempts.accept("attempt:127"), false);
  assert.equal(attempts.accept("request:123"), true, "old evidence is evicted from the bounded window");
  const component = source("../components/ui/action-feedback.tsx");
  assert.match(component, /if \(!attempts\.accept\(attemptId\)\) return/);
  assert.doesNotMatch(component, /attempts\.accept\((?:action|code|errorKey)/);
});

test("exactly one terminal notification per mutation; distinct legitimate mutations remain visible", async () => {
  const gate = new MutationGate(), attempts = new FeedbackAttempts();
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => { finish = resolve; });
  let notifications: { id: number; success: boolean }[] = [];
  const feedback = (success: boolean) => {
    notifications = appendFeedback(notifications, { id: notifications.length + 1, success });
  };
  const first = gate.run(async () => { await operation; return { ok: true }; }, feedback);
  assert.equal(await gate.run(async () => ({ ok: true }), feedback), false);
  assert.equal(notifications.length, 0);
  finish(); await first;
  assert.equal(notifications.length, 1);
  await gate.run(async () => ({ ok: true }), feedback);
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((item) => item.success), [true, true]);
  assert.equal(attempts.accept("event:terminal"), true);
  assert.equal(attempts.accept("event:terminal"), false);
  await gate.run(async () => ({ ok: false }), feedback);
  assert.deepEqual(notifications.map((item) => item.success), [true, true, false]);
  await gate.run(async () => ({ ok: true, changed: false }), feedback);
  assert.equal(notifications.length, 3);
});

test("stack stays bounded and does not mutate prior snapshots", () => {
  let notifications: number[] = [];
  for (let id = 1; id <= 20; id++) {
    const prior = [...notifications];
    const current = notifications;
    notifications = appendFeedback(current, id);
    assert.deepEqual(current, prior);
    assert.ok(notifications.length <= FEEDBACK_MAX_VISIBLE);
  }
  assert.equal(FEEDBACK_MAX_VISIBLE, 4);
  assert.deepEqual(notifications, [17, 18, 19, 20]);
});

test("notification lifecycle has no background producers or unrestricted error text", () => {
  const component = source("../components/ui/action-feedback.tsx");
  const lifecycle = component.slice(component.indexOf("function ActionNotification"));
  assert.doesNotMatch(lifecycle, /notify\(|setNotifications|fetch\(|EventSource|setInterval/);
  assert.match(component, /lifecycleErrors\.has\(code\)/);
  assert.match(component, /"mutation\.failed"/);
  assert.doesNotMatch(component, /console\.|JSON\.stringify|\.message/);
  const traffic = source("../components/traffic/traffic-live-page.tsx");
  assert.doesNotMatch(traffic.slice(0, traffic.indexOf("async function runAction")), /notify\(/);
  const discovery = source("../components/dashboard/network-discovery-drawer.tsx");
  assert.match(discovery, /if \(action === "start_session"\) notify\("start", true\)/);
  const form = source("../components/ui/mutation-form.tsx");
  assert.match(form, /gate\.current\.run\(\(\) => action\(data\), \(success, code\) => notify\(kind, success, code\)\)/);
});
