"use client";

import { createContext, useContext, type ReactNode } from "react";

export type ApplicationAuthority = "local_postgres";

type AuthorityContextValue = {
  authority: ApplicationAuthority;
};

const AuthorityContext = createContext<AuthorityContextValue | null>(null);

export function AppAuthorityProvider({ children, authority }: { children: ReactNode; authority: ApplicationAuthority }) {
  return <AuthorityContext.Provider value={{ authority }}>{children}</AuthorityContext.Provider>;
}

export function useApplicationAuthority(): ApplicationAuthority {
  const context = useContext(AuthorityContext);
  if (!context) {
    throw new Error("useApplicationAuthority must be used within AppAuthorityProvider");
  }
  return context.authority;
}
