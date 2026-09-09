import adminEn from "@/i18n/en/admin.json";
import alertsEn from "@/i18n/en/alerts.json";
import assetsEn from "@/i18n/en/assets.json";
import authEn from "@/i18n/en/auth.json";
import commonEn from "@/i18n/en/common.json";
import dashboardEn from "@/i18n/en/dashboard.json";
import devicesEn from "@/i18n/en/devices.json";
import diagnosticsEn from "@/i18n/en/diagnostics.json";
import discoveryEn from "@/i18n/en/discovery.json";
import historyEn from "@/i18n/en/history.json";
import snmpEn from "@/i18n/en/snmp.json";
import trafficEn from "@/i18n/en/traffic.json";
import adminId from "@/i18n/id/admin.json";
import alertsId from "@/i18n/id/alerts.json";
import assetsId from "@/i18n/id/assets.json";
import authId from "@/i18n/id/auth.json";
import commonId from "@/i18n/id/common.json";
import dashboardId from "@/i18n/id/dashboard.json";
import devicesId from "@/i18n/id/devices.json";
import diagnosticsId from "@/i18n/id/diagnostics.json";
import discoveryId from "@/i18n/id/discovery.json";
import historyId from "@/i18n/id/history.json";
import snmpId from "@/i18n/id/snmp.json";
import trafficId from "@/i18n/id/traffic.json";

export const namespaces = ["common", "auth", "dashboard", "traffic", "history", "alerts", "devices", "snmp", "diagnostics", "discovery", "admin", "assets"] as const;
export type AppNamespace = (typeof namespaces)[number];

export const resources = {
  id: { common: commonId, auth: authId, dashboard: dashboardId, traffic: trafficId, history: historyId, alerts: alertsId, devices: devicesId, snmp: snmpId, diagnostics: diagnosticsId, discovery: discoveryId, admin: adminId, assets: assetsId },
  en: { common: commonEn, auth: authEn, dashboard: dashboardEn, traffic: trafficEn, history: historyEn, alerts: alertsEn, devices: devicesEn, snmp: snmpEn, diagnostics: diagnosticsEn, discovery: discoveryEn, admin: adminEn, assets: assetsEn },
} as const;
