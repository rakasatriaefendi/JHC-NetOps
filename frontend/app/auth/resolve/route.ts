import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;

  if (error || !userId) {
    return privateRedirect(new URL("/login", requestUrl.origin));
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("status")
    .eq("id", userId)
    .maybeSingle<{ status: "pending" | "approved" | "rejected" }>();

  const destination = profile?.status === "approved" ? "/dashboard" : "/pending";
  return privateRedirect(new URL(destination, requestUrl.origin));
}

function privateRedirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
