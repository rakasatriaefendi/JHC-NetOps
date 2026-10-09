import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const navigation = source("../components/app-navigation.tsx");
const shell = navigation.match(/data-sidebar="shell" className="([^"]+)"/)?.[1] ?? "";
const nav = navigation.match(/data-sidebar="navigation" className="([^"]+)"/)?.[1] ?? "";
const account = navigation.slice(navigation.indexOf('data-sidebar="account"'), navigation.indexOf("\n    </div>\n  );"));

test("viewport sidebar reserves account space and lets the main navigation shrink/scroll", () => {
  assert.match(navigation, /<aside className="fixed[^\n]*h-dvh min-h-0[^\n]*md:block/);
  assert.match(navigation, /fixed inset-0[^\n]*h-dvh md:hidden/);
  assert.match(navigation, /relative h-full min-h-0 w-64 max-w-full/);
  assert.match(shell, /flex h-full min-h-0 flex-col overflow-y-auto/);
  assert.match(nav, /min-h-0 flex-1 flex-col[^\n]*overflow-y-auto/);
  assert.ok(navigation.indexOf('data-sidebar="account"') > navigation.indexOf("</nav>"));
  assert.match(account, /className="mt-4 shrink-0 border-t border-border pt-4"/);
  assert.doesNotMatch(account, /\b(?:fixed|absolute|sticky|overflow-hidden|h-0|opacity-0)\b/);
  assert.doesNotMatch(account, /className=(?:"[^"]*\bhidden\b|\{`[^`]*\bhidden\b)/,
    "decorative aria-hidden icons must not be mistaken for hidden controls");
});

test("short-height and 125% zoom fallback keeps navigation and account in reachable scroll flow", () => {
  // 600px at 125% zoom can leave only 480 CSS pixels. The 768/900px cases
  // retain nav scrolling; the smaller case expands the nav in shell scrolling.
  assert.deepEqual([600, 768, 900].map((height) => height / 1.25 <= 480), [true, false, false]);
  assert.match(nav, /\[@media\(max-height:480px\)\]:flex-none/);
  assert.match(nav, /\[@media\(max-height:480px\)\]:overflow-visible/);
  assert.match(shell, /overflow-y-auto/);
  assert.match(shell, /env\(safe-area-inset-top\)/);
  assert.match(shell, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(account, /max-h-|overflow-hidden/);
});

test("Profile is an explicit localized navigation control with icon, active and keyboard focus states", () => {
  const profile = account.slice(account.indexOf('<Link href="/profile"'), account.indexOf("</Link>") + "</Link>".length);
  assert.ok(profile.startsWith('<Link href="/profile"'));
  assert.match(profile, /onClick=\{\(\) => setOpen\(false\)\}/);
  assert.match(profile, /aria-current=\{pathname === "\/profile" \? "page" : undefined\}/);
  assert.match(profile, /<span>\{t\("profile\.title"\)\}<\/span>/);
  assert.match(profile, /<svg aria-hidden="true"/);
  assert.match(profile, /border px-4 py-2/);
  assert.match(profile, /focus-visible:outline-offset-2 focus-visible:outline-accent/);
  assert.match(profile, /border-accent bg-accent\/10 text-accent/);
  assert.match(profile, /hover:border-accent hover:bg-accent\/10/);
  for (const locale of ["en", "id"]) {
    const catalog = JSON.parse(source(`../i18n/${locale}/common.json`));
    assert.ok(catalog.profile.title && catalog.actions.signOut);
  }
});

test("account retains identity/role/language and exactly one official logout form without an alternate handler", () => {
  assert.match(account, /profileDisplayLabel\(fullName, email/);
  assert.match(account, /t\(`roles\.\$\{role\}`\)/);
  assert.match(account, /<LanguageSelector \/>/);
  assert.equal((navigation.match(/<form action=\{logoutAction\}/g) ?? []).length, 1);
  assert.equal((navigation.match(/t\("actions\.signOut"\)/g) ?? []).length, 1);
  assert.match(account, /<Button[^\n]*w-full[^\n]*variant="secondary" type="submit"/);
  assert.match(account, /t\("actions\.signOut"\)/);
  assert.doesNotMatch(account, /onClick[^\n]*(?:logout|signOut)|fetch\(|localStorage|logoutAction\(/);
  const button = source("../components/ui/button.tsx");
  assert.match(button, /text-text-primary hover:border-accent hover:text-accent/);
  assert.match(button, /focus-visible:outline-accent/);
});

test("sidebar account access does not alter role-gated navigation or approved route protection", () => {
  assert.match(navigation, /role === "admin"[\s\S]*key: "administration"/);
  assert.match(navigation, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(navigation, /\{open \? \(/);
  assert.match(navigation, /aria-expanded=\{open\}/);
  assert.doesNotMatch(account, /role ===|role !==|canOperateNetwork/);
  const layout = source("../app/(protected)/layout.tsx");
  assert.match(layout, /await requireApprovedProfile\(\)/);
  assert.match(layout, /min-w-0 md:pl-64/, "desktop content still reserves the existing sidebar width");
});
