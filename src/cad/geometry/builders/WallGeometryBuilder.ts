import { WallElement } from "../../model/elements/WallElement";
import { Vec3 } from "../math/Vec3";
import { WallJoinResult } from "../../topology/joins/WallJoinResolver";

export interface WallGeometryData {
    footprint: [Vec3, Vec3, Vec3, Vec3]; // 4 corners [c0, c1, c2, c3]
    height: number;
}

export class WallGeometryBuilder {
    /**
     * Build wall footprint.
     * @param wall The wall element
     * @param joins Optional join results to override corners at Start/End
     */
    public static build(wall: WallElement, joins?: WallJoinResult[]): WallGeometryData {
        const [p1, p2] = wall.axis;
        const dx = p2[0] - p1[0];
        const dz = p2[2] - p1[2];
        const len = Math.sqrt(dx*dx + dz*dz) || 1;

        // Direction vector
        const dirX = dx / len;
        const dirZ = dz / len;

        // Normal vector (right side if looking from p1 to p2)
        const nx = -dirZ;
        const nz = dirX;

        // Calculate location line offset
        let offset = 0;
        switch (wall.locationLine) {
            case "Center":
            case "CoreCenter":
                offset = 0;
                break;
            case "FinishExterior":
                offset = wall.thickness / 2;
                break;
            case "FinishInterior":
                offset = -wall.thickness / 2;
                break;
        }

        // Apply thickness
        const halfT = wall.thickness / 2;

        // Base points shifted by location line
        const p1_offset: Vec3 = [p1[0] + nx * offset, p1[1] + wall.baseOffset, p1[2] + nz * offset];
        const p2_offset: Vec3 = [p2[0] + nx * offset, p2[1] + wall.baseOffset, p2[2] + nz * offset];

        // Default 4 corners of footprint
        // c0: p1 left (start-left),  c1: p1 right (start-right)
        // c2: p2 right (end-right),  c3: p2 left (end-left)
        let c0: Vec3 = [p1_offset[0] - nx * halfT, p1_offset[1], p1_offset[2] - nz * halfT];
        let c1: Vec3 = [p1_offset[0] + nx * halfT, p1_offset[1], p1_offset[2] + nz * halfT];
        let c2: Vec3 = [p2_offset[0] + nx * halfT, p2_offset[1], p2_offset[2] + nz * halfT];
        let c3: Vec3 = [p2_offset[0] - nx * halfT, p2_offset[1], p2_offset[2] - nz * halfT];

        // Apply join overrides
        if (joins) {
            for (const join of joins) {
                if (join.corners) {
                    const [left, right] = join.corners;
                    if (join.at === "Start") {
                        // c0 is -normal side, c1 is +normal side
                        // "left" = +normal side, "right" = -normal side
                        c0 = [right[0], c0[1], right[2]];
                        c1 = [left[0], c1[1], left[2]];
                    } else {
                        // c2 is +normal side, c3 is -normal side
                        c2 = [left[0], c2[1], left[2]];
                        c3 = [right[0], c3[1], right[2]];
                    }
                }
            }
        }

        return {
            footprint: [c0, c1, c2, c3],
            height: wall.height + wall.topOffset
        };
    }
}
