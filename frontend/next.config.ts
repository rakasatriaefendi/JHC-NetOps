import type { NextConfig } from "next";
import { WEB_SECURITY_HEADERS } from "./lib/web-security";

const nextConfig: NextConfig = {
  async headers() { return [{ source: "/:path*", headers: WEB_SECURITY_HEADERS }]; },
};

export default nextConfig;

