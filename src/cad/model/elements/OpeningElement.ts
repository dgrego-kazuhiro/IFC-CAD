import { BaseElement } from "../base/BaseElement";
import { ElementId } from "../base/ElementId";

// 開口（穴）— wall に対するホスト要素として、ドア・窓のベースになる
export interface OpeningElement extends BaseElement {
    type: "Opening";
    hostWallId: ElementId;
    position: number; // 壁軸上の中心位置（0〜1）
    width: number;
    height: number;
    sillHeight: number; // 床からの高さ（窓の窓台高さ、ドアは 0）
}
