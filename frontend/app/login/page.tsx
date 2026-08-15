import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return (
    <AuthCard
      title="Masuk"
      description="Gunakan akun yang sudah terdaftar untuk membuka dashboard."
      alternateHref="/register"
      alternateLabel="Belum punya akun? Daftar"
    >
      <LoginForm />
    </AuthCard>
  );
}

