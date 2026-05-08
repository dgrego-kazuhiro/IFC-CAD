"use client";

// TypePickerChip — 各ツール (Wall / Column / Beam / Slab) のオプションパネルに
// 載せる「Type 選択チップ」。指定 Category の Type を Family ごとにグループ
// 表示し、選んだものを `activeTypeIdByCategory[category]` に書き込む。
//
// MVP は select 要素 1 個 + 詳細ボタンの最小構成。後で type-manager パネルへ拡張。

import React, { useMemo } from "react";
import { useAppState, AppState } from "../../application/AppState";
import {
    CategoryId,
    ElementTypeDef,
    STANDARD_FAMILIES,
} from "../../model/catalog";

export interface TypePickerChipProps {
    categoryId: CategoryId;
}

export default function TypePickerChip({ categoryId }: TypePickerChipProps) {
    const types = useAppState((s: AppState) => s.types);
    const activeTypeIdByCategory = useAppState((s: AppState) => s.activeTypeIdByCategory);
    const setActiveTypeId = useAppState((s: AppState) => s.setActiveTypeId);

    const activeTypeId = activeTypeIdByCategory[categoryId];

    // 該当 category の Family 一覧 + その配下の Type 群を取得。
    const grouped = useMemo(() => {
        const families = STANDARD_FAMILIES.filter((f) => f.categoryId === categoryId);
        const out: { family: typeof families[number]; types: ElementTypeDef[] }[] = [];
        for (const fam of families) {
            const ts = Object.values(types).filter((t) => t.familyId === fam.id);
            ts.sort((a, b) => a.name.localeCompare(b.name, "ja"));
            if (ts.length > 0) out.push({ family: fam, types: ts });
        }
        return out;
    }, [types, categoryId]);

    if (grouped.length === 0) {
        return (
            <div className="text-[10px] text-zinc-500">
                Type が登録されていません
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="text-[10px] text-zinc-500 uppercase">Type</div>
            <select
                className="text-[11px] px-1 py-0.5 bg-white border border-zinc-300 rounded"
                value={activeTypeId ?? ""}
                onChange={(e) => setActiveTypeId(categoryId, e.target.value)}
                title="作成する Type を選択"
            >
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
        </div>
    );
}
