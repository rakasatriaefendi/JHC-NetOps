"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAssetIdentityAction } from "@/app/actions/assets";
import type { AssetIdentityData } from "@/lib/asset-identity-contract";

export function AssetIdentityPanel({ assetId }: { assetId: string }) {
  const { t, i18n } = useTranslation("assets");
  const [result, setResult] = useState<{ data: AssetIdentityData | null; error: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    void getAssetIdentityAction(assetId).then((value) => { if (active) setResult(value); })
      .catch(() => { if (active) setResult({ data: null, error: "unavailable" }); });
    return () => { active = false; };
  }, [assetId]);
  const date = (value: string) => new Date(value).toLocaleString(i18n.language === "en" ? "en-US" : "id-ID");
  const data = result?.data;
  return <section className="mt-5 border-t border-border pt-4" aria-label={t("identity.title")}>
    <h3 className="font-medium">{t("identity.title")}</h3>
    <p className="mt-1 text-meta text-text-muted">{t("identity.help")}</p>
    {!result ? <p role="status" className="mt-3 text-meta">{t("identity.loading")}</p>
      : !data ? <p role="status" className="mt-3 text-meta">{t("identity.unavailable")}</p>
        : <><dl className="mt-3 grid gap-3 sm:grid-cols-2"><div className="min-w-0"><dt className="text-meta text-text-muted">{t("identity.canonicalId")}</dt><dd className="break-all font-data text-meta">{data.asset_id}</dd></div>
          <div><dt className="text-meta text-text-muted">{t("identity.stateLabel")}</dt><dd>{t(`identity.state.${data.identity_state}`)}</dd></div></dl>
          <h4 className="mt-4 text-meta font-medium">{t("identity.endpoints")}</h4>
          {data.endpoints.length ? <ul className="mt-2 space-y-2">{data.endpoints.map((row) => <li key={row.id} className="rounded-control border border-border p-3 text-meta">
            <span className="font-data">{row.ip_address}</span> · {t(`identity.endpointState.${row.state}`)} · {t(`identity.confidence.${row.confidence}`)}
            <p className="mt-1 break-words text-text-muted">{date(row.first_seen_at)} → {row.ended_at ? date(row.ended_at) : date(row.last_seen_at)} · {row.source}</p>
          </li>)}</ul> : <p className="mt-2 text-meta text-text-muted">{t("identity.noEndpoints")}</p>}
          <h4 className="mt-4 text-meta font-medium">{t("identity.evidence")}</h4>
          {data.evidence.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">{data.evidence.map((row, index) => <li key={`${row.evidence_type}-${index}`} className="min-w-0 rounded-control border border-border p-3 text-meta">
            {t(`identity.type.${row.evidence_type}`)} · {t(`identity.strength.${row.strength}`)}<p className="mt-1 break-all font-data">{row.normalized_value}</p><p className="text-text-muted">{row.source}</p>
          </li>)}</ul> : <p className="mt-2 text-meta text-text-muted">{t("identity.noEvidence")}</p>}
          {data.endpoints_truncated || data.evidence_truncated ? <p className="mt-3 text-meta text-text-muted">{t("identity.truncated")}</p> : null}</>}
  </section>;
}
