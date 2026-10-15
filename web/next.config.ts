import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `@electric-sql/pglite` carrega WASM e arquivos do disco — deixa o Next
   * resolvê-lo pelo Node em vez de empacotá-lo (senão o WASM não carrega).
   */
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
