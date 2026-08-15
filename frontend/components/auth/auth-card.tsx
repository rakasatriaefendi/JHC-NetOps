import Link from "next/link";
import type { ReactNode } from "react";

type AuthCardProps = {
  title: string;
  description: string;
  alternateHref: string;
  alternateLabel: string;
  children: ReactNode;
};

export function AuthCard({
  title,
  description,
  alternateHref,
  alternateLabel,
  children,
}: AuthCardProps) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <section className="w-full max-w-md rounded-panel border border-border bg-bg-surface p-6">
        <p className="text-meta font-medium uppercase tracking-wide text-accent">
          Network Monitoring
        </p>
        <h1 className="mt-3 text-heading font-semibold">{title}</h1>
        <p className="mt-2 text-text-secondary">{description}</p>

        <div className="mt-6">{children}</div>

        <p className="mt-6 border-t border-border pt-4 text-meta text-text-secondary">
          <Link className="font-medium text-accent hover:underline" href={alternateHref}>
            {alternateLabel}
          </Link>
        </p>
      </section>
    </main>
  );
}

