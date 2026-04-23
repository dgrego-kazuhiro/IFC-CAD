import { Vec2 } from '../../geometry/math/Vec2';
import { Vec3 } from '../../geometry/math/Vec3';

export type WallLocationLine = "Center" | "FinishExterior" | "FinishInterior" | "CoreCenter";

export type WallSketchMode =
  | "Idle"
  | "AwaitFirstPoint"
  | "AwaitNextPoint"
  | "Previewing"
  | "NumericInput"
  | "Confirmed"
  | "Cancelled";

export type SnapType = 
    | "Endpoint" 
    | "Midpoint" 
    | "Intersection" 
    | "Grid" 
    | "Axis" 
    | "ExistingWallAxis" 
    | "ExistingWallFaceCenter" 
    | "ColumnCenter" 
    | "LevelReferenceLine";

export interface SnapInfo {
  type: SnapType;
  point: Vec2;
  sourceId?: string;
  priority: number;
}

export interface WallSketchSegment {
  id: string;
  start: Vec2;
  end: Vec2;
  inputType: "TwoPoint" | "DirectionLength" | "Polyline";
  lockedLength?: number;
  lockedAngle?: number;
  snappedStart?: SnapInfo;
  snappedEnd?: SnapInfo;
}

export interface WallSketchPreview {
  currentStart?: Vec2;
  currentEnd?: Vec2;
  ghostSegments: WallSketchSegment[];
  wallThicknessPreview: number;
  locationLinePreview: WallLocationLine;
}

export interface WallSketchOptions {
  defaultThickness: number;
  defaultHeight: number;
  locationLine: WallLocationLine;
  chainMode: boolean;
  orthoMode: boolean;
  angleSnapEnabled: boolean;
  angleSnapStepDeg: number;
  autoJoinEnabled: boolean;
  trimExtendPreviewEnabled: boolean;
}

export interface SketchPlane {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  normal: Vec3;
  levelId?: string;
}

export interface WallSketchConstraintState {
    orthoActive?: boolean;
    snappedAngle?: number;
}

export interface WallSketchState {
  mode: WallSketchMode;
  plane: SketchPlane;
  points: Vec2[];
  segments: WallSketchSegment[];
  preview?: WallSketchPreview;
  options: WallSketchOptions;
  constraints: WallSketchConstraintState;
}
