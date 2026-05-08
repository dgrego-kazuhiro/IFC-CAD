"use client";

// EdgeWallTypePanel — 部屋モードで polygon edge を 1 本選んだ時に表示する
// 「そのエッジの壁 Type を変える」パネル。
//
// フロー:
//   1. sketchSelection に kind: "edge" が 1 件だけある (= 部屋エッジ単一選択)
//   2. そのエッジの polygon.wallIds[edgeIdx] / wallsPerEdge[edgeIdx] から
//      関連 wall element を引く
//   3. 現在の wall.typeId を Type ドロップダウンに表示
//   4. ユーザが Type を変えたら ChangeElementTypeCommand を実行
//
// per-wall Type 編集 = wall element の typeId/thickness を更新 + wallRegen
// で per-edge thickness map を反映した新 footprint で再生成。これは
// ChangeElementTypeCommand 内に既に実装済みなので、ここでは UI と
// 「edge → wall element」のルックアップだけを担う。
//
// 共有エッジ (= 2 部屋で 1 つの壁を共用) の場合、wallRegen 側の §6.7 で
// 共有 ves に同じ厚さ・Type が伝搬されるので、片方の部屋エッジを介して
// 変更しても両部屋に反映される。

import React, { useMemo } from "react";
import { useAppState, AppState, SketchSelectionItem } from "../../application/AppState";
import { SpaceElement } from "../../model/elements/SpaceElement";
import { WallElement } from "../../model/elements/WallElement";
import {
    STANDARD_FAMILIES, ElementTypeDef, isWallType, cloneType,
} from "../../model/catalog";
import { ChangeElementTypeCommand } from "../../commands/modify/ChangeElementTypeCommand";
import { ChangeWallReferenceCommand, type WallReferenceMode } from "../../commands/modify/ChangeWallReferenceCommand";
import { ElementId } from "../../model/base/ElementId";

export default function EdgeWallTypePanel() {
    const sketchSelection = useAppState((s: AppState) => s.sketchSelection);
    const elements = useAppState((s: AppState) => s.elements);
    const types = useAppState((s: AppState) => s.types);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const addType = useAppState((s: AppState) => s.addType);

    // 1 件だけ "edge" が選択されている時のみ動く。複数選択や他種混在は no-op。
    const edgeSel = useMemo(
        () => sketchSelection.filter(
            (s): s is Extract<SketchSelectionItem, { kind: "edge" }> => s.kind === "edge",
        ),
        [sketchSelection],
    );
    const otherCount = sketchSelection.length - edgeSel.length;
    const isSingleEdge = edgeSel.length === 1 && otherCount === 0;
    const sel = isSingleEdge ? edgeSel[0] : null;

    // edge → wall element ルックアップ。
    const { wallId, wall } = useMemo(() => {
        if (!sel) return { wallId: null as ElementId | null, wall: null as WallElement | null };
        const space = elements[sel.spaceId as string] as SpaceElement | undefined;
        const poly = space?.polygons?.find((p) => p.id === sel.polyId);
        if (!poly) return { wallId: null, wall: null };
        // wallIds (= canonical 1 本) 優先、次に wallsPerEdge[i][0] (= 柱分断時の主壁)。
        const candidate = poly.wallIds?.[sel.edgeIdx]
            ?? poly.wallsPerEdge?.[sel.edgeIdx]?.[0]
            ?? null;
        if (!candidate) return { wallId: null, wall: null };
        const w = elements[candidate as string] as WallElement | undefined;
        if (!w || w.type !== "Wall") return { wallId: candidate as ElementId, wall: null };
        return { wallId: candidate as ElementId, wall: w };
    }, [sel, elements]);

    const currentTypeId = wall?.typeId;
    const currentType = currentTypeId ? types[currentTypeId as string] : undefined;

    const grouped = useMemo(() => {
        const families = STANDARD_FAMILIES.filter((f) => f.categoryId === "Wall");
        return families.map((fam) => ({
            family: fam,
            types: Object.values(types)
                .filter((t) => isWallType(t) && t.familyId === fam.id)
                .sort((a, b) => a.name.localeCompare(b.name, "ja")),
        })).filter((g) => g.types.length > 0);
    }, [types]);

    if (!isSingleEdge) return null;
    if (!wallId) {
        return (
            <div className="space-y-1 p-2 bg-zinc-950 rounded border border-zinc-800 text-xs">
                <div className="text-[10px] text-zinc-500 uppercase">エッジの壁 Type</div>
                <div className="text-[10px] text-zinc-500">
                    このエッジには壁が紐付いていません (= 全壁生成前 or 開いた polyline 端)。
                </div>
            </div>
        );
    }

    const onChange = (newTypeId: string) => {
        if (!wallId) return;
        if (newTypeId === currentTypeId) return;
        executeCommand(new ChangeElementTypeCommand(wallId, newTypeId as ElementId));
    };
    const onDuplicate = () => {
        if (!wallId || !currentType) return;
        const next = cloneType(currentType);
        addType(next);
        executeCommand(new ChangeElementTypeCommand(wallId, next.id as ElementId));
    };
    // wall.locationLine から UI セレクト値への変換 (= 既定の壁芯/内側面/外側面
    // 3 値に正規化。"CoreCenter" は壁芯扱い)。
    const currentRefMode: WallReferenceMode =
        wall?.locationLine === "FinishInterior" ? "Interior" :
        wall?.locationLine === "FinishExterior" ? "Exterior" :
        "Center";
    const onChangeRefMode = (mode: WallReferenceMode) => {
        if (!wallId) return;
        if (mode === currentRefMode) return;
        executeCommand(new ChangeWallReferenceCommand(wallId, mode));
    };

    return (
        <div className="space-y-1 p-2 bg-zinc-950 rounded border border-zinc-800 text-xs">
            <div className="text-[10px] text-zinc-500 uppercase">エッジの壁 Type</div>
            <div className="flex items-center gap-1">
                <select
                    className="flex-1 min-w-0 text-[11px] px-1 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                    value={currentTypeId ?? ""}
                    onChange={(e) => onChange(e.target.value)}
                >
                    {!currentTypeId && <option value="">(Type 未指定)</option>}
                    {grouped.map(({ family, types: ts }) => (
                        <optgroup key={family.id} label={family.name}>
                            {ts.map((t) => (
                                <option key={t.id} value={t.id}>
                                    {t.name}{t.isStandard ? "" : " *"}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </select>
                <button
                    className="text-[10px] px-2 py-0.5 rounded border bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300"
                    onClick={onDuplicate}
                    title="現在の Type を複製してユーザ Type を作成 (標準 Type の編集は複製してから)"
                    disabled={!currentType}
                >複製</button>
            </div>
            {currentType && currentType.isStandard && (
                <div className="text-[10px] text-zinc-500">
                    標準 Type は読み取り専用。編集するには複製してください。
                </div>
            )}
            {/* 基準線 (= スケッチ線を壁のどこに置くか) — per-wall で切替。
                Center: 壁芯 / Interior: 内側面 (壁を外へ) / Exterior: 外側面 (壁を内へ) */}
            <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-500 uppercase shrink-0">基準線</span>
                <select
                    className="flex-1 min-w-0 text-[11px] px-1 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                    value={currentRefMode}
                    onChange={(e) => onChangeRefMode(e.target.value as WallReferenceMode)}
                    title="この壁だけの基準線位置を変更 (= 厚さは保ったまま inner/outer の配分を変える)"
                >
                    <option value="Center">壁芯</option>
                    <option value="Interior">内側面 (壁を外へ)</option>
                    <option value="Exterior">外側面 (壁を内へ)</option>
                </select>
            </div>
            {wall && (
                <div className="text-[10px] text-zinc-500">
                    厚さ: {(wall.thickness * 1000).toFixed(0)} mm
                    {(wall.innerThickness !== undefined || wall.outerThickness !== undefined) && (
                        <> / 内 {((wall.innerThickness ?? wall.thickness/2) * 1000).toFixed(0)} mm / 外 {((wall.outerThickness ?? wall.thickness/2) * 1000).toFixed(0)} mm</>
                    )}
                </div>
            )}
        </div>
    );
}
