import { WallSketchSegment, WallSketchState, WallSketchPreview } from './WallSketchState';
import { Vec2 } from '../../geometry/math/Vec2';

export class WallSketchPreviewRunner {
    public static updatePreview(
        state: WallSketchState,
        cursorCurrent: Vec2
    ): WallSketchPreview | undefined {
        if (state.mode === "Idle" || state.mode === "Cancelled") {
            return undefined;
        }

        const preview: WallSketchPreview = {
            ghostSegments: [],
            wallThicknessPreview: state.options.defaultThickness,
            locationLinePreview: state.options.locationLine
        };

        if (state.mode === "AwaitNextPoint" || state.mode === "Previewing" || state.mode === "NumericInput") {
            const startStr = state.points[state.points.length - 1];
            if (!startStr) return preview;
            
            let currentEnd = cursorCurrent;

            // Ortho mode constraint
            if (state.constraints.orthoActive) {
                const dx = currentEnd[0] - startStr[0];
                const dy = currentEnd[1] - startStr[1];
                if (Math.abs(dx) > Math.abs(dy)) {
                    currentEnd = [currentEnd[0], startStr[1]];
                } else {
                    currentEnd = [startStr[0], currentEnd[1]];
                }
            } 
            // Angle snap constraint
            else if (state.constraints.snappedAngle !== undefined) {
                const len = Math.sqrt(Math.pow(currentEnd[0] - startStr[0], 2) + Math.pow(currentEnd[1] - startStr[1], 2));
                const rad = state.constraints.snappedAngle * Math.PI / 180;
                currentEnd = [
                    startStr[0] + len * Math.cos(rad),
                    startStr[1] + len * Math.sin(rad)
                ];
            }

            const ghostSeg: WallSketchSegment = {
                id: "preview_segment",
                start: startStr,
                end: currentEnd,
                inputType: state.options.chainMode ? "Polyline" : "TwoPoint"
            };
            
            preview.currentStart = startStr;
            preview.currentEnd = currentEnd;
            preview.ghostSegments = [...state.segments, ghostSeg];
        }

        return preview;
    }
}
