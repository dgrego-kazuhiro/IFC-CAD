// ChangeElementTypeCommand — 既存要素の typeId を切り替え、Type 由来の
// キャッシュフィールド (profile / thickness 等) と dirtyFlags を再投影する。
//
// undo は元 typeId / overrides / 派生フィールドを完全復元する。
//
// Wall についての設計メモ (Phase 2 — per-edge thickness):
//  - 対象 wall element のフィールド (typeId/overrides/thickness/inner+outer
//    Thickness/locationLine) を新 Type に更新する。**ポリゴン共通の
//    wallThickness は触らない**。
//  - その上で wallRegenerate を呼ぶ。wallRegenerate は各エッジの **既存壁**
//    から per-edge thickness を捕獲して JunctionGraph (`edgeThicknessMap`)
//    に流すので、対象 1 本だけが新厚さで mitered 接合される (= 隣接壁とは
//    違う厚さでも Clipper diff が接合面を自然に閉じる)。
//  - wallRegenerate は per-edge typeId/overrides も保持するので、再生成後の
//    新壁にユーザの選択した Type 情報がコピーされる。
//  - 注意: wallRegenerate は **古い壁を削除して新しい壁を作る** ため、要素
//    ID が変わる。undo / redo は polyRef (spaceId / polyId / edgeIdx) で
//    「そのエッジの今の壁」を再ルックアップして適用する。

import { Command } from "../base/Command";
import { CommandResult } from "../base/CommandResult";
import { useAppState } from "../../application/AppState";
import { ElementId } from "../../model/base/ElementId";
import { WallElement } from "../../model/elements/WallElement";
import { ColumnElement } from "../../model/elements/ColumnElement";
import { BeamElement } from "../../model/elements/BeamElement";
import { SlabElement } from "../../model/elements/SlabElement";
import { Profile } from "../../model/profiles/Profile";
import {
    effectiveWallType, effectiveColumnType,
    effectiveBeamType, effectiveSlabType,
} from "../../model/catalog/TypeResolver";
import { isWallType, isColumnType, isBeamType, isSlabType } from "../../model/catalog/ElementTypeDef";
import { triggerWallRegenIfEnabled } from "../../ui/room/wallRegenerate";

interface Snapshot {
    typeId: ElementId;
    overrides?: any;
    /** 切り替え前のキャッシュ値 (= profile / thickness / locationLine 等)。 */
    cached: Record<string, unknown>;
    /** Wall の場合、再生成で要素 ID が変わるため polyRef で再ルックアップする。 */
    polyRef?: { spaceId: ElementId; polyId: string; edgeIdx: number };
}

/** 部屋壁: polyRef で「そのエッジの今の壁」を引き直す。要素 ID は regen で
 *  毎回変わるので、論理位置 (polyRef) で参照する方が安定。 */
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

export class ChangeElementTypeCommand implements Command {
    private snapshot: Snapshot | null = null;

    constructor(
        public elementId: ElementId,
        public newTypeId: ElementId,
        public newOverrides?: any,
    ) {}

    /** 対象要素の現在 ID を解決する (Wall は regen で変わるので polyRef で再引き)。 */
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
        const el = state.elements[currentId as string];
        if (!el) return { success: false, message: `Element ${this.elementId} not found` };
        const newType = state.types[this.newTypeId as string];
        if (!newType) return { success: false, message: `Type ${this.newTypeId} not found` };

        // 要素の category と Type の kind が一致するかをチェック。
        const ok =
            (el.type === "Wall"   && isWallType(newType)) ||
            (el.type === "Column" && isColumnType(newType)) ||
            (el.type === "Beam"   && isBeamType(newType)) ||
            (el.type === "Slab"   && isSlabType(newType));
        if (!ok) {
            return { success: false, message: `Type ${newType.kind} cannot be applied to element of type ${el.type}` };
        }

        // 派生フィールド再投影 + snapshot 取得。
        const patch: Record<string, unknown> = {
            typeId: this.newTypeId,
            overrides: this.newOverrides,
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
        };
        const cached: Record<string, unknown> = {};
        let polyRefSnapshot: { spaceId: ElementId; polyId: string; edgeIdx: number } | undefined;

        if (el.type === "Wall" && isWallType(newType)) {
            const wall = el as WallElement;
            const eff = effectiveWallType(state.types, this.newTypeId, this.newOverrides);
            if (!eff) return { success: false, message: "Failed to resolve WallType" };
            cached.thickness = wall.thickness;
            cached.locationLine = wall.locationLine;
            cached.innerThickness = wall.innerThickness;
            cached.outerThickness = wall.outerThickness;
            cached.footprint = wall.footprint;
            cached.footprintHoles = wall.footprintHoles;
            cached.footprintIsFinal = wall.footprintIsFinal;
            patch.thickness = eff.thickness;
            patch.locationLine = eff.locationLine;
            patch.innerThickness = eff.thickness / 2;
            patch.outerThickness = eff.thickness / 2;
            patch.dirtyFlags = new Set(["Topology", "Geometry", "Mesh", "Render"]);
            if (wall.polyRef) polyRefSnapshot = wall.polyRef;
        } else if (el.type === "Column" && isColumnType(newType)) {
            const col = el as ColumnElement;
            const eff = effectiveColumnType(state.types, this.newTypeId, this.newOverrides);
            if (!eff) return { success: false, message: "Failed to resolve ColumnType" };
            cached.profile = col.profile as Profile;
            patch.profile = eff.profile;
        } else if (el.type === "Beam" && isBeamType(newType)) {
            const beam = el as BeamElement;
            const eff = effectiveBeamType(state.types, this.newTypeId, this.newOverrides);
            if (!eff) return { success: false, message: "Failed to resolve BeamType" };
            cached.profile = beam.profile as Profile;
            patch.profile = eff.profile;
        } else if (el.type === "Slab" && isSlabType(newType)) {
            const slab = el as SlabElement;
            const eff = effectiveSlabType(state.types, this.newTypeId, this.newOverrides);
            if (!eff) return { success: false, message: "Failed to resolve SlabType" };
            cached.thickness = slab.thickness;
            patch.thickness = eff.thickness;
        }

        this.snapshot = {
            typeId: (el as any).typeId as ElementId,
            overrides: (el as any).overrides,
            cached,
            polyRef: polyRefSnapshot,
        };

        state.updateElement(currentId, patch as any);

        // Wall: 部屋壁なら所属ポリゴンを seed に wallRegenerate を呼んで、
        // per-edge thickness map を反映した新フットプリントで再生成。
        // wallRegenerate は古い壁を消して新しい壁を作るため、要素 ID は変わる。
        // 以降の参照は polyRef 経由で安定的に引ける (= snapshot.polyRef 経由)。
        if (el.type === "Wall" && isWallType(newType)) {
            const wall = state.elements[currentId as string] as WallElement | undefined;
            if (wall?.polyRef?.polyId) {
                triggerWallRegenIfEnabled("type-change", [wall.polyRef.polyId]);
                // 選択を新 wall に張り直す (= ユーザが Properties を見続けた時に
                // 古い ID 由来の "No selection" にならないように)。
                const newId = findWallIdByPolyRef(useAppState.getState(), wall.polyRef);
                if (newId) {
                    useAppState.getState().setSelection([newId]);
                }
            }
        }
        return { success: true };
    }

    undo(): CommandResult {
        if (!this.snapshot) return { success: false, message: "No snapshot to undo" };
        const state = useAppState.getState();
        // wallRegenerate で ID が変わっているので再ルックアップ。Wall 以外は
        // ID が安定なので elementId をそのまま使う。
        const currentId = this.resolveCurrentId(state);
        if (!currentId) return { success: false, message: "Element to undo not found" };

        const restore: Record<string, unknown> = {
            typeId: this.snapshot.typeId,
            overrides: this.snapshot.overrides,
            dirtyFlags: new Set(["Geometry", "Mesh", "Render"]),
            ...this.snapshot.cached,
        };
        state.updateElement(currentId, restore as any);

        // Wall は再度 regen を呼んで、復元した per-edge thickness で接合を
        // 再計算 (= 隣接壁との miter が元の厚さに戻る)。
        if (this.snapshot.polyRef) {
            triggerWallRegenIfEnabled("type-change-undo", [this.snapshot.polyRef.polyId]);
            const newId = findWallIdByPolyRef(useAppState.getState(), this.snapshot.polyRef);
            if (newId) useAppState.getState().setSelection([newId]);
        }
        this.snapshot = null;
        return { success: true };
    }
}
