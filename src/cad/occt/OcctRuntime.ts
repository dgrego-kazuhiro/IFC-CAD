// OpenCascade WASM runtime (lazy-loaded).
//
// 1.1.1 の opencascade.js は ~63MB の WASM を含むため、`getOcct()` で
// 初めて参照された瞬間に動的 import する。SSR 経由では呼ばないこと
// (Next.js の `'use client'` 配下からのみ呼ぶ前提)。
//
// すべての OCCT 利用 API はこのモジュール経由で取得し、初期化済み
// インスタンスを共有する。Worker 化はパフォーマンス上必要になった時点で
// この層に閉じて差し替え可能 (公開 API は `Promise<OcctInstance>`)。

export type OcctInstance = any;

let cachedPromise: Promise<OcctInstance> | null = null;

/**
 * 単一の OCCT インスタンスを返す (初回のみ非同期初期化)。
 */
export function getOcct(): Promise<OcctInstance> {
    if (cachedPromise) return cachedPromise;
    cachedPromise = (async () => {
        const mod = await import("opencascade.js");
        const init = (mod as any).initOpenCascade ?? (mod as any).default?.initOpenCascade;
        if (typeof init !== "function") {
            throw new Error("[OcctRuntime] initOpenCascade not found in opencascade.js export");
        }
        const oc = await init();
        return oc;
    })();
    cachedPromise.catch(() => { cachedPromise = null; });
    return cachedPromise;
}

/**
 * OCCT がすでに初期化済みなら返す。なければ null (sync 利用は不可)。
 */
export function peekOcct(): OcctInstance | null {
    if (!cachedPromise) return null;
    let value: OcctInstance | null = null;
    cachedPromise.then((v) => { value = v; });
    return value;
}

/**
 * テスト用: キャッシュを破棄。HMR の再ロード時にも内部的に呼ぶことがある。
 */
export function _resetOcct(): void {
    cachedPromise = null;
}
