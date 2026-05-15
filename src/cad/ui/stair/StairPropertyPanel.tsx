"use client";

// 階段 (Stair) パラメータ編集パネル — Properties (右ペイン) に表示。
//
// 2 つの動作モードを持つ:
//   1. **新規作成モード** (= activeStairId === null かつ activeTool === "stair")
//      AppState.stairCreateDraft をフォームと bind し、最下部の「Create」
//      ボタンで CreateStairCommand を実行 → activeStair に設定して edit モードへ。
//   2. **編集モード** (= activeStairId !== null、または Stair が単独選択)
//      該当 StairElement を直接 updateElement で書き換える。リアルタイム再
//      生成: dirtyFlags: ["Geometry","Mesh","Render"] を都度立てるだけで
//      Viewport の StairMeshBuilder が再ビルドする。
//
// UI 単位:
//   - 距離・高さ: mm 表示・入力 (内部 m 値を *1000 / /1000)
//   - 角度: deg 表示
//   - 段数 / カウント: そのまま整数

import React, { useMemo } from "react";
import { useAppState, AppState, StairCreateDraft } from "../../application/AppState";
import {
    StairElement,
    BaseStairParams,
    StairExtras,
    StairKind,
    TurnDirection,
    StairAlignment,
    RiserCalculationMode,
} from "../../model/elements/StairElement";
import { ElementId } from "../../model/base/ElementId";
import { Vec3 } from "../../geometry/math/Vec3";
import { CreateStairCommand } from "../../commands/create/CreateStairCommand";
import { deriveStairValues } from "../../utils/stairCalc";

// ── 入力ヘルパ: m/mm 変換、安全な数値パース ────────────────────────
const mToMm = (m: number) => (m * 1000).toFixed(0);
const mmToM = (mm: string): number | null => {
    const v = parseFloat(mm);
    if (!Number.isFinite(v)) return null;
    return v / 1000;
};
const intParse = (s: string): number | null => {
    const v = parseInt(s, 10);
    return Number.isFinite(v) ? v : null;
};

// ── view: パラメータ取得 (Stair 要素 / draft どちらにも対応) ─────────
function readParams(
    target: StairElement | StairCreateDraft,
): BaseStairParams & {
    flight1RiserCount: number;
    landingDepth: number;
    gapBetweenFlights: number;
    turnDirection: TurnDirection;
} {
    if ("kind" in target && target.kind === "twoQuarterTurnLanding") {
        return {
            ...target,
            flight1RiserCount: target.flight1RiserCount,
            landingDepth: target.landingDepth,
            gapBetweenFlights: target.gapBetweenFlights,
            turnDirection: target.turnDirection,
        };
    }
    // straight (or draft が straight) → U 字フィールドは draft 既定 / 0 で埋める
    const t: any = target;
    return {
        ...target,
        flight1RiserCount: t.flight1RiserCount ?? 0,
        landingDepth: t.landingDepth ?? 0,
        gapBetweenFlights: t.gapBetweenFlights ?? 0,
        turnDirection: t.turnDirection ?? "right",
    } as any;
}

// ── 共通入力行 ─────────────────────────────────────────────────
const labelClass = "block text-zinc-400 mb-1";
const inputClass = "w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-zinc-100 outline-none focus:border-blue-500";

interface NumInputProps {
    label: string;
    value: number;
    unit: "mm" | "deg" | "m" | "";
    onChange: (next: number) => void;
    step?: number;
    min?: number;
    max?: number;
    title?: string;
}
function NumberInput({ label, value, unit, onChange, step, min, max, title }: NumInputProps) {
    // mm 単位は m 値を *1000 して表示する。直接 m 入力はしない。
    const display = unit === "mm" ? mToMm(value) :
        unit === "deg" || unit === "m" || unit === "" ? String(value) : String(value);
    const [draft, setDraft] = React.useState<string>(display);
    React.useEffect(() => { setDraft(display); }, [display]);

    const commit = () => {
        let v: number | null = null;
        if (unit === "mm") {
            v = mmToM(draft);
        } else {
            const x = parseFloat(draft);
            v = Number.isFinite(x) ? x : null;
        }
        if (v === null) { setDraft(display); return; }
        if (min !== undefined && v < min) v = min;
        if (max !== undefined && v > max) v = max;
        if (Math.abs(v - value) < 1e-9) { setDraft(display); return; }
        onChange(v);
    };

    return (
        <div title={title}>
            <label className={labelClass}>{label}{unit ? ` (${unit})` : ""}</label>
            <input
                type="number"
                step={step ?? (unit === "mm" ? 10 : 0.01)}
                className={inputClass}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
            />
        </div>
    );
}

// ── 整数入力 ─────────────────────────────────────────────────
function IntInput({
    label,
    value,
    onChange,
    min,
    max,
    title,
}: {
    label: string;
    value: number;
    onChange: (next: number) => void;
    min?: number;
    max?: number;
    title?: string;
}) {
    const [draft, setDraft] = React.useState<string>(String(value));
    React.useEffect(() => { setDraft(String(value)); }, [value]);
    const commit = () => {
        const v = intParse(draft);
        if (v === null) { setDraft(String(value)); return; }
        let clamped = v;
        if (min !== undefined && clamped < min) clamped = min;
        if (max !== undefined && clamped > max) clamped = max;
        if (clamped === value) { setDraft(String(value)); return; }
        onChange(clamped);
    };
    return (
        <div title={title}>
            <label className={labelClass}>{label}</label>
            <input
                type="number"
                step={1}
                className={inputClass}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
            />
        </div>
    );
}

// ── Vec3 入力 (x, y, z 3 列) ──────────────────────────────────
function Vec3Input({
    label,
    value,
    onChange,
    title,
}: {
    label: string;
    value: Vec3;
    onChange: (next: Vec3) => void;
    title?: string;
}) {
    const [dx, setDx] = React.useState<string>(mToMm(value[0]));
    const [dy, setDy] = React.useState<string>(mToMm(value[1]));
    const [dz, setDz] = React.useState<string>(mToMm(value[2]));
    React.useEffect(() => {
        setDx(mToMm(value[0]));
        setDy(mToMm(value[1]));
        setDz(mToMm(value[2]));
    }, [value]);
    const commit = () => {
        const x = mmToM(dx) ?? value[0];
        const y = mmToM(dy) ?? value[1];
        const z = mmToM(dz) ?? value[2];
        if (Math.abs(x - value[0]) < 1e-9 && Math.abs(y - value[1]) < 1e-9 && Math.abs(z - value[2]) < 1e-9) return;
        onChange([x, y, z]);
    };
    return (
        <div title={title}>
            <label className={labelClass}>{label} (mm)</label>
            <div className="grid grid-cols-3 gap-1">
                {[
                    { label: "X", v: dx, set: setDx },
                    { label: "Y", v: dy, set: setDy },
                    { label: "Z", v: dz, set: setDz },
                ].map((c) => (
                    <div key={c.label} className="flex flex-col">
                        <span className="text-[10px] text-zinc-500 text-center">{c.label}</span>
                        <input
                            type="number"
                            step={10}
                            className={inputClass + " text-center text-[11px]"}
                            value={c.v}
                            onChange={(e) => c.set(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── パネル本体 ─────────────────────────────────────────────────
//
// activeStairId / activeTool / 単独選択 stair の組合せでモードを決定する。
// 同じ表示コンポーネント (FormFields) を draft / Element の両方に使う。
export default function StairPropertyPanel() {
    const elements = useAppState((s: AppState) => s.elements);
    const selection = useAppState((s: AppState) => s.selection);
    const activeTool = useAppState((s: AppState) => s.activeTool);
    const activeStairId = useAppState((s: AppState) => s.activeStairId);
    const setActiveStair = useAppState((s: AppState) => s.setActiveStair);
    const draft = useAppState((s: AppState) => s.stairCreateDraft);
    const updateDraft = useAppState((s: AppState) => s.updateStairDraft);
    const resetDraft = useAppState((s: AppState) => s.resetStairDraft);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const removeElement = useAppState((s: AppState) => s.removeElement);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const setSelection = useAppState((s: AppState) => s.setSelection);
    const setActiveTool = useAppState((s: AppState) => s.setActiveTool);
    const stairOriginPickMode = useAppState((s: AppState) => s.stairOriginPickMode);
    const setStairOriginPickMode = useAppState((s: AppState) => s.setStairOriginPickMode);

    // 編集対象の決定: 選択中 Stair > activeStairId > null (= 新規作成)。
    const selectedStairId = useMemo<ElementId | null>(() => {
        if (selection.length === 1) {
            const e = elements[selection[0]];
            if (e?.type === "Stair") return e.id;
        }
        return null;
    }, [selection, elements]);
    const editingStair = (selectedStairId ?? activeStairId)
        ? (elements[(selectedStairId ?? activeStairId)!] as StairElement | undefined)
        : undefined;
    const isCreateMode = !editingStair && activeTool === "stair";

    // パネル自体を出すかどうか。
    if (!isCreateMode && !editingStair) return null;

    // 編集 / 作成のターゲット (= フォームの値ソース)。
    const target: StairElement | StairCreateDraft = editingStair ?? draft;
    const params = readParams(target);
    const derived = deriveStairValues(target as any);

    // ── 値変更: 編集モード = updateElement, 作成モード = updateDraft ────
    const apply = (partial: Partial<StairCreateDraft>) => {
        if (editingStair) {
            updateElement(editingStair.id, {
                ...partial,
                dirtyFlags: new Set([
                    ...(editingStair.dirtyFlags ?? []),
                    "Geometry", "Mesh", "Render",
                ]),
            } as any);
        } else {
            updateDraft(partial);
        }
    };

    // Kind 切替: フィールドの欠落を補うため、U 字必須項目をマージ。
    const setKind = (k: StairKind) => {
        if (editingStair) {
            // 既存 Stair の Kind 切替: U 字必須フィールドが欠落していたら追加。
            const merge: any = { kind: k };
            if (k === "twoQuarterTurnLanding") {
                merge.flight1RiserCount = (editingStair as any).flight1RiserCount
                    ?? Math.ceil(editingStair.riserCount / 2);
                merge.landingDepth = (editingStair as any).landingDepth ?? editingStair.stairWidth;
                merge.gapBetweenFlights = (editingStair as any).gapBetweenFlights ?? 0;
                merge.turnDirection = (editingStair as any).turnDirection ?? "right";
            }
            apply(merge);
        } else {
            updateDraft({ kind: k });
        }
    };

    // ── 段数モード: auto なら totalHeight + targetRiserHeight から再計算 ─
    const onCalculationModeChange = (m: RiserCalculationMode) => {
        if (m === "auto") {
            // riserCount を再計算して反映 (riserHeight も derive で導出される)
            const totalH = Math.max(0, target.topElevation - target.baseElevation);
            const targetH = Math.max(0.05, target.targetRiserHeight);
            const newRiserCount = Math.max(1, Math.ceil(totalH / targetH));
            const newRiserHeight = totalH > 0 ? totalH / newRiserCount : targetH;
            apply({
                calculationMode: m,
                riserCount: newRiserCount,
                riserHeight: newRiserHeight,
            });
        } else {
            // manual はそのまま現在の riserCount を保持
            apply({ calculationMode: m });
        }
    };

    // riserCount を変更したら riserHeight を派生計算で再投影。
    const onRiserCountChange = (n: number) => {
        const totalH = Math.max(0, target.topElevation - target.baseElevation);
        const newRiserHeight = totalH > 0 ? totalH / n : target.riserHeight;
        apply({ riserCount: n, riserHeight: newRiserHeight });
    };
    const onTopElevationChange = (yTop: number) => {
        const totalH = Math.max(0, yTop - target.baseElevation);
        if (target.calculationMode === "auto") {
            const targetH = Math.max(0.05, target.targetRiserHeight);
            const newCount = Math.max(1, Math.ceil(totalH / targetH));
            const newRH = totalH > 0 ? totalH / newCount : targetH;
            apply({ topElevation: yTop, riserCount: newCount, riserHeight: newRH });
        } else {
            const newRH = totalH > 0 ? totalH / target.riserCount : target.riserHeight;
            apply({ topElevation: yTop, riserHeight: newRH });
        }
    };
    const onBaseElevationChange = (yBase: number) => {
        const totalH = Math.max(0, target.topElevation - yBase);
        if (target.calculationMode === "auto") {
            const targetH = Math.max(0.05, target.targetRiserHeight);
            const newCount = Math.max(1, Math.ceil(totalH / targetH));
            const newRH = totalH > 0 ? totalH / newCount : targetH;
            apply({ baseElevation: yBase, riserCount: newCount, riserHeight: newRH });
        } else {
            const newRH = totalH > 0 ? totalH / target.riserCount : target.riserHeight;
            apply({ baseElevation: yBase, riserHeight: newRH });
        }
    };

    const onCreate = () => {
        // draft → CreateStairCommand
        const cmd = new CreateStairCommand(
            // BaseStairParams + StairExtras を作る (kind 別)
            (() => {
                const base: BaseStairParams = {
                    kind: draft.kind,
                    baseElevation: draft.baseElevation,
                    topElevation: draft.topElevation,
                    stairWidth: draft.stairWidth,
                    treadDepth: draft.treadDepth,
                    riserHeight: draft.riserHeight,
                    riserCount: draft.riserCount,
                    nosingLength: draft.nosingLength,
                    calculationMode: draft.calculationMode,
                    targetRiserHeight: draft.targetRiserHeight,
                    startPoint: draft.startPoint,
                    startDirection: draft.startDirection,
                    referenceLine: draft.referenceLine,
                    waistSlabThickness: draft.waistSlabThickness,
                    landingSlabThickness: draft.landingSlabThickness,
                    baseLevelId: draft.baseLevelId,
                    topLevelId: draft.topLevelId,
                };
                let extras: StairExtras;
                if (draft.kind === "straight") {
                    extras = { kind: "straight" };
                } else {
                    extras = {
                        kind: "twoQuarterTurnLanding",
                        flight1RiserCount: draft.flight1RiserCount,
                        landingDepth: draft.landingDepth,
                        gapBetweenFlights: draft.gapBetweenFlights,
                        turnDirection: draft.turnDirection,
                    };
                }
                return { ...base, ...extras } as BaseStairParams & StairExtras;
            })(),
            draft.kind === "straight" ? "Straight Stair" : "U-Shape Stair",
        );
        executeCommand(cmd);
        const newId = cmd.getElementId();
        setActiveStair(newId);
        setSelection([newId]);
        setActiveTool("select");
        resetDraft();
    };

    const onDelete = () => {
        if (!editingStair) return;
        removeElement(editingStair.id);
        setSelection([]);
        setActiveStair(null);
    };

    return (
        <div className="space-y-3 text-xs">
            <div className="text-zinc-300 font-medium">
                {isCreateMode ? "新規階段の作成" : (editingStair?.name ?? "Stair")}
            </div>
            <div className="text-zinc-500">Type: Stair</div>

            {/* ── Kind 切替 ─────────────────────────────────── */}
            <div>
                <label className={labelClass}>階段種別</label>
                <select
                    className={inputClass}
                    value={params.kind}
                    onChange={(e) => setKind(e.target.value as StairKind)}
                >
                    <option value="straight">直階段</option>
                    <option value="twoQuarterTurnLanding">U 字 (90°×2 + 踊り場)</option>
                </select>
            </div>

            {/* ── 原点 (startPoint) + ピックモード ──────────── */}
            <div className="border border-zinc-700 rounded p-2 space-y-2 bg-zinc-900/50">
                <div className="text-zinc-400 font-medium">配置原点</div>
                <Vec3Input
                    label="開始点 startPoint"
                    value={params.startPoint}
                    onChange={(p) => apply({ startPoint: p })}
                    title="階段の開始点 (= 1段目下端)。直接入力するか、下のピックモードで取得。"
                />
                <Vec3Input
                    label="進行方向 startDirection"
                    value={params.startDirection}
                    onChange={(d) => apply({ startDirection: d })}
                    title="上り方向の単位ベクトル (XZ平面)。例: [1,0,0] で +X 方向に登る。"
                />
                <div>
                    <label className={labelClass}>原点ピックモード</label>
                    <div className="flex gap-1">
                        {([
                            { id: "off", label: "OFF", title: "ピック OFF (= 直接入力のみ)" },
                            { id: "freeFloor", label: "床面", title: "3Dビューの床面 (Y=baseElevation) をクリックして取得" },
                            { id: "vertexSnap", label: "頂点スナップ", title: "壁端点・柱中心・通芯交点等にスナップしてクリック" },
                        ] as const).map((m) => (
                            <button
                                key={m.id}
                                type="button"
                                className={`flex-1 px-2 py-1 rounded text-[11px] border ${stairOriginPickMode === m.id
                                    ? "bg-blue-700 border-blue-500 text-white"
                                    : "bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700"
                                    }`}
                                onClick={() => setStairOriginPickMode(m.id)}
                                title={m.title}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div>
                    <label className={labelClass}>配置基準線</label>
                    <select
                        className={inputClass}
                        value={params.referenceLine}
                        onChange={(e) => apply({ referenceLine: e.target.value as StairAlignment })}
                    >
                        <option value="left">左端</option>
                        <option value="center">中心</option>
                        <option value="right">右端</option>
                    </select>
                </div>
            </div>

            {/* ── 基本寸法 ─────────────────────────────────── */}
            <div className="border border-zinc-700 rounded p-2 space-y-2 bg-zinc-900/50">
                <div className="text-zinc-400 font-medium">基本寸法</div>
                <NumberInput
                    label="開始高さ baseElev"
                    unit="mm"
                    value={params.baseElevation}
                    onChange={onBaseElevationChange}
                    title="階段の下端の絶対高さ"
                />
                <NumberInput
                    label="終了高さ topElev"
                    unit="mm"
                    value={params.topElevation}
                    onChange={onTopElevationChange}
                    title="階段の上端の絶対高さ (= 上階床面)"
                />
                <div className="text-[10px] text-zinc-500">
                    階高 = {(derived.totalHeight * 1000).toFixed(0)} mm
                </div>
                <NumberInput
                    label="階段幅 stairWidth"
                    unit="mm"
                    value={params.stairWidth}
                    onChange={(v) => apply({ stairWidth: v })}
                    min={0.3}
                />
                <NumberInput
                    label="踏面 treadDepth"
                    unit="mm"
                    value={params.treadDepth}
                    onChange={(v) => apply({ treadDepth: v })}
                    min={0.05}
                />
                <NumberInput
                    label="段鼻 nosingLength"
                    unit="mm"
                    value={params.nosingLength}
                    onChange={(v) => apply({ nosingLength: v })}
                    min={0}
                />
            </div>

            {/* ── 段数計算 ─────────────────────────────────── */}
            <div className="border border-zinc-700 rounded p-2 space-y-2 bg-zinc-900/50">
                <div className="text-zinc-400 font-medium">段数</div>
                <div>
                    <label className={labelClass}>計算モード</label>
                    <select
                        className={inputClass}
                        value={params.calculationMode}
                        onChange={(e) => onCalculationModeChange(e.target.value as RiserCalculationMode)}
                    >
                        <option value="auto">自動 (希望蹴上から逆算)</option>
                        <option value="manual">手動 (段数を直接指定)</option>
                    </select>
                </div>
                {params.calculationMode === "auto" ? (
                    <NumberInput
                        label="希望蹴上 targetRiser"
                        unit="mm"
                        value={params.targetRiserHeight}
                        onChange={(v) => {
                            // target を変えたら段数も再投影
                            const totalH = Math.max(0, target.topElevation - target.baseElevation);
                            const newCount = Math.max(1, Math.ceil(totalH / Math.max(0.05, v)));
                            const newRH = totalH > 0 ? totalH / newCount : v;
                            apply({ targetRiserHeight: v, riserCount: newCount, riserHeight: newRH });
                        }}
                        min={0.05}
                        title="auto モードで使う希望蹴上値。段数 = ceil(階高 / 希望蹴上)"
                    />
                ) : (
                    <IntInput
                        label="蹴上数 riserCount"
                        value={params.riserCount}
                        onChange={onRiserCountChange}
                        min={1}
                    />
                )}
                <div className="text-[10px] text-zinc-500">
                    実際の蹴上 = {(derived.riserHeight * 1000).toFixed(0)} mm
                    {" / "}段数 = {derived.riserCount}
                </div>
            </div>

            {/* ── U 字階段固有 ──────────────────────────────── */}
            {params.kind === "twoQuarterTurnLanding" && (
                <div className="border border-zinc-700 rounded p-2 space-y-2 bg-zinc-900/50">
                    <div className="text-zinc-400 font-medium">U 字階段</div>
                    <div>
                        <label className={labelClass}>回り方向</label>
                        <select
                            className={inputClass}
                            value={params.turnDirection}
                            onChange={(e) => apply({ turnDirection: e.target.value as TurnDirection })}
                        >
                            <option value="right">右回り</option>
                            <option value="left">左回り</option>
                        </select>
                    </div>
                    <IntInput
                        label="第1階段の段数 flight1RiserCount"
                        value={params.flight1RiserCount}
                        onChange={(n) => apply({ flight1RiserCount: n })}
                        min={1}
                        max={params.riserCount - 1}
                        title={`第2階段の段数 = riserCount - flight1RiserCount = ${derived.riserCount - params.flight1RiserCount}`}
                    />
                    <NumberInput
                        label="踊り場奥行 landingDepth"
                        unit="mm"
                        value={params.landingDepth}
                        onChange={(v) => apply({ landingDepth: v })}
                        min={0.5}
                    />
                    <NumberInput
                        label="フライト間隔 gapBetweenFlights"
                        unit="mm"
                        value={params.gapBetweenFlights}
                        onChange={(v) => apply({ gapBetweenFlights: v })}
                        min={0}
                    />
                    <div className="text-[10px] text-zinc-500">
                        踊り場高さ = {(derived.landingElevation * 1000).toFixed(0)} mm
                        {" / "}第2段数 = {derived.riserCount - params.flight1RiserCount}
                    </div>
                </div>
            )}

            {/* ── 構造 ─────────────────────────────────────── */}
            <div className="border border-zinc-700 rounded p-2 space-y-2 bg-zinc-900/50">
                <div className="text-zinc-400 font-medium">構造</div>
                <NumberInput
                    label="階段スラブ厚"
                    unit="mm"
                    value={params.waistSlabThickness}
                    onChange={(v) => apply({ waistSlabThickness: v })}
                    min={0.05}
                />
                {params.kind === "twoQuarterTurnLanding" && (
                    <NumberInput
                        label="踊り場スラブ厚"
                        unit="mm"
                        value={params.landingSlabThickness}
                        onChange={(v) => apply({ landingSlabThickness: v })}
                        min={0.05}
                    />
                )}
            </div>

            {/* ── 派生値表示 ─────────────────────────────── */}
            <div className="text-[10px] text-zinc-500 leading-relaxed">
                {params.kind === "straight" ? (
                    <>水平長 = {(derived.flight1RunLength * 1000).toFixed(0)} mm</>
                ) : (
                    <>
                        フライト1 = {(derived.flight1RunLength * 1000).toFixed(0)} mm
                        {" / "}
                        フライト2 = {(derived.flight2RunLength * 1000).toFixed(0)} mm
                    </>
                )}
            </div>

            {/* ── アクション ─────────────────────────────── */}
            {isCreateMode ? (
                <button
                    className="w-full px-2 py-2 bg-blue-700 hover:bg-blue-600 rounded text-white font-medium"
                    onClick={onCreate}
                >
                    Create 階段
                </button>
            ) : (
                <button
                    className="w-full px-2 py-1 bg-red-700/60 hover:bg-red-600/60 rounded text-zinc-100"
                    onClick={onDelete}
                >
                    階段を削除
                </button>
            )}
        </div>
    );
}
