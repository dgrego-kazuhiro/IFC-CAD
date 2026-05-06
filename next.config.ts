import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    // planegcs is an Emscripten bundle that contains both Node.js and browser
    // branches. Webpack tries to statically resolve the Node.js-only
    // `createRequire` / `fs` / `url.fileURLToPath(new URL("./", import.meta.url))`
    // calls, which fail in a browser build. The following webpack tweaks tell
    // Next.js to:
    //   1. Stub out Node built-ins for the client bundle.
    //   2. Not treat `new URL(..., import.meta.url)` as an asset reference.
    //   3. Enable top-level await and async WebAssembly.
    webpack: (config, { isServer }) => {
        if (!isServer) {
            config.resolve = {
                ...config.resolve,
                fallback: {
                    ...(config.resolve?.fallback ?? {}),
                    fs: false,
                    path: false,
                    module: false,
                    url: false,
                    crypto: false,
                    stream: false,
                },
            };
        }
        config.module = {
            ...config.module,
            parser: {
                ...config.module?.parser,
                javascript: {
                    ...(config.module?.parser?.javascript ?? {}),
                    url: false,
                },
            },
            // opencascade.js v1.x の `.wasm` (Emscripten 出力) を asset/resource
            // として吐き出す。webpack 5 の自動 asyncWebAssembly では中身を
            // 静的解析しようとして失敗するため、ここでは生バイナリ扱いにする。
            rules: [
                ...(config.module?.rules ?? []),
                {
                    test: /opencascade\.wasm\.wasm$/,
                    type: "asset/resource",
                    generator: {
                        filename: "static/wasm/[name][ext]",
                    },
                },
            ],
        };
        config.experiments = {
            ...config.experiments,
            asyncWebAssembly: true,
            topLevelAwait: true,
        };
        return config;
    },
};

export default nextConfig;
