import type { NextConfig } from "next";
import path from "node:path";
import { networkInterfaces } from "node:os";

const configuredPushLimit = Number.parseInt(process.env.SPECBOOK_GIT_MAX_PUSH_BYTES ?? "", 10);
const maxPushBytes = Number.isFinite(configuredPushLimit) && configuredPushLimit > 0 ? configuredPushLimit : 200 * 1024 * 1024;

const nextConfig: NextConfig = {
    devIndicators: false,
    allowedDevOrigins: ["localhost", "127.0.0.1", ...Object.values(networkInterfaces()).flatMap((entries) => entries?.map((entry) => entry.address) ?? [])],
    experimental: { proxyTimeout: 300_000, proxyClientMaxBodySize: maxPushBytes + 2 * 1024 * 1024 },
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
