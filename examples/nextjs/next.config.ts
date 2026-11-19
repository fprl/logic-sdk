import type { NextConfig } from "next";

// examples/node ships its bookings domain as TypeScript source: let Next compile it.
const config: NextConfig = { transpilePackages: ["example-node"] };

export default config;
