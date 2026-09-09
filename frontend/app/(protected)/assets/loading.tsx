import { getServerTranslation } from "@/i18n/server";

export default async function AssetsLoading() {
  const { t } = await getServerTranslation("assets");
  return <main className="p-4 md:p-6" aria-label={t("loading")}>
    <div className="h-4 w-28 animate-pulse rounded-control bg-border" />
    <div className="mt-3 h-8 w-56 max-w-full animate-pulse rounded-control bg-border" />
    <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div className="h-24 animate-pulse rounded-panel border border-border bg-bg-surface" key={index} />)}</div>
    <div className="mt-6 h-48 animate-pulse rounded-panel border border-border bg-bg-surface" />
  </main>;
}
