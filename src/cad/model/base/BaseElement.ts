import { mat4 } from "gl-matrix";
import { ElementId } from "./ElementId";
import { ElementType } from "./ElementType";
import { DirtyFlags } from "./DirtyFlags";
import { Shape } from "../shapes/Shape";

export interface BaseElement {
    id: ElementId;
    type: ElementType;
    name?: string;
    visible: boolean;
    locked: boolean;
    transform: mat4;
    dirtyFlags: DirtyFlags;
    shape: Shape | null; // null initially until built
    /** 作成時タイムスタンプ (ms epoch)。重なり領域のピック優先度に使う:
     *  後から追加した要素ほど大きな値となり、ヒット候補の中で最も新しいものを
     *  選ぶことで「上に乗せた図形を優先」というレイヤ感覚の挙動を実現する。
     *  旧データには未設定 — 未設定要素は -Infinity 相当として扱う。 */
    createdAt?: number;
}
