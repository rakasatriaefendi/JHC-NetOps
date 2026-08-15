import { AuthCard } from "@/components/auth/auth-card";
import { RegisterForm } from "@/components/auth/register-form";

export default function RegisterPage() {
  return (
    <AuthCard
      title="Daftar akun"
      description="Akun baru harus disetujui admin sebelum dapat membaca data jaringan."
      alternateHref="/login"
      alternateLabel="Sudah punya akun? Masuk"
    >
      <RegisterForm />
    </AuthCard>
  );
}

