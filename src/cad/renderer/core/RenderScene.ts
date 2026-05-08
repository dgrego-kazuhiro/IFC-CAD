import { ElementId } from "../../model/base/ElementId";
import { MeshData } from "../../mesh/MeshData";
import { mat4 } from "gl-matrix";

export interface RenderObject {
    id: ElementId;
    mesh: MeshData;
    transform: mat4;
    visible: boolean;
    color: [number, number, number, number]; // RGBA
    /**
     * Render in the "always on top" overlay pass. Ignores depth and alpha-
     * blends over the regular scene. Used for 2D sketch lines / selection
     * markers that must never be occluded by 3D walls or other geometry.
     */
    overlay?: boolean;
    /**
     * Render with `cullMode: "none"` (no back-face culling) but the regular
     * depth test/write. Used for thin double-sided geometry like door / window
     * panels where the panel orientation depends on the host wall direction
     * and may not consistently face outward — without this, half the
     * windows of a rectangular room render invisibly because their winding
     * is back-facing for the current camera angle.
     */
    noCull?: boolean;
    /**
     * 円筒 (= 円形 polygon の壁) の見た目を完全に滑らかに保つためのヒント。
     * これが指定されていると、フラグメントシェーダは補間された頂点法線を
     * 使わず、`(worldPos - cylinderCenter)` から **位置ベースの放射方向**
     * を計算して法線として使う。これにより 24-segment ポリゴンプリズムでも
     * 「真円柱の Lambertian 陰影」のように滑らかな輝度勾配で描画される
     * (chord ファセットや対角補間アーティファクトが完全に消える)。
     * 内側面 (中心向き) と外側面 (外向き) の判別は元の頂点法線との dot 符号で
     * 自動判定する。
     */
    cylinderCenter?: [number, number, number];
}

export class RenderScene {
    private objects = new Map<ElementId, RenderObject>();

    public addObject(obj: RenderObject) {
        this.objects.set(obj.id, obj);
    }

    public removeObject(id: ElementId) {
        this.objects.delete(id);
    }

    public getObject(id: ElementId) {
        return this.objects.get(id);
    }

    public getObjects(): RenderObject[] {
        return Array.from(this.objects.values());
    }

    public clear() {
        this.objects.clear();
    }
}
