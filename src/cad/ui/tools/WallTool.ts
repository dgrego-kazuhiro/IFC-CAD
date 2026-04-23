import { WallSketchController } from './WallSketchController';
import { Vec2 } from '../../geometry/math/Vec2';

export class WallTool {
    public id = "WallTool";
    public controller: WallSketchController;

    constructor() {
        this.controller = new WallSketchController();
    }

    public activate() {
        this.controller.startSketch();
    }

    public deactivate() {
        this.controller.cancelSketch();
    }

    public onPointerMove(point: Vec2) {
        this.controller.onPointerMove(point);
    }

    public onPointerDown(point: Vec2) {
        this.controller.onPointerDown(point);
    }

    public onKeyDown(key: string) {
        if (key === "Escape") {
            this.controller.cancelSketch();
        } else if (key === "Enter") {
            this.controller.finishSketch();
        }
    }
}
