import { AuthCard } from "@/components/auth/auth-card";
import { RegisterForm } from "@/components/auth/register-form";
import { getServerTranslation } from "@/i18n/server";

export default async function RegisterPage() {
  const { t } = await getServerTranslation("auth");
  return (
    <AuthCard
      title={t("register.title")}
      description={t("register.description")}
      alternateHref="/login"
      alternateLabel={t("register.alternate")}
    >
      <RegisterForm />
    </AuthCard>
  );
}
