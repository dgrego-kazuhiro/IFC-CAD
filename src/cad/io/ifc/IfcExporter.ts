/**
 * 簡易 IFC2X3 エクスポーター。
 *
 * 出力する内容:
 *  - IfcProject / IfcSite / IfcBuilding / IfcBuildingStorey (Level ごと)
 *  - 各 WallElement → IfcWallStandardCase (フットプリントを垂直押し出し)
 *  - 各 SpaceElement の各ポリゴン → IfcSpace
 *
 * 単位は m (IFCSIUNIT METRE)。座標系は World と同一に置く:
 *  - IFC X = World X
 *  - IFC Y = World Z (= 床平面の第 2 軸)
 *  - IFC Z = World Y (= 鉛直方向、storey の elevation はここに乗る)
 *
 * 壁は computeWallHexagon が出した 6 頂点の hex フットプリントを用いる
 * (polyRef がある場合)。無い場合は axis + thickness の矩形フットプリント
 * にフォールバック。
 *
 * 略している項目: 開口 (door/window)、材料、property set、ownerHistory の
 * 詳細メタ。これらは追加要件があれば後段で。
 */

import { AppState } from "../../application/AppState";
import { WallElement } from "../../model/elements/WallElement";
import { SpaceElement, RoomPolygon } from "../../model/elements/SpaceElement";
import { OpeningElement } from "../../model/elements/OpeningElement";
import { DoorElement } from "../../model/elements/DoorElement";
import { WindowElement } from "../../model/elements/WindowElement";
import { computeWallHexagon, ensureCCW } from "../../geometry/wall/EdgeGeometry";
import { Vec2 } from "../../geometry/math/Vec2";
import { BaseElement } from "../../model/base/BaseElement";

// ─── helpers ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
    if (Object.is(n, -0)) n = 0;
    if (!Number.isFinite(n)) return "0.";
    if (Number.isInteger(n)) return `${n}.`;
    return n.toString();
}

function makeGuid(): string {
    // IFC GlobalId: 22-char base64 ([0-9A-Za-z_$])
    const chars =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
    let s = "";
    for (let i = 0; i < 22; i++) s += chars[Math.floor(Math.random() * 64)];
    return s;
}

function escapeIfc(s: string): string {
    // 簡易: IFC STEP の string は ' で囲み、内部の ' を '' でエスケープ。
    // バックスラッシュは \\X\... 制御シーケンス用なので二重化。
    return s.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

// ─── writer ────────────────────────────────────────────────────────────────

class IfcWriter {
    private idCounter = 1;
    private entities: string[] = [];

    add(body: string): string {
        const id = `#${this.idCounter++}`;
        this.entities.push(`${id}= ${body};`);
        return id;
    }

    serialize(filename: string): string {
        const now = new Date().toISOString().slice(0, 19);
        const header = [
            "ISO-10303-21;",
            "HEADER;",
            "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
            `FILE_NAME('${filename}','${now}',(''),(''),'IFC-CAD','IFC-CAD','');`,
            "FILE_SCHEMA(('IFC2X3'));",
            "ENDSEC;",
            "DATA;",
        ];
        const footer = ["ENDSEC;", "END-ISO-10303-21;"];
        return [...header, ...this.entities, ...footer].join("\n");
    }
}

// ─── footprint helper ─────────────────────────────────────────────────────

/** 壁の 2D フットプリント (X-Z 平面で CCW)。polyRef があれば hex、無ければ
 *  axis + thickness の矩形にフォールバック。 */
function wallFootprint2D(
    wall: WallElement,
    elements: Record<string, BaseElement>,
): Vec2[] | null {
    if (wall.polyRef) {
        const sp = elements[wall.polyRef.spaceId];
        if (!sp || sp.type !== "Space") return null;
        const poly = (sp as SpaceElement).polygons?.find(
            (p) => p.id === wall.polyRef!.polyId,
        );
        if (!poly) return null;
        const polygonLookup = (id: string): RoomPolygon | undefined => {
            for (const eid in elements) {
                const e = elements[eid];
                if (!e || e.type !== "Space") continue;
                const found = (e as SpaceElement).polygons?.find((p) => p.id === id);
                if (found) return found;
            }
            return undefined;
        };
        const hex = computeWallHexagon(poly, wall.polyRef.edgeIdx, polygonLookup);
        if (!hex) return null;
        return hex.vertices.map((v) => [v[0], v[1]] as Vec2);
    }

    // Legacy rect from axis + thickness
    const [p1, p2] = wall.axis;
    const dx = p2[0] - p1[0];
    const dz = p2[2] - p1[2];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return null;
    const dirX = dx / len, dirZ = dz / len;
    const nx = -dirZ, nz = dirX;
    const halfT = wall.thickness / 2;
    return [
        [p1[0] - nx * halfT, p1[2] - nz * halfT],
        [p1[0] + nx * halfT, p1[2] + nz * halfT],
        [p2[0] + nx * halfT, p2[2] + nz * halfT],
        [p2[0] - nx * halfT, p2[2] - nz * halfT],
    ];
}

// ─── main exporter ─────────────────────────────────────────────────────────

export function exportIfc(state: AppState): string {
    const w = new IfcWriter();

    // ── Common entities ────────────────────────────────────────────────
    const person = w.add(`IFCPERSON($,'IFCCAD','User',$,$,$,$,$)`);
    const org = w.add(`IFCORGANIZATION($,'IFC-CAD','',$,$)`);
    const personOrg = w.add(`IFCPERSONANDORGANIZATION(${person},${org},$)`);
    const app = w.add(`IFCAPPLICATION(${org},'1.0','IFC-CAD','IFC-CAD')`);
    const ownerHistory = w.add(
        `IFCOWNERHISTORY(${personOrg},${app},$,.NOTDEFINED.,$,$,$,${Math.floor(Date.now() / 1000)})`,
    );

    // Units
    const lenUnit = w.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
    const areaUnit = w.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
    const volUnit = w.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
    const angleUnit = w.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`);
    const unitAssignment = w.add(
        `IFCUNITASSIGNMENT((${lenUnit},${areaUnit},${volUnit},${angleUnit}))`,
    );

    // World coordinate system (default IFC: Z up, X forward).
    const wcsOrigin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
    const wcsPlacement = w.add(`IFCAXIS2PLACEMENT3D(${wcsOrigin},$,$)`);

    const geomContext = w.add(
        `IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${wcsPlacement},$)`,
    );

    // Project
    const project = w.add(
        `IFCPROJECT('${makeGuid()}',${ownerHistory},'IFC-CAD Project',$,$,$,$,(${geomContext}),${unitAssignment})`,
    );

    // Site / Building
    const sitePlacement = w.add(`IFCLOCALPLACEMENT($,${wcsPlacement})`);
    const site = w.add(
        `IFCSITE('${makeGuid()}',${ownerHistory},'Site',$,$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`,
    );
    const buildingPlacement = w.add(
        `IFCLOCALPLACEMENT(${sitePlacement},${wcsPlacement})`,
    );
    const building = w.add(
        `IFCBUILDING('${makeGuid()}',${ownerHistory},'Building',$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`,
    );
    w.add(
        `IFCRELAGGREGATES('${makeGuid()}',${ownerHistory},$,$,${project},(${site}))`,
    );
    w.add(
        `IFCRELAGGREGATES('${makeGuid()}',${ownerHistory},$,$,${site},(${building}))`,
    );

    // ── Storeys (= Levels) ────────────────────────────────────────────
    interface StoreyRec { id: string; placement: string; }
    const storeyMap = new Map<string, StoreyRec>();
    const storeyIds: string[] = [];
    for (const lvl of state.levels) {
        const ptId = w.add(`IFCCARTESIANPOINT((0.,0.,${fmt(lvl.elevation)}))`);
        const ax = w.add(`IFCAXIS2PLACEMENT3D(${ptId},$,$)`);
        const placement = w.add(`IFCLOCALPLACEMENT(${buildingPlacement},${ax})`);
        const storey = w.add(
            `IFCBUILDINGSTOREY('${makeGuid()}',${ownerHistory},'${escapeIfc(lvl.name)}',$,$,${placement},$,$,.ELEMENT.,${fmt(lvl.elevation)})`,
        );
        storeyMap.set(lvl.id as string, { id: storey, placement });
        storeyIds.push(storey);
    }
    if (storeyIds.length > 0) {
        w.add(
            `IFCRELAGGREGATES('${makeGuid()}',${ownerHistory},$,$,${building},(${storeyIds.join(",")}))`,
        );
    }

    const fallbackStoreyKey = (state.levels[0]?.id as string | undefined) ?? "";

    // ── Walls ────────────────────────────────────────────────────────
    const wallsByStorey = new Map<string, string[]>();
    for (const elId in state.elements) {
        const el = state.elements[elId];
        if (!el || el.type !== "Wall") continue;
        const wall = el as WallElement;
        const lvlKey = (wall.baseLevelId as string | undefined) ?? fallbackStoreyKey;
        const storey = storeyMap.get(lvlKey);
        if (!storey) continue;

        const fp = wallFootprint2D(wall, state.elements);
        if (!fp || fp.length < 3) continue;
        const ccw = ensureCCW(fp);

        const ptIds = ccw.map((p) =>
            w.add(`IFCCARTESIANPOINT((${fmt(p[0])},${fmt(p[1])}))`),
        );
        ptIds.push(ptIds[0]); // close ring
        const polyline = w.add(`IFCPOLYLINE((${ptIds.join(",")}))`);
        const profile = w.add(
            `IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${polyline})`,
        );

        const localOrigin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
        const localAxis = w.add(`IFCAXIS2PLACEMENT3D(${localOrigin},$,$)`);
        const wallPlacement = w.add(
            `IFCLOCALPLACEMENT(${storey.placement},${localAxis})`,
        );

        const extrudeDir = w.add(`IFCDIRECTION((0.,0.,1.))`);
        const extrude = w.add(
            `IFCEXTRUDEDAREASOLID(${profile},${localAxis},${extrudeDir},${fmt(wall.height)})`,
        );

        const shapeRep = w.add(
            `IFCSHAPEREPRESENTATION(${geomContext},'Body','SweptSolid',(${extrude}))`,
        );
        const productShape = w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}))`);

        const wallName = escapeIfc(
            wall.name || `Wall_${(wall.id as string).slice(0, 6)}`,
        );
        const wallEntity = w.add(
            `IFCWALLSTANDARDCASE('${makeGuid()}',${ownerHistory},'${wallName}',$,$,${wallPlacement},${productShape},$)`,
        );

        const arr = wallsByStorey.get(storey.id) ?? [];
        arr.push(wallEntity);
        wallsByStorey.set(storey.id, arr);

        // ── Openings (door / window holes) on this wall ────────────────
        // wall.openings[] には OpeningElement.id が並ぶ。各 opening を
        // IfcOpeningElement として吐き、IfcRelVoidsElement で wall に紐付け。
        // 対応する DoorElement / WindowElement があれば IfcDoor / IfcWindow を
        // 出して IfcRelFillsElement で opening と紐付ける。
        for (const opId of wall.openings ?? []) {
            const op = state.elements[opId as string] as OpeningElement | undefined;
            if (!op || op.type !== "Opening") continue;
            const openingEntity = emitOpening(
                w, wall, op, wallPlacement, geomContext, ownerHistory,
            );
            if (!openingEntity) continue;
            // RelVoidsElement: wall ← (voids) → opening
            w.add(
                `IFCRELVOIDSELEMENT('${makeGuid()}',${ownerHistory},$,$,${wallEntity},${openingEntity})`,
            );

            // 対応する Door / Window を探して fill する
            const filler = findFillerForOpening(opId as string, state.elements);
            if (filler) {
                const fillerEntity = emitDoorOrWindow(
                    w, wall, op, filler, wallPlacement, geomContext, ownerHistory,
                );
                if (fillerEntity) {
                    w.add(
                        `IFCRELFILLSELEMENT('${makeGuid()}',${ownerHistory},$,$,${openingEntity},${fillerEntity})`,
                    );
                }
            }
        }
    }

    // ── Spaces ───────────────────────────────────────────────────────
    const spacesByStorey = new Map<string, string[]>();
    for (const elId in state.elements) {
        const el = state.elements[elId];
        if (!el || el.type !== "Space") continue;
        const space = el as SpaceElement;
        const lvlKey = (space.levelId as string | undefined) ?? fallbackStoreyKey;
        const storey = storeyMap.get(lvlKey);
        if (!storey) continue;

        for (const poly of space.polygons ?? []) {
            if (poly.wallOutlineOf) continue;
            if (poly.outer.length < 3) continue;
            const ccw = ensureCCW(poly.outer);

            const ptIds = ccw.map((p) =>
                w.add(`IFCCARTESIANPOINT((${fmt(p[0])},${fmt(p[1])}))`),
            );
            ptIds.push(ptIds[0]);
            const polyline = w.add(`IFCPOLYLINE((${ptIds.join(",")}))`);
            const profile = w.add(
                `IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${polyline})`,
            );

            const localOrigin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
            const localAxis = w.add(`IFCAXIS2PLACEMENT3D(${localOrigin},$,$)`);
            const spacePlacement = w.add(
                `IFCLOCALPLACEMENT(${storey.placement},${localAxis})`,
            );

            const extrudeDir = w.add(`IFCDIRECTION((0.,0.,1.))`);
            const height = space.height && space.height > 0 ? space.height : 3.0;
            const extrude = w.add(
                `IFCEXTRUDEDAREASOLID(${profile},${localAxis},${extrudeDir},${fmt(height)})`,
            );

            const shapeRep = w.add(
                `IFCSHAPEREPRESENTATION(${geomContext},'Body','SweptSolid',(${extrude}))`,
            );
            const productShape = w.add(
                `IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}))`,
            );

            const spaceName = escapeIfc(
                space.name || `Space_${(space.id as string).slice(0, 6)}`,
            );
            const spaceEntity = w.add(
                `IFCSPACE('${makeGuid()}',${ownerHistory},'${spaceName}',$,$,${spacePlacement},${productShape},$,.ELEMENT.,.INTERNAL.,$)`,
            );

            const arr = spacesByStorey.get(storey.id) ?? [];
            arr.push(spaceEntity);
            spacesByStorey.set(storey.id, arr);
        }
    }

    // ── Containment relationships ────────────────────────────────────
    for (const [storey, items] of wallsByStorey) {
        w.add(
            `IFCRELCONTAINEDINSPATIALSTRUCTURE('${makeGuid()}',${ownerHistory},$,$,(${items.join(",")}),${storey})`,
        );
    }
    for (const [storey, items] of spacesByStorey) {
        // Spaces are aggregated under storey (IFC2X3 convention).
        w.add(
            `IFCRELAGGREGATES('${makeGuid()}',${ownerHistory},$,$,${storey},(${items.join(",")}))`,
        );
    }

    return w.serialize("export.ifc");
}

// ─── opening / door / window helpers ──────────────────────────────────────

/** Wall に紐付く `OpeningElement` を直方体の `IfcOpeningElement` として吐く。
 *  座標系はワールド (= storey-local 同等) で配置し、
 *  - 高さ方向 = IFC +Z (= world +Y)
 *  - 幅方向   = wall.axis 方向 (IFC X-Y 平面内のベクトル)
 *  - 厚み方向 = wall axis に垂直
 *
 *  穴は壁を確実に貫通させるため、厚み方向に `wall.thickness * 1.2` の
 *  マージンを取る (両側 +10%)。 */
function emitOpening(
    w: IfcWriter,
    wall: WallElement,
    op: OpeningElement,
    wallPlacement: string,
    geomContext: string,
    ownerHistory: string,
): string | null {
    const [a0, a1] = wall.axis;
    const dx = a1[0] - a0[0];
    const dz = a1[2] - a0[2];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return null;
    const ux = dx / len, uz = dz / len; // axis direction (IFC X-Y plane)

    // 中心座標 (世界 X-Z + sillHeight 上の高さ → IFC X, Y, Z)
    const cx = a0[0] + op.position * (a1[0] - a0[0]);
    const cy = a0[2] + op.position * (a1[2] - a0[2]);
    const cz = op.sillHeight; // base of opening box (IFC Z)

    // 矩形プロファイル (axis-local: 横 = width, 縦 = thickness*1.2)
    const halfW = op.width / 2;
    const halfD = (wall.thickness / 2) * 1.2;
    const profilePts: Vec2[] = [
        [-halfW, -halfD],
        [ halfW, -halfD],
        [ halfW,  halfD],
        [-halfW,  halfD],
    ];
    const ptIds = profilePts.map((p) =>
        w.add(`IFCCARTESIANPOINT((${fmt(p[0])},${fmt(p[1])}))`),
    );
    ptIds.push(ptIds[0]);
    const polyline = w.add(`IFCPOLYLINE((${ptIds.join(",")}))`);
    const profile = w.add(
        `IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${polyline})`,
    );

    // 配置: 中心 (cx, cy, cz) で、X 軸 = wall axis 方向。
    const locOrigin = w.add(
        `IFCCARTESIANPOINT((${fmt(cx)},${fmt(cy)},${fmt(cz)}))`,
    );
    const locZ = w.add(`IFCDIRECTION((0.,0.,1.))`);
    const locX = w.add(`IFCDIRECTION((${fmt(ux)},${fmt(uz)},0.))`);
    const placeAxis = w.add(`IFCAXIS2PLACEMENT3D(${locOrigin},${locZ},${locX})`);
    // Wall を host とした placement (RelVoids で void 関係を張る)
    const opPlacement = w.add(`IFCLOCALPLACEMENT(${wallPlacement},${placeAxis})`);

    // Extrude direction = +Z (vertical). Extrusion 自身は profile 平面の +Z。
    const extOrigin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
    const extAxis = w.add(`IFCAXIS2PLACEMENT3D(${extOrigin},$,$)`);
    const extDir = w.add(`IFCDIRECTION((0.,0.,1.))`);
    const extrude = w.add(
        `IFCEXTRUDEDAREASOLID(${profile},${extAxis},${extDir},${fmt(op.height)})`,
    );

    const shapeRep = w.add(
        `IFCSHAPEREPRESENTATION(${geomContext},'Body','SweptSolid',(${extrude}))`,
    );
    const productShape = w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}))`);

    return w.add(
        `IFCOPENINGELEMENT('${makeGuid()}',${ownerHistory},'Opening',$,$,${opPlacement},${productShape},$)`,
    );
}

/** Opening を埋める Door / Window を出す。形状は Opening と同じ直方体を流用
 *  (wall の厚みは width × thickness の panel で塞ぐ)。Filler の place は
 *  opening と同じ axis2placement に乗る。 */
function emitDoorOrWindow(
    w: IfcWriter,
    wall: WallElement,
    op: OpeningElement,
    filler: DoorElement | WindowElement,
    wallPlacement: string,
    geomContext: string,
    ownerHistory: string,
): string | null {
    const [a0, a1] = wall.axis;
    const dx = a1[0] - a0[0];
    const dz = a1[2] - a0[2];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) return null;
    const ux = dx / len, uz = dz / len;

    const cx = a0[0] + op.position * (a1[0] - a0[0]);
    const cy = a0[2] + op.position * (a1[2] - a0[2]);
    const cz = op.sillHeight;

    // Filler 自身は wall.thickness と同じ厚みのスラブで塞ぐ。
    const halfW = filler.width / 2;
    const halfD = wall.thickness / 2;
    const profilePts: Vec2[] = [
        [-halfW, -halfD],
        [ halfW, -halfD],
        [ halfW,  halfD],
        [-halfW,  halfD],
    ];
    const ptIds = profilePts.map((p) =>
        w.add(`IFCCARTESIANPOINT((${fmt(p[0])},${fmt(p[1])}))`),
    );
    ptIds.push(ptIds[0]);
    const polyline = w.add(`IFCPOLYLINE((${ptIds.join(",")}))`);
    const profile = w.add(
        `IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${polyline})`,
    );

    const locOrigin = w.add(
        `IFCCARTESIANPOINT((${fmt(cx)},${fmt(cy)},${fmt(cz)}))`,
    );
    const locZ = w.add(`IFCDIRECTION((0.,0.,1.))`);
    const locX = w.add(`IFCDIRECTION((${fmt(ux)},${fmt(uz)},0.))`);
    const placeAxis = w.add(`IFCAXIS2PLACEMENT3D(${locOrigin},${locZ},${locX})`);
    const fillerPlacement = w.add(
        `IFCLOCALPLACEMENT(${wallPlacement},${placeAxis})`,
    );

    const extOrigin = w.add(`IFCCARTESIANPOINT((0.,0.,0.))`);
    const extAxis = w.add(`IFCAXIS2PLACEMENT3D(${extOrigin},$,$)`);
    const extDir = w.add(`IFCDIRECTION((0.,0.,1.))`);
    const extrude = w.add(
        `IFCEXTRUDEDAREASOLID(${profile},${extAxis},${extDir},${fmt(filler.height)})`,
    );

    const shapeRep = w.add(
        `IFCSHAPEREPRESENTATION(${geomContext},'Body','SweptSolid',(${extrude}))`,
    );
    const productShape = w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}))`);

    const isDoor = filler.type === "Door";
    const tag = isDoor ? "IFCDOOR" : "IFCWINDOW";
    const name = escapeIfc(
        filler.name ||
        (isDoor ? `Door_${(filler.id as string).slice(0, 6)}`
                : `Window_${(filler.id as string).slice(0, 6)}`),
    );
    // IFC2X3 IfcDoor / IfcWindow:
    //   (GlobalId, OwnerHistory, Name, Description, ObjectType,
    //    ObjectPlacement, Representation, Tag, OverallHeight, OverallWidth)
    return w.add(
        `${tag}('${makeGuid()}',${ownerHistory},'${name}',$,$,${fillerPlacement},${productShape},$,${fmt(filler.height)},${fmt(filler.width)})`,
    );
}

function findFillerForOpening(
    openingId: string,
    elements: Record<string, BaseElement>,
): DoorElement | WindowElement | null {
    for (const id in elements) {
        const e = elements[id];
        if (!e) continue;
        if (e.type === "Door" && (e as DoorElement).openingId === openingId) {
            return e as DoorElement;
        }
        if (e.type === "Window" && (e as WindowElement).openingId === openingId) {
            return e as WindowElement;
        }
    }
    return null;
}

/** ブラウザでファイルとしてダウンロードさせるユーティリティ。 */
export function downloadIfc(state: AppState, filename = "export.ifc"): void {
    const ifc = exportIfc(state);
    const blob = new Blob([ifc], { type: "application/x-step" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
