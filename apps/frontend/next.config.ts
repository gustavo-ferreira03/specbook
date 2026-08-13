import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
    devIndicators: false,
    distDir: process.env.NEXT_DIST_DIR ?? ".next",
    outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
    webpack(config, { isServer }) {
        config.resolve.alias = {
            ...config.resolve.alias,
            "@": path.resolve(process.cwd(), "src"),
        };
        if (!isServer) config.output.environment = { ...config.output.environment, asyncFunction: true };
        return config;
    },
};

export default nextConfig;
