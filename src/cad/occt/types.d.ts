declare module "opencascade.js" {
    /**
     * OpenCascade runtime instance. Typed loosely as `any` because the v1.1.1
     * Emscripten bundle ships no `.d.ts`. Wrappers in `src/cad/occt/*` provide
     * narrower types for the sub-API we actually use.
     */
    export type OpenCascadeInstance = any;
    export function initOpenCascade(): Promise<OpenCascadeInstance>;
    const _default: { initOpenCascade: typeof initOpenCascade };
    export default _default;
}
