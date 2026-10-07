import { saveOwnProfileNameAction } from "@/app/actions/profile";
import { MutationForm, PendingSubmit } from "@/components/ui/mutation-form";
import { getServerTranslation } from "@/i18n/server";
import { requireApprovedProfile } from "@/lib/auth";

export default async function ProfilePage() {
  const { profile } = await requireApprovedProfile();
  const { t, locale } = await getServerTranslation("common");
  const details = [
    [t("profile.email"), profile.email],
    [t("profile.uid"), profile.id],
    [t("profile.createdAt"), new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(profile.created_at))],
    [t("profile.role"), t(`roles.${profile.role}`)],
  ];
  return <main className="mx-auto w-full max-w-2xl p-4 md:p-6">
    <h1 className="text-title font-semibold">{t("profile.title")}</h1>
    <p className="mt-2 text-body text-text-secondary">{t("profile.description")}</p>
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
      <MutationForm action={saveOwnProfileNameAction} kind="update" className="grid gap-3">
        <label htmlFor="profile-name" className="text-body font-medium">{t("profile.name")}</label>
        <input id="profile-name" name="full_name" type="text" autoComplete="name" required maxLength={200}
          defaultValue={profile.full_name ?? ""} className="min-w-0 rounded-control border border-border bg-bg-base px-3 py-2 text-body" />
        <div><PendingSubmit>{t("profile.saveName")}</PendingSubmit></div>
      </MutationForm>
      <dl className="mt-6 grid gap-4 border-t border-border pt-4">
        {details.map(([label, value]) => <div key={label} className="min-w-0">
          <dt className="text-meta text-text-muted">{label}</dt>
          <dd className="mt-1 break-words text-body">{value}</dd>
        </div>)}
      </dl>
    </section>
  </main>;
}
