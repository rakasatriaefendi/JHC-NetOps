import type { ReactNode } from "react";

import { AppNavigation } from "@/components/app-navigation";
import { requireApprovedProfile } from "@/lib/auth";

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { profile } = await requireApprovedProfile();

  return (
    <div className="min-h-screen overflow-x-hidden">
      <AppNavigation
        fullName={profile.full_name ?? profile.email}
        role={profile.role}
      />
      <div className="min-w-0 md:pl-64">{children}</div>
    </div>
  );
}
