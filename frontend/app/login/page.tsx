import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { getServerTranslation } from "@/i18n/server";

export default async function LoginPage() {
  const { t } = await getServerTranslation("auth");
  return (
    <AuthCard
      title={t("login.title")}
      description={t("login.description")}
      alternateHref="/register"
      alternateLabel={t("login.alternate")}
    >
      <LoginForm />
    </AuthCard>
  );
}
