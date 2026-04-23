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
