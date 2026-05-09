"use client";

import React, { useState, useEffect } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { gridSegments, gridVertices, curveFromVertices } from "../../model/grid/GridLine";
import { AddConstraintCommand, generateConstraintId } from "../../commands/create/AddConstraintCommand";
import { Constraint } from "../../model/constraint/Constraint";
import { Vec3 } from "../../geometry/math/Vec3";

export default function GridPropertyPanel() {
    const grids = useAppState((s: AppState) => s.grids);
    const selectedGridIds = useAppState((s: AppState) => s.selectedGridIds);
    const renameGrid = useAppState((s: AppState) => s.renameGrid);
    const updateGrid = useAppState((s: AppState) => s.updateGrid);
    const removeGrid = useAppState((s: AppState) => s.removeGrid);
    const setSelectedGridIds = useAppState((s: AppState) => s.setSelectedGridIds);
    const executeCommand = useAppState((s: AppState) => s.executeCommand);
    const constraints = useAppState((s: AppState) => s.constraints);

    const removeGrids = useAppState((s: AppState) => s.removeGrids);
    const clearGrids = useAppState((s: AppState) => s.clearGrids);
    const grid = grids.find((g) => g.id === selectedGridIds[0]);

    const [nameInput, setNameInput] = useState("");
    const [warning, setWarning] = useState<string | null>(null);
    const [distanceInput, setDistanceInput] = useState<string>("");

    useEffect(() => {
        setNameInput(grid?.name ?? "");
        setWarning(null);
    }, [grid?.id, grid?.name]);

    if (!grid) return null;

    // 2 本選択時に「通芯間距離」を初期入力値として現状の距離 (= 平行通芯なら
    // 1 本目線への 2 本目端点の垂直距離) を表示しておくと、ユーザは値を変える
    // だけで再拘束できる。
    const computeCurrentGridDistance = (): number | null => {
        if (selectedGridIds.length < 2) return null;
        const gA = grids.find((g) => g.id === selectedGridIds[0]);
        const gB = grids.find((g) => g.id === selectedGridIds[1]);
        if (!gA || !gB) return null;
        const vA = gridVertices(gA.curve);
        const vB = gridVertices(gB.curve);
        if (vA.length < 2 || vB.length < 2) return null;
        const ax = vA[0][0], az = vA[0][2];
        const bx = vA[1][0], bz = vA[1][2];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) return null;
        const px = vB[0][0], pz = vB[0][2];
        // p2l_distance: |((p - a) × (b - a))| / |b - a|
        const cross = (px - ax) * dz - (pz - az) * dx;
        return Math.abs(cross) / len;
    };

    const addGridGridDistance = () => {
        const v = parseFloat(distanceInput);
        if (!Number.isFinite(v) || v <= 0) return;
        if (selectedGridIds.length < 2) return;

        // 「動かさない」通芯と「動かす」通芯を判定する。原点との距離 / 一致
        // 拘束 (= Length(grid, Origin, _)) を持つ通芯は **アンカー扱い** にして
        // 動かさず、もう片方を平行移動させる。両方 / 両方無し なら従来通り
        // selectedGridIds[1] を動かす。
        const isAnchoredToOrigin = (gid: string): boolean => {
            for (const cId in constraints) {
                const c = constraints[cId];
                if (c.type !== "Length" || c.targets.length !== 2) continue;
                const hasGrid = c.targets.some(
                    (t) => t.kind === "Grid" && t.gridId === gid,
                );
                const hasOrigin = c.targets.some((t) => t.kind === "Origin");
                if (hasGrid && hasOrigin) return true;
            }
            return false;
        };
        const id0 = selectedGridIds[0];
        const id1 = selectedGridIds[1];
        let fixedId = id0;
        let movingId = id1;
        const a0 = isAnchoredToOrigin(id0);
        const a1 = isAnchoredToOrigin(id1);
        if (a1 && !a0) {
            // [1] がアンカー → [0] を動かす。
            fixedId = id1;
            movingId = id0;
        }

        const c: Constraint = {
            id: generateConstraintId(),
            type: "Length",
            targets: [
                { kind: "Grid", gridId: fixedId },
                { kind: "Grid", gridId: movingId },
            ],
            value: v,
        };
        executeCommand(new AddConstraintCommand(c));

        // 通芯は solver の **固定参照** として扱う設計のため、Length 拘束を
        // 追加しただけでは位置が動かない。ユーザの意図 (= 距離 D に合わせ
        // たい) に応えるため、ここで moving grid を fixed grid から法線方向に
        // 平行移動させる。原点アンカー判定で順序を入れ替えているので、原点
        // を通る通芯は動かない。
        const gA = grids.find((g) => g.id === fixedId);
        const gB = grids.find((g) => g.id === movingId);
        if (!gA || !gB) return;
        const vA = gridVertices(gA.curve);
        const vB = gridVertices(gB.curve);
        if (vA.length < 2 || vB.length < 2) return;
        const ax = vA[0][0], az = vA[0][2];
        const bx = vA[1][0], bz = vA[1][2];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) return;
        // grid A の単位接線 (u) と単位法線 (n)。
        const ux = dx / len, uz = dz / len;
        const nx = -uz, nz = ux;
        // grid B 端点[0] の grid A 線への符号付き垂直距離。
        const px = vB[0][0], pz = vB[0][2];
        const signed = (px - ax) * nx + (pz - az) * nz;
        const sign = signed >= 0 ? 1 : -1;
        const currentAbs = Math.abs(signed);
        const delta = (v - currentAbs) * sign;
        if (Math.abs(delta) < 1e-9) return; // 既に一致
        const moved: Vec3[] = vB.map((p) => [p[0] + delta * nx, p[1], p[2] + delta * nz] as Vec3);
        const newCurve = curveFromVertices(moved);
        if (newCurve) updateGrid(gB.id, { curve: newCurve });
    };

    /** 2 本の通芯を平行 / 直交に拘束 (= Parallel / Perpendicular)。 */
    const addGridGridConstraint = (type: "Parallel" | "Perpendicular") => {
        if (selectedGridIds.length < 2) return;
        const c: Constraint = {
            id: generateConstraintId(),
            type,
            targets: [
                { kind: "Grid", gridId: selectedGridIds[0] },
                { kind: "Grid", gridId: selectedGridIds[1] },
            ],
        };
        executeCommand(new AddConstraintCommand(c));
    };

    /**
     * 1 本の通芯を水平 / 垂直に拘束。SketchSolver では grid は **固定参照** として
     * push されるため、Horizontal/Vertical 拘束を登録しただけでは通芯位置が
     * 動かない。ユーザの意図 (= 通芯を水平/垂直に揃える) に応えるため、ここで
     * 通芯端点を直接揃える:
     *   - 水平: 全頂点の Z 座標を平均値に揃える (= 同じ Z = 水平線)
     *   - 垂直: 全頂点の X 座標を平均値に揃える (= 同じ X = 垂直線)
     */
    const addSingleGridConstraint = (type: "Horizontal" | "Vertical") => {
        const target = grid;
        if (!target) return;
        const c: Constraint = {
            id: generateConstraintId(),
            type,
            targets: [{ kind: "Grid", gridId: target.id }],
        };
        executeCommand(new AddConstraintCommand(c));

        const verts = gridVertices(target.curve);
        if (verts.length < 2) return;
        if (type === "Horizontal") {
            const avgZ = verts.reduce((s, v) => s + v[2], 0) / verts.length;
            const moved: Vec3[] = verts.map((v) => [v[0], v[1], avgZ] as Vec3);
            const newCurve = curveFromVertices(moved);
            if (newCurve) updateGrid(target.id, { curve: newCurve });
        } else {
            const avgX = verts.reduce((s, v) => s + v[0], 0) / verts.length;
            const moved: Vec3[] = verts.map((v) => [avgX, v[1], v[2]] as Vec3);
            const newCurve = curveFromVertices(moved);
            if (newCurve) updateGrid(target.id, { curve: newCurve });
        }
    };

    const [originDistanceInput, setOriginDistanceInput] = useState<string>("");

    /** 原点 - 通芯線の **垂直距離** を計算 (符号は通芯の右側 = +)。 */
    const computeOriginDistance = (): number | null => {
        if (!grid) return null;
        const v = gridVertices(grid.curve);
        if (v.length < 2) return null;
        const dx = v[1][0] - v[0][0], dz = v[1][2] - v[0][2];
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) return null;
        const nx = -dz / len, nz = dx / len;
        const signed = (0 - v[0][0]) * nx + (0 - v[0][2]) * nz;
        return Math.abs(signed);
    };

    /**
     * 通芯と原点間の距離拘束。Length(Grid, Origin) を保存し、その後通芯を
     * 法線方向に平行移動させて指定距離に合わせる。grid-grid 距離拘束と同じ
     * 設計 (= 通芯を直接動かす)。
     */
    const addGridOriginDistance = () => {
        const v = parseFloat(originDistanceInput);
        if (!Number.isFinite(v) || v <= 0) return;
        if (!grid) return;
        const c: Constraint = {
            id: generateConstraintId(),
            type: "Length",
            targets: [
                { kind: "Grid", gridId: grid.id },
                { kind: "Origin" },
            ],
            value: v,
        };
        executeCommand(new AddConstraintCommand(c));

        const verts = gridVertices(grid.curve);
        if (verts.length < 2) return;
        const ax = verts[0][0], az = verts[0][2];
        const bx = verts[1][0], bz = verts[1][2];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) return;
        const nx = -dz / len, nz = dx / len;
        // 原点 (0,0) から通芯線への符号付き距離 (= 線の現在位置から原点への n 成分)。
        const signed = (0 - ax) * nx + (0 - az) * nz;
        // 通芯を「原点とは反対方向」へ |D - currentDistance| 動かす想定。
        // signed > 0 なら原点が +n 側 → 通芯を +n 側へ動かして遠ざける際には
        // delta = +(D - |signed|) を +n 方向 (= -signed 反対) に乗せる。
        const sign = signed >= 0 ? -1 : +1; // 原点から離れる方向
        const delta = (v - Math.abs(signed)) * sign;
        if (Math.abs(delta) < 1e-9) return;
        const moved: Vec3[] = verts.map((p) => [p[0] + delta * nx, p[1], p[2] + delta * nz] as Vec3);
        const newCurve = curveFromVertices(moved);
        if (newCurve) updateGrid(grid.id, { curve: newCurve });
    };

    /**
     * 通芯線が **原点を通る** ように配置 (= Coincident 相当)。
     * Coincident 拘束 (Grid line passes through Origin) を保存し、通芯を
     * 法線方向に平行移動して原点が線上に乗るようにする。
     */
    const addGridOriginCoincident = () => {
        if (!grid) return;
        const c: Constraint = {
            id: generateConstraintId(),
            type: "Length",
            targets: [
                { kind: "Grid", gridId: grid.id },
                { kind: "Origin" },
            ],
            value: 0, // 距離 0 = 通芯が原点を通る
        };
        executeCommand(new AddConstraintCommand(c));

        const verts = gridVertices(grid.curve);
        if (verts.length < 2) return;
        const ax = verts[0][0], az = verts[0][2];
        const bx = verts[1][0], bz = verts[1][2];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-9) return;
        const nx = -dz / len, nz = dx / len;
        const signed = (0 - ax) * nx + (0 - az) * nz;
        // 通芯を原点が線上に乗るよう平行移動 (= +signed * n だけ動かす)。
        const delta = signed;
        if (Math.abs(delta) < 1e-9) return;
        const moved: Vec3[] = verts.map((p) => [p[0] + delta * nx, p[1], p[2] + delta * nz] as Vec3);
        const newCurve = curveFromVertices(moved);
        if (newCurve) updateGrid(grid.id, { curve: newCurve });
    };

    if (selectedGridIds.length > 1) {
        const currentDist = computeCurrentGridDistance();
        return (
            <div className="space-y-3 text-xs">
                <div className="text-zinc-300 font-medium">通芯: {selectedGridIds.length} 本選択中</div>
                <div className="text-zinc-500 text-[10px]">
                    {grids
                        .filter((g) => selectedGridIds.includes(g.id))
                        .map((g) => g.name)
                        .join(", ")}
                </div>
                {selectedGridIds.length === 2 && (
                    <div className="space-y-2 p-2 bg-zinc-950 rounded border border-zinc-800">
                        <div className="text-[10px] text-zinc-500 uppercase">通芯間拘束</div>
                        {currentDist !== null && (
                            <div className="text-[10px] text-zinc-500">
                                現在距離: {currentDist.toFixed(3)} m
                            </div>
                        )}
                        <div className="flex items-center gap-1">
                            <input
                                className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                                type="number"
                                step="0.1"
                                placeholder={currentDist !== null ? currentDist.toFixed(3) : "距離 m"}
                                value={distanceInput}
                                onChange={(e) => setDistanceInput(e.target.value)}
                            />
                            <button
                                className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px] disabled:opacity-30 disabled:cursor-not-allowed"
                                disabled={!distanceInput}
                                onClick={addGridGridDistance}
                                title="2 本の通芯間距離を Length 拘束として登録 (両通芯は固定値、現位置の検証用)"
                            >距離 ↔</button>
                        </div>
                        <div className="flex gap-1">
                            <button
                                className="flex-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px]"
                                onClick={() => addGridGridConstraint("Parallel")}
                                title="2 本の通芯を平行に拘束"
                            >平行 ∥</button>
                            <button
                                className="flex-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px]"
                                onClick={() => addGridGridConstraint("Perpendicular")}
                                title="2 本の通芯を直交に拘束"
                            >直交 ⊥</button>
                        </div>
                    </div>
                )}
                <button
                    className="w-full px-2 py-1 bg-red-700/60 hover:bg-red-600/60 rounded text-zinc-100"
                    onClick={() => {
                        removeGrids(selectedGridIds);
                        setSelectedGridIds([]);
                    }}
                >
                    選択した通芯を削除
                </button>
                <button
                    className="w-full px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300"
                    onClick={() => setSelectedGridIds([])}
                >
                    選択解除
                </button>
            </div>
        );
    }

    const length = gridSegments(grid.curve).reduce(
        (sum, s) => sum + Math.hypot(s.b[0] - s.a[0], s.b[2] - s.a[2]),
        0,
    );

    const commitName = () => {
        const r = renameGrid(grid.id, nameInput);
        setWarning(r.warning ?? null);
    };

    return (
        <div className="space-y-3 text-xs">
            <div className="text-zinc-300 font-medium">通芯: {grid.name}</div>
            <div className="text-zinc-500">Type: GridLine ({grid.kind})</div>

            <div>
                <label className="block text-zinc-400 mb-1">名前</label>
                <input
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-zinc-100 outline-none focus:border-blue-500"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                />
                {warning && (
                    <div className="text-amber-400 text-[10px] mt-1">⚠ {warning}</div>
                )}
            </div>

            <div>
                <label className="block text-zinc-400 mb-1">系列</label>
                <div className="flex gap-1">
                    <button
                        className={`flex-1 px-2 py-1 rounded border ${grid.kind === "Primary" ? "bg-pink-600/40 border-pink-500 text-zinc-100" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700"}`}
                        onClick={() => updateGrid(grid.id, { kind: "Primary" })}
                    >
                        Primary
                    </button>
                    <button
                        className={`flex-1 px-2 py-1 rounded border ${grid.kind === "Auxiliary" ? "bg-orange-600/40 border-orange-500 text-zinc-100" : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700"}`}
                        onClick={() => updateGrid(grid.id, { kind: "Auxiliary" })}
                    >
                        Auxiliary
                    </button>
                </div>
            </div>

            <div className="space-y-1 p-2 bg-zinc-950 rounded border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">姿勢拘束</div>
                <div className="flex gap-1">
                    <button
                        className="flex-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px]"
                        onClick={() => addSingleGridConstraint("Horizontal")}
                        title="通芯を水平 (X 軸方向) に揃える"
                    >水平 ━</button>
                    <button
                        className="flex-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px]"
                        onClick={() => addSingleGridConstraint("Vertical")}
                        title="通芯を垂直 (Z 軸方向) に揃える"
                    >垂直 ┃</button>
                </div>
            </div>

            <div className="space-y-2 p-2 bg-zinc-950 rounded border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">原点との拘束</div>
                {(() => {
                    const d = computeOriginDistance();
                    return d !== null ? (
                        <div className="text-[10px] text-zinc-500">
                            現在距離: {d.toFixed(3)} m
                        </div>
                    ) : null;
                })()}
                <div className="flex items-center gap-1">
                    <input
                        className="flex-1 min-w-0 text-[10px] px-1 py-1 bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                        type="number"
                        step="0.1"
                        placeholder="距離 m"
                        value={originDistanceInput}
                        onChange={(e) => setOriginDistanceInput(e.target.value)}
                    />
                    <button
                        className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px] disabled:opacity-30 disabled:cursor-not-allowed"
                        disabled={!originDistanceInput}
                        onClick={addGridOriginDistance}
                        title="通芯を原点から指定距離に移動 (法線方向)"
                    >距離 ↔</button>
                </div>
                <button
                    className="w-full px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-100 text-[10px]"
                    onClick={addGridOriginCoincident}
                    title="通芯線が原点を通るように移動 (距離 0)"
                >原点を通る ⊙</button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">表示</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.visible ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { visible: !grid.visible })}
                >
                    {grid.visible ? "ON" : "OFF"}
                </button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">ロック</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.locked ? "bg-amber-600/40 text-amber-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { locked: !grid.locked })}
                >
                    {grid.locked ? "LOCKED" : "UNLOCKED"}
                </button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">Bubble Start</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.bubbleStart !== false ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { bubbleStart: grid.bubbleStart === false })}
                >
                    {grid.bubbleStart !== false ? "ON" : "OFF"}
                </button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-zinc-400">Bubble End</span>
                <button
                    className={`px-2 py-0.5 rounded text-[10px] ${grid.bubbleEnd !== false ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"}`}
                    onClick={() => updateGrid(grid.id, { bubbleEnd: grid.bubbleEnd === false })}
                >
                    {grid.bubbleEnd !== false ? "ON" : "OFF"}
                </button>
            </div>

            <div className="text-zinc-500">長さ: {length.toFixed(2)} m</div>

            <button
                className="w-full mt-2 px-2 py-1 bg-red-700/60 hover:bg-red-600/60 rounded text-zinc-100"
                onClick={() => {
                    removeGrid(grid.id);
                    setSelectedGridIds([]);
                }}
            >
                通芯を削除
            </button>
            <button
                className="w-full px-2 py-1 bg-zinc-800 border border-red-800/50 hover:bg-red-900/40 rounded text-rose-300"
                onClick={() => {
                    if (confirm(`全 ${grids.length} 本の通芯を削除しますか？`)) clearGrids();
                }}
            >
                全 Grid を削除
            </button>
        </div>
    );
}
