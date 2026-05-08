import { WallSketchState, WallSketchSegment } from './WallSketchState';
import { Vec2 } from '../../geometry/math/Vec2';
import { SnapManager } from '../../snapping/SnapManager';
import { useAppState } from '../../application/AppState';
import { CreateWallCommand } from '../../commands/create/CreateWallCommand';
import { TransactionCommand } from '../../commands/composite/TransactionCommand';
import { WallSketchPreviewRunner } from './WallSketchPreview';
import { ElementId } from '../../model/base/ElementId';
import { Vec3 } from '../../geometry/math/Vec3';

export class WallSketchController {
    public state: WallSketchState;
    private snapManager: SnapManager;

    constructor() {
        this.snapManager = new SnapManager();
        this.state = this.getInitialState();
    }

    private getInitialState(): WallSketchState {
        return {
            mode: "Idle",
            plane: {
                origin: [0, 0, 0],
                xAxis: [1, 0, 0],
                yAxis: [0, 1, 0],
                normal: [0, 0, 1]
            },
            points: [],
            segments: [],
            options: {
                defaultThickness: 200,
                defaultHeight: 3000,
                locationLine: "Center",
                chainMode: true,
                orthoMode: false,
                angleSnapEnabled: true,
                angleSnapStepDeg: 15,
                autoJoinEnabled: true,
                trimExtendPreviewEnabled: true
            },
            constraints: {}
        };
    }

    public startSketch() {
        this.state.mode = "AwaitFirstPoint";
        this.state.points = [];
        this.state.segments = [];
        this.state.preview = undefined;
    }

    public onPointerMove(point: Vec2) {
        if (this.state.mode === "Idle" || this.state.mode === "Confirmed") return;

        const snap = this.snapManager.findSnap(point);
        const cursorPoint = snap ? snap.point : point;

        if (this.state.mode === "AwaitFirstPoint") {
            // Idle but previewing start pos
        } else if (this.state.mode === "AwaitNextPoint" || this.state.mode === "Previewing") {
            this.state.mode = "Previewing";
            
            if (this.state.options.orthoMode) {
                this.state.constraints.orthoActive = true;
                this.state.constraints.snappedAngle = undefined;
            } else if (this.state.options.angleSnapEnabled) {
                this.state.constraints.orthoActive = false;
                const startStr = this.state.points[this.state.points.length - 1];
                if (startStr) {
                    const dx = cursorPoint[0] - startStr[0];
                    const dy = cursorPoint[1] - startStr[1];
                    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
                    const step = this.state.options.angleSnapStepDeg;
                    this.state.constraints.snappedAngle = Math.round(angleDeg / step) * step;
                }
            } else {
                this.state.constraints.orthoActive = false;
                this.state.constraints.snappedAngle = undefined;
            }

            this.state.preview = WallSketchPreviewRunner.updatePreview(this.state, cursorPoint);
        }
    }

    public onPointerDown(point: Vec2) {
        if (this.state.mode === "Idle" || this.state.mode === "Cancelled" || this.state.mode === "Confirmed") return;

        const snap = this.snapManager.findSnap(point);
        const cursorPoint = snap ? snap.point : point;

        if (this.state.mode === "AwaitFirstPoint") {
            this.state.points.push(cursorPoint);
            this.state.mode = "AwaitNextPoint";
        } else if (this.state.mode === "Previewing" || this.state.mode === "AwaitNextPoint") {
            const preview = WallSketchPreviewRunner.updatePreview(this.state, cursorPoint);
            if (preview && preview.ghostSegments.length > 0) {
                const seg: WallSketchSegment = {
                    id: Math.random().toString(36).substring(7),
                    start: preview.currentStart!,
                    end: preview.currentEnd!,
                    inputType: this.state.options.chainMode ? "Polyline" : "TwoPoint",
                    snappedStart: this.state.points.length === 1 ? snap : undefined,
                    snappedEnd: snap
                };
                this.state.segments.push(seg);
                this.state.points.push(seg.end);

                if (!this.state.options.chainMode) {
                    this.finishSketch();
                } else {
                    this.state.mode = "AwaitNextPoint";
                    this.state.preview = undefined;
                }
            }
        }
    }

    public finishSketch() {
        if (this.state.segments.length > 0) {
            this.state.mode = "Confirmed";
            this.commitSegments();
        } else {
            this.state.mode = "Cancelled";
            this.state = this.getInitialState();
        }
    }

    public cancelSketch() {
        if (this.state.options.chainMode && this.state.segments.length > 0) {
            this.finishSketch();
        } else {
            this.state.mode = "Cancelled";
            this.state = this.getInitialState();
        }
    }

    private commitSegments() {
        const appState = useAppState.getState();
        const transaction = new TransactionCommand("Create Wall Sketch");
        const wallTypeId = appState.activeTypeIdByCategory.Wall;
        if (!wallTypeId) {
            console.warn("[WallSketchController] no active WallType");
            return;
        }

        for (const seg of this.state.segments) {
            // Simplified conversion from SketchPlane 2D to 3D for MVP (XY plane)
            const p1: Vec3 = [seg.start[0], seg.start[1], this.state.plane.origin[2]];
            const p2: Vec3 = [seg.end[0], seg.end[1], this.state.plane.origin[2]];

            const cmd = new CreateWallCommand(
                [p1, p2],
                wallTypeId as any,
                this.state.options.defaultHeight,
                Math.random().toString(36).substring(2, 11) as ElementId,
                undefined,
                { thickness: this.state.options.defaultThickness },
            );
            transaction.add(cmd);
        }

        appState.executeCommand(transaction);
        this.state = this.getInitialState();
    }
}
