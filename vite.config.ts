import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, ".", "VITE_");
    const proxyTarget = env.VITE_API_PROXY_TARGET;

    return {
        root: "web",
        server: {
            host: "0.0.0.0",
            port: 5173,
            proxy: proxyTarget
                ? {
                    "/api": proxyTarget,
                    "/healthz": proxyTarget
                }
                : undefined
        },
        build: {
            outDir: "../dist",
            emptyOutDir: true
        }
    };
});
