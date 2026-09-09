import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createInstance } from "i18next";

import {
  defaultLanguage,
  fallbackLanguage,
  isAppLanguage,
  languageCookieName,
  localeForLanguage,
  supportedLanguages,
} from "../i18n/config.ts";
import { formatDateTime } from "../lib/managed-telemetry.ts";

const readCatalog = (language: "id" | "en", namespace: string) =>
  JSON.parse(readFileSync(new URL(`../i18n/${language}/${namespace}.json`, import.meta.url), "utf8"));

test("i18n supports exactly Indonesian and English with the required defaults", () => {
  assert.deepEqual([...supportedLanguages], ["id", "en"]);
  assert.equal(defaultLanguage, "id");
  assert.equal(fallbackLanguage, "en");
  assert.equal(languageCookieName, "jhc-netops-language");
  assert.equal(isAppLanguage("id"), true);
  assert.equal(isAppLanguage("en"), true);
  assert.equal(isAppLanguage("fr"), false);
});

test("representative Indonesian and English catalog copy switches visibly", async () => {
  const resources = {
    id: { common: readCatalog("id", "common"), snmp: readCatalog("id", "snmp") },
    en: { common: readCatalog("en", "common"), snmp: readCatalog("en", "snmp") },
  };
  const instance = createInstance();
  await instance.init({ lng: "id", fallbackLng: "en", resources, ns: ["common", "snmp"], defaultNS: "common", initAsync: false });
  assert.equal(instance.t("nav.devices"), "Perangkat");
  assert.equal(instance.t("nav.networkOperations"), "Operasi jaringan");
  assert.equal(instance.t("observed.searchLabel", { ns: "snmp" }), "Cari host terpantau");
  await instance.changeLanguage("en");
  assert.equal(instance.t("nav.devices"), "Devices");
  assert.equal(instance.t("nav.networkOperations"), "Network operations");
  assert.equal(instance.t("observed.searchLabel", { ns: "snmp" }), "Search observed hosts");
});

test("fallback uses English and runtime network values remain byte-for-byte intact", async () => {
  const instance = createInstance();
  await instance.init({
    lng: "id",
    fallbackLng: "en",
    resources: { id: { test: {} }, en: { test: { fallback: "English fallback", runtime: "Target {{value}}" } } },
    ns: ["test"],
    defaultNS: "test",
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  assert.equal(instance.t("fallback"), "English fallback");
  for (const value of ["192.168.1.8", "AA:BB:CC:DD:EE:FF", "kali-snmp-lab", "1.3.6.1.2.1.1.5.0"]) {
    assert.equal(instance.t("runtime", { value }), `Target ${value}`);
  }
});

test("locale helpers select id-ID and en-US without changing stored timestamps", () => {
  const timestamp = "2026-09-07T08:09:10.000Z";
  assert.equal(localeForLanguage("id"), "id-ID");
  assert.equal(localeForLanguage("en"), "en-US");
  assert.equal(formatDateTime(timestamp, "id"), new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp)));
  assert.equal(formatDateTime(timestamp, "en"), new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp)));
  assert.equal(timestamp, "2026-09-07T08:09:10.000Z");
});

test("language persistence and client/server refresh wiring remain allow-listed", () => {
  const action = readFileSync(new URL("../app/actions/language.ts", import.meta.url), "utf8");
  const selector = readFileSync(new URL("../components/language-selector.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../i18n/server.ts", import.meta.url), "utf8");
  assert.match(action, /isAppLanguage\(language\)/);
  assert.match(action, /languageCookieName/);
  assert.match(selector, /i18n\.changeLanguage\(next\)/);
  assert.match(selector, /router\.refresh\(\)/);
  assert.match(server, /createInstance\(\)/);
  assert.doesNotMatch(server, /const\s+i18n\s*=\s*createInstance/);
});

test("all namespaces have valid paired local catalogs", () => {
  const namespaces = ["common", "auth", "dashboard", "traffic", "history", "alerts", "devices", "snmp", "diagnostics", "admin", "assets"];
  for (const namespace of namespaces) {
    assert.equal(typeof readCatalog("id", namespace), "object");
    assert.equal(typeof readCatalog("en", namespace), "object");
  }
});
