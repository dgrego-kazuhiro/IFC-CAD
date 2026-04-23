// planegcs (FreeCAD GCS) のラッパー — WASM 非同期ロードを隠蔽する。
// 参照: docs/decisions/constraint_solver_choice.md
//
// ブラウザ内で一度だけ WASM をロードし、以降はキャッシュしたモジュールを再利用。
// 壁軸編集などリアルタイムパスで solver を呼ぶために、呼び出し側は
// `GcsBackend.isReady()` で同期的に状態を確認し、未初期化時はスキップできる。

import { make_gcs_wrapper, GcsWrapper } from "@salusoft89/planegcs";

const WASM_URL = "/planegcs.wasm";

let initPromise: Promise<void> | null = null;
let ready = false;

export class GcsBackend {
    public static ensureInitialized(): Promise<void> {
        if (ready) return Promise.resolve();
        if (!initPromise) {
            initPromise = (async () => {
                try {
                    // 1 回だけ wrapper を作って即 destroy することで WASM をロードさせる
                    const w = await make_gcs_wrapper(WASM_URL);
                    w.destroy_gcs_module();
                    ready = true;
                } catch (e) {
                    // ロード失敗時はフラグを倒しておく
                    initPromise = null;
                    ready = false;
                    throw e;
                }
            })();
        }
        return initPromise;
    }

    public static isReady(): boolean {
        return ready;
    }

    /** 1 回の solve のために新しい wrapper を作る（シンプルだが毎回 wasm heap を使う）*/
    public static async makeWrapper(): Promise<GcsWrapper> {
        await GcsBackend.ensureInitialized();
        return make_gcs_wrapper(WASM_URL);
    }
}
