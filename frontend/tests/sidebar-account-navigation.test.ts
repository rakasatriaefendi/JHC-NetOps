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
  // At each desktop height, navigation alone scrolls when content overflows;
  // at <=480 CSS px (including 600 physical px at 125% zoom), shell owns scroll.
  const viewportCases = [600, 768, 900].flatMap((height) => [
    { height, zoom: 1, owner: "navigation" },
    { height, zoom: 1.25, owner: height / 1.25 <= 480 ? "shell" : "navigation" },
  ]);
  assert.deepEqual(viewportCases.map(({ owner }) => owner), [
    "navigation", "shell", "navigation", "navigation", "navigation", "navigation",
  ]);
  assert.equal(600 / 1.25, 480);
  for (const { owner } of viewportCases) {
    assert.match(shell, /h-full min-h-0/);
    assert.match(account, /shrink-0/);
    assert.match(account, /href="\/profile"/);
    assert.match(account, /<form action=\{logoutAction\}/);
    if (owner === "navigation") {
      assert.match(nav, /min-h-0 flex-1 flex-col[^\n]*overflow-y-auto/);
    } else {
      assert.match(shell, /overflow-y-auto/);
      assert.match(nav, /\[@media\(max-height:480px\)\]:flex-none/);
      assert.match(nav, /\[@media\(max-height:480px\)\]:overflow-visible/);
    }
  }
  assert.match(shell, /env\(safe-area-inset-top\)/);
  assert.match(shell, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(account, /max-h-|overflow-hidden/);
});

test("sidebar uses scoped dark scrollbars with Firefox and WebKit implementations", () => {
  const css = source("../app/globals.css");
  assert.match(shell, /sidebar-scrollbar/);
  assert.match(nav, /sidebar-scrollbar/);
  assert.match(css, /\.sidebar-scrollbar\s*\{[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-color:\s*#56616e transparent;/);
  assert.match(css, /\.sidebar-scrollbar::\-webkit-scrollbar\s*\{\s*width:\s*6px;\s*height:\s*6px;/);
  assert.match(css, /\.sidebar-scrollbar::\-webkit-scrollbar-track\s*\{\s*background:\s*transparent;/);
  assert.match(css, /\.sidebar-scrollbar::\-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#56616e;/);
  assert.match(css, /\.sidebar-scrollbar::\-webkit-scrollbar-thumb:hover\s*\{\s*background:\s*#7b8795;/);
  assert.doesNotMatch(css, /(?:^|\n)\s*(?:html|body|\*)\s*\{[^}]*scrollbar-/);
});

test("normal and very short viewports have one active scroll owner", () => {
  const shortRules = nav.slice(nav.indexOf("[@media(max-height:480px)]"));
  assert.match(shell, /overflow-y-auto/);
  assert.match(nav, /min-h-0 flex-1 flex-col[^\n]*overflow-y-auto/);
  assert.match(shortRules, /\[@media\(max-height:480px\)\]:flex-none/);
  assert.match(shortRules, /\[@media\(max-height:480px\)\]:overflow-visible/);
  assert.doesNotMatch(shortRules, /overflow-y-auto/);
  assert.ok(navigation.indexOf('data-sidebar="account"') > navigation.indexOf("</nav>"));
  assert.match(account, /shrink-0/);
});

test("scoped scrollbar leaves the main layout width and content styles untouched", () => {
  const css = source("../app/globals.css");
  const scoped = css.slice(css.indexOf(".sidebar-scrollbar {"));
  assert.doesNotMatch(scoped, /(?:^|\n)\s*(?:main|body|html|\*)\s*\{/);
  const layout = source("../app/(protected)/layout.tsx");
  assert.match(layout, /min-w-0 md:pl-64/);
  assert.doesNotMatch(layout, /sidebar-scrollbar/);
});

test("forced-colors mode restores system scrollbar colors", () => {
  const css = source("../app/globals.css");
  const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
  assert.match(forced, /\.sidebar-scrollbar\s*\{[^}]*forced-color-adjust:\s*auto;[^}]*scrollbar-color:\s*auto;/);
  assert.match(forced, /::-webkit-scrollbar-track\s*\{\s*background:\s*Canvas;/);
  assert.match(forced, /::-webkit-scrollbar-thumb,[\s\S]*?background:\s*ButtonText;/);
});

test("mobile drawer preserves the short-height shell fallback, safe area, and reachable account controls", () => {
  assert.match(navigation, /<aside className="relative h-full min-h-0 w-64 max-w-full border-r border-border">/);
  assert.match(navigation, /fixed inset-0 z-50 h-dvh md:hidden/);
  assert.match(shell, /overflow-y-auto sidebar-scrollbar/);
  assert.match(shell, /pt-\[max\(1rem,env\(safe-area-inset-top\)\)\]/);
  assert.match(shell, /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/);
  assert.ok(navigation.indexOf('data-sidebar="account"') > navigation.indexOf("</nav>"));
  assert.match(account, /href="\/profile"/);
  assert.match(account, /<form action=\{logoutAction\}/);
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
  assert.match(navigation, /const groups = role === "admin"[\s\S]*: navigation;/,
    "Admin keeps its administration link and Operator/Viewer share the existing navigation list");
  assert.match(navigation, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(navigation, /\{open \? \(/);
  assert.match(navigation, /aria-expanded=\{open\}/);
  assert.doesNotMatch(account, /role ===|role !==|canOperateNetwork/);
  const layout = source("../app/(protected)/layout.tsx");
  assert.match(layout, /await requireApprovedProfile\(\)/);
  assert.match(layout, /min-w-0 md:pl-64/, "desktop content still reserves the existing sidebar width");
});
