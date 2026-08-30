import type { MetadataRoute } from "next";
import { env } from "../lib/env";

/**
 * Everything public here is meant to be read, indexed and linked. Only the
 * commissioner's pages and the admin API are closed — they are already behind
 * a password and `no-store`, but a crawler should not spend requests on them
 * either, and a 401 in someone's index is noise.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api/admin"] }],
    ...(env.siteDomain ? { sitemap: `https://${env.siteDomain}/sitemap.xml` } : {}),
  };
}
