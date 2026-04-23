import { Vec2 } from '../geometry/math/Vec2';
import { SnapInfo } from '../ui/tools/WallSketchState';

export class SnapManager {
    private snapRadius: number = 500; // Snap radius in millimeters typically

    constructor() {}

    public findSnap(point: Vec2): SnapInfo | undefined {
        // Very basic mock snap implementation for MVP
        // In real use case, iterate over walls, grids, intersections etc.
        const gridSize = 1000; 
        const snappedX = Math.round(point[0] / gridSize) * gridSize;
        const snappedY = Math.round(point[1] / gridSize) * gridSize;
        
        const dist = Math.sqrt(Math.pow(snappedX - point[0], 2) + Math.pow(snappedY - point[1], 2));
        
        if (dist <= this.snapRadius) {
            return {
                type: "Grid",
                point: [snappedX, snappedY],
                priority: 5
            };
        }
        
        return undefined;
    }
}
