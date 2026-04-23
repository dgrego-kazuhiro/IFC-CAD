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
