// ChangeWallReferenceCommand — 1 本の壁の基準線位置を切り替える。
//
// 設計:
//  - 対象 wall element の `locationLine` / `innerThickness` / `outerThickness`
//    のみを更新する (= per-wall 編集)。polygon 共通の `wallReference` には
//    触らない。これによりユーザが選んだ壁だけが新基準線に追従し、隣接壁は
//    そのまま保持される。
//  - 厚さ合計 (= wall.thickness) は不変。inner/outer の **配分** だけが変わる。
//      Center   → inner=T/2, outer=T/2
//      Interior → inner=0,   outer=T   (= スケッチ線が室内側面、壁は外へ)
//      Exterior → inner=T,   outer=0   (= スケッチ線が屋外側面、壁は内へ)
//  - wallRegenerate を呼ぶことで JunctionGraph が **per-edge** で新 inner/outer
//    を捕獲して接合を再計算する。Phase 2 の edgeThicknessMap が反映される。
//  - 部屋壁 (polyRef あり) では wallRegenerate が要素 ID を更新してしまうので
//    polyRef で再ルックアップ。単独壁の場合は legacy rect path で再描画。
//
// undo: 元の locationLine / inner / outer を復元 + regen 再実行。

import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { ElementId } from "../../model/base/ElementId";
import { WallElement } from "../../model/elements/WallElement";
import { triggerWallRegenIfEnabled } from "../../ui/room/wallRegenerate";

export type WallReferenceMode = "Center" | "Interior" | "Exterior";

interface Snapshot {
    locationLine: WallElement["locationLine"];
    innerThickness?: number;
    outerThickness?: number;
    polyRef?: { spaceId: ElementId; polyId: string; edgeIdx: number };
}

function findWallIdByPolyRef(
    state: ReturnType<typeof useAppState.getState>,
    polyRef: { spaceId: ElementId; polyId: string; edgeIdx: number },
): ElementId | null {
    for (const id in state.elements) {
        const el = state.elements[id] as WallElement | undefined;
        if (!el || el.type !== "Wall") continue;
        const r = el.polyRef;
        if (!r) continue;
        if (r.spaceId === polyRef.spaceId
            && r.polyId === polyRef.polyId
            && r.edgeIdx === polyRef.edgeIdx) {
            return id as ElementId;
        }
    }
    return null;
}

function locationLineFromMode(mode: WallReferenceMode): WallElement["locationLine"] {
    switch (mode) {
        case "Interior": return "FinishInterior";
        case "Exterior": return "FinishExterior";
        case "Center":
        default:         return "Center";
    }
}

function inOutFromMode(mode: WallReferenceMode, T: number): { inner: number; outer: number } {
    switch (mode) {
        case "Interior": return { inner: 0,   outer: T };
        case "Exterior": return { inner: T,   outer: 0 };
        case "Center":
        default:         return { inner: T/2, outer: T/2 };
    }
}

export class ChangeWallReferenceCommand implements Command {
    private snapshot: Snapshot | null = null;

    constructor(
        public elementId: ElementId,
        public newMode: WallReferenceMode,
    ) {}

    private resolveCurrentId(state: ReturnType<typeof useAppState.getState>): ElementId | null {
        if (state.elements[this.elementId as string]) return this.elementId;
        if (this.snapshot?.polyRef) {
            return findWallIdByPolyRef(state, this.snapshot.polyRef);
        }
        return null;
    }

    execute(): CommandResult {
        const state = useAppState.getState();
        const currentId = this.resolveCurrentId(state) ?? this.elementId;
        const wall = state.elements[currentId as string] as WallElement | undefined;
        if (!wall || wall.type !== "Wall") {
            return { success: false, message: `Wall ${this.elementId} not found` };
        }

        this.snapshot = {
            locationLine: wall.locationLine,
            innerThickness: wall.innerThickness,
            outerThickness: wall.outerThickness,
            polyRef: wall.polyRef,
        };

        const T = wall.thickness;
        const { inner, outer } = inOutFromMode(this.newMode, T);
        const newLoc = locationLineFromMode(this.newMode);

        state.updateElement(currentId, {
            locationLine: newLoc,
            innerThickness: inner,
            outerThickness: outer,
            // 部屋壁: footprint をクリアして wallRegenerate に再計算させる。
            // (= per-edge thickness map に新値が乗って JunctionGraph が新基準で
            //   接合を引き直す)
            footprint: undefined,
            footprintHoles: undefined,
            footprintIsFinal: false,
            dirtyFlags: new Set(["Topology", "Geometry", "Mesh", "Render"]),
        } as any);

        if (wall.polyRef?.polyId) {
            triggerWallRegenIfEnabled("wall-reference-change", [wall.polyRef.polyId]);
            // 選択を新 wall に張り直す (regen で ID が変わるため)
            const newId = findWallIdByPolyRef(useAppState.getState(), wall.polyRef);
            if (newId) useAppState.getState().setSelection([newId]);
        }
        return { success: true };
    }

    undo(): CommandResult {
        if (!this.snapshot) return { success: false, message: "No snapshot to undo" };
        const state = useAppState.getState();
        const currentId = this.resolveCurrentId(state);
        if (!currentId) return { success: false, message: "Wall to undo not found" };

        state.updateElement(currentId, {
            locationLine: this.snapshot.locationLine,
            innerThickness: this.snapshot.innerThickness,
            outerThickness: this.snapshot.outerThickness,
            footprint: undefined,
            footprintHoles: undefined,
            footprintIsFinal: false,
            dirtyFlags: new Set(["Topology", "Geometry", "Mesh", "Render"]),
        } as any);

        if (this.snapshot.polyRef) {
            triggerWallRegenIfEnabled("wall-reference-undo", [this.snapshot.polyRef.polyId]);
            const newId = findWallIdByPolyRef(useAppState.getState(), this.snapshot.polyRef);
            if (newId) useAppState.getState().setSelection([newId]);
        }
        this.snapshot = null;
        return { success: true };
    }
}
