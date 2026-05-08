"use client";

// ElementTypePanel — 選択中要素の「現在の Type」を表示し、別 Type へ切り替える。
// 切替は ChangeElementTypeCommand 経由。標準 Type は read-only で、ユーザが
// 編集したい場合は「複製」ボタンで isStandard:false の新 Type を発行する。

import React, { useMemo } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { CategoryId, STANDARD_FAMILIES, cloneType, ElementTypeDef } from "../../model/catalog";
import { ChangeElementTypeCommand } from "../../commands/modify/ChangeElementTypeCommand";
import { ElementId } from "../../model/base/ElementId";

const ELEMENT_TYPE_TO_CATEGORY: Record<string, CategoryId> = {
    Wall: "Wall",
    Column: "Column",
    Beam: "Beam",
    Slab: "Slab",
};

export default function ElementTypePanel() {
    const selection = useAppState((s: AppState) => s.selection);
    const elements = useAppState((s: AppState) => s.elements);
    const types = useAppState((s: AppState) => s.types);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const addType = useAppState((s: AppState) => s.addType);

    // 選択 1 件かつ Type 対応カテゴリのみ表示。複数選択や Type 非対応要素時は
    // 何も出さない (= UI ノイズ削減)。
    const targetEl = selection.length === 1 ? elements[selection[0]] : null;
    const categoryId = targetEl ? ELEMENT_TYPE_TO_CATEGORY[targetEl.type] : undefined;
    const currentTypeId = (targetEl as any)?.typeId as string | undefined;
    const currentType = currentTypeId ? types[currentTypeId] : undefined;

    const grouped = useMemo(() => {
        if (!categoryId) return [];
        const families = STANDARD_FAMILIES.filter((f) => f.categoryId === categoryId);
        const out: { family: typeof families[number]; types: ElementTypeDef[] }[] = [];
        for (const fam of families) {
            const ts = Object.values(types).filter((t) => t.familyId === fam.id);
            ts.sort((a, b) => a.name.localeCompare(b.name, "ja"));
            if (ts.length > 0) out.push({ family: fam, types: ts });
        }
        return out;
    }, [categoryId, types]);

    if (!targetEl || !categoryId) return null;

    const onChange = (newTypeId: string) => {
        if (!targetEl) return;
        if (newTypeId === currentTypeId) return;
        executeCommand(
            new ChangeElementTypeCommand(targetEl.id as ElementId, newTypeId as ElementId),
        );
    };
    const onDuplicate = () => {
        if (!currentType) return;
        const next = cloneType(currentType);
        addType(next);
        // 複製した新 Type に即切替 (= ユーザは編集モードへ進める)。
        executeCommand(
            new ChangeElementTypeCommand(targetEl.id as ElementId, next.id as ElementId),
        );
    };

    return (
        <div className="space-y-1 p-2 bg-zinc-950 rounded border border-zinc-800 text-xs">
            <div className="text-[10px] text-zinc-500 uppercase">Type ({targetEl.type})</div>
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
        </div>
    );
}
