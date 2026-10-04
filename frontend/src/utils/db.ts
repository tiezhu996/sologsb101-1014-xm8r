/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 验收固定保存当次栽植株数；栽植变化后相关验收先失效，复核时保留或重算
 * - 关联回写（地块缺株数）走待办队列，失败可反复重试，并与有效补植计划逐株对账
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, SurveyReviewDecision } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { PendingWrite } from '../types/outbox';
import { rateLevel, calcSurvivalRate } from './rate';
import { reconcilePlot } from './reconcile';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** 旧数据补证时成活率反算株数的容差（百分点，仅导入快照时尽力补证） */
const PROVE_RATE_TOLERANCE_PP = 0.15;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  /** 关联写入待办队列（outbox 模式） */
  pendingWrites!: Table<PendingWrite, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：验收固定当次栽植株数、补植来源追溯、关联写入待办队列 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade, validity',
        replants: 'id, plotId, planDate, state, species, sourceSurveyId',
        pendingWrites: 'id, kind, plotId',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();
        // 迁移 4：验收补齐当次栽植株数与有效性
        // 能由现存栽植总株数严格证明、或由旧成活率唯一反推出整数株数的自动回填；
        // 证明不了的留在「待补证」，交人工补证。
        const plantings = await tx
          .table('plantings')
          .toCollection()
          .toArray() as Array<Record<string, unknown>>;
        const totalByPlot = new Map<string, number>();
        for (const planting of plantings) {
          const plotId = String(planting.plotId ?? '');
          totalByPlot.set(plotId, (totalByPlot.get(plotId) ?? 0) + Number(planting.count ?? 0));
        }
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.plantedCount !== 'number' || !Number.isFinite(row.plantedCount)) {
            const current = totalByPlot.get(String(row.plotId ?? '')) ?? null;
            const proven = provePlantedCount(
              Number(row.aliveCount ?? 0),
              typeof row.survivalRate === 'number' ? row.survivalRate : 0,
              current,
            );
            if (proven === null) {
              row.plantedCount = null;
              row.validity = 'unproven';
            } else {
              row.plantedCount = proven.plantedCount;
              // 严格由现存栽植证明且株数一致 → 有效；其余（唯一反推或与现状不符）→ 待复核
              row.validity = proven.provenance === 'exact' && current === proven.plantedCount ? 'effective' : 'stale';
            }
          } else if (typeof row.validity !== 'string') {
            row.validity = 'effective';
          }
          // 已带 plantedCount 但与当前栽植总株数不一致的，标记待复核，交人工决定保留或重算
          if (row.validity === 'effective') {
            const total = totalByPlot.get(String(row.plotId ?? ''));
            if (total !== undefined && row.plantedCount !== total) row.validity = 'stale';
          }
          row.revision = ROW_REVISION;
          row.updatedAt = stamp;
        });
        // 迁移 5：补植计划补齐来源验收与当时缺株（历史计划无法溯源，留空串手工口径）
        await tx.table('replants').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.sourceSurveyId !== 'string') row.sourceSurveyId = '';
          if (typeof row.sourceMissingCount !== 'number') {
            row.sourceMissingCount = typeof row.missingCount === 'number' ? row.missingCount : 0;
          }
          row.revision = ROW_REVISION;
        });
        // 迁移 6：其余表修订号推进
        for (const name of ['plots', 'seedlings', 'plantings']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
            });
        }
      });
  }
}

export const db = new MangroveDatabase();

/* --------------------------- 旧数据补证 / 归一化 --------------------------- */

/**
 * 由旧验收的成活率与成活株数反算当次栽植株数。
 * 能在容差内对上整数株数才视为「可证明」，否则返回 null（留在待补证）。
 */
export function inferPlantedCount(survey: { aliveCount?: unknown; survivalRate?: unknown }): number | null {
  const alive = typeof survey.aliveCount === 'number' && Number.isFinite(survey.aliveCount) ? survey.aliveCount : null;
  const rate = typeof survey.survivalRate === 'number' && Number.isFinite(survey.survivalRate) ? survey.survivalRate : null;
  if (alive === null || rate === null || rate <= 0) return null;
  const total = Math.round((alive * 100) / rate);
  if (total <= 0) return null;
  const backRate = Math.round((alive / total) * 1000) / 10;
  return Math.abs(backRate - Math.round(rate * 10) / 10) <= PROVE_RATE_TOLERANCE_PP ? total : null;
}

export interface ProvenPlanted {
  /** 证明出的当次栽植株数 */
  plantedCount: number;
  /**
   * provenance = exact：由现存栽植总株数严格证明（回算成活率与记录完全一致）；
   * provenance = inferred：无现存栽植可证，但成活率可唯一反推出整数株数；
   */
  provenance: 'exact' | 'inferred';
}

/**
 * 迁移路径的严格补证（证据强度高于 inferPlantedCount）：
 * 1）若现存栽植总株数回算的成活率（1 位小数四舍五入）与记录完全一致 → 严格证明；
 * 2）否则，在不超过现存总株数的候选中，若存在唯一一个其回算成活率等于记录值 → 唯一反推；
 * 3）都不满足则返回 null，留在待补证，交人工处理。
 */
export function provePlantedCount(
  aliveCount: number,
  recordedRate: number,
  currentTotal: number | null,
): ProvenPlanted | null {
  if (!Number.isFinite(aliveCount) || !Number.isFinite(recordedRate) || recordedRate <= 0) return null;
  const target = Math.round(recordedRate * 10) / 10;
  if (currentTotal !== null && currentTotal > 0) {
    const backRate = Math.round((aliveCount / currentTotal) * 1000) / 10;
    if (backRate === target) return { plantedCount: currentTotal, provenance: 'exact' };
  }
  const upper = currentTotal !== null && currentTotal > 0 ? currentTotal : Math.ceil(aliveCount * 100);
  const candidates: number[] = [];
  for (let total = 1; total <= upper; total += 1) {
    if (Math.round((aliveCount / total) * 1000) / 10 === target) candidates.push(total);
  }
  if (candidates.length === 1) return { plantedCount: candidates[0], provenance: 'inferred' };
  return null;
}

/** 验收行补齐 v3 字段（升级与导入共用） */
function normalizeSurvey(row: Record<string, unknown>, stamp: string): Survey {
  const plantedCount =
    typeof row.plantedCount === 'number' && Number.isFinite(row.plantedCount)
      ? row.plantedCount
      : inferPlantedCount(row);
  const validity = plantedCount === null ? 'unproven' : 'effective';
  const rate =
    typeof row.survivalRate === 'number'
      ? row.survivalRate
      : plantedCount !== null
        ? calcSurvivalRate(Number(row.aliveCount ?? 0), plantedCount)
        : 0;
  return {
    id: String(row.id),
    plotId: String(row.plotId),
    round: Number(row.round ?? 1),
    date: String(row.date ?? ''),
    aliveCount: Number(row.aliveCount ?? 0),
    avgHeightCm: Number(row.avgHeightCm ?? 0),
    plantedCount,
    survivalRate: rate,
    grade: typeof row.grade === 'string' ? (row.grade as Survey['grade']) : rateLevel(rate),
    gradeManual: typeof row.gradeManual === 'boolean' ? row.gradeManual : false,
    validity,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : stamp,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : stamp,
    revision: ROW_REVISION,
  };
}

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种；打开后先排空一次关联写入队列。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
      // 上次会话可能有已入队但未落地的关联回写；同时对所有地块做一次逐株对账自愈
      await reconcileAllPlots();
      await drainPendingWrites();
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与待办 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw', [
    db.plots,
    db.seedlings,
    db.plantings,
    db.surveys,
    db.replants,
    db.pendingWrites,
    ],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.pendingWrites.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除批次：引用它的栽植记录一并清理，并令相关验收失效、重新对账 */
export async function removeSeedling(id: string): Promise<void> {
  await db.transaction(
    'rw', [
    db.seedlings,
    db.plantings,
    db.surveys,
    db.replants,
    db.plots,
    db.pendingWrites,
    ],
    async () => {
      const seedling = await db.seedlings.get(id);
      await db.plantings.where('seedlingId').equals(id).delete();
      await db.seedlings.delete(id);
      if (seedling) {
        await invalidatePlotSurveys(seedling.plotId);
        await enqueuePlotReconcile(seedling.plotId);
      }
    },
  );
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

/**
 * 新增 / 修订栽植记录：
 * 同事务内令受影响地块「冻结株数已与现状不符」的验收转入待复核，并按有效补植计划重新对账缺株数。
 */
export async function putPlanting(row: Planting): Promise<void> {
  await db.transaction(
    'rw', [
    db.plantings,
    db.surveys,
    db.replants,
    db.plots,
    db.pendingWrites,
    ],
    async () => {
      const previous = await db.plantings.get(row.id);
      await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
      const affected = new Set([row.plotId]);
      if (previous && previous.plotId !== row.plotId) affected.add(previous.plotId);
      for (const plotId of affected) {
        await invalidatePlotSurveys(plotId);
        await enqueuePlotReconcile(plotId);
      }
    },
  );
}

/** 删除栽植记录：相关验收先失效，缺株数重新对账 */
export async function removePlanting(id: string): Promise<void> {
  await db.transaction(
    'rw', [
    db.plantings,
    db.surveys,
    db.replants,
    db.plots,
    db.pendingWrites,
    ],
    async () => {
      const existing = await db.plantings.get(id);
      await db.plantings.delete(id);
      if (existing) {
        await invalidatePlotSurveys(existing.plotId);
        await enqueuePlotReconcile(existing.plotId);
      }
    },
  );
}

/**
 * 令地块内「冻结株数已与当前栽植总株数不一致」的有效验收转入待复核；
 * 恰好一致的测次不受影响（如补录后又改回），已待复核 / 待补证的保持原状。
 * 必须在栽植表完成写入 / 删除之后调用。
 */
async function invalidatePlotSurveys(plotId: string): Promise<void> {
  const plantings = await db.plantings.where('plotId').equals(plotId).toArray();
  const total = plantings.reduce((acc, row) => acc + row.count, 0);
  await db.surveys.where('plotId').equals(plotId).modify((row: Survey) => {
    if (row.validity === 'effective' && row.plantedCount !== total) {
      row.validity = 'stale';
      row.updatedAt = nowIso();
    }
  });
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

/** 低层写入：成活率 / 株数快照以调用方为准，仅兜底等级与修订号 */
export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 录入新测次：固定保存当次栽植株数，成活率当场冻结 */
export async function createSurveyRecord(
  draft: { plotId: string; round: number; date: string; aliveCount: number; avgHeightCm: number },
): Promise<Survey> {
  const stamp = nowIso();
  return db.transaction('rw', db.surveys, db.plantings, db.replants, db.plots, db.pendingWrites, async () => {
    const total = await currentPlantedCountInTx(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const row: Survey = {
      id: `survey-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      plantedCount: total,
      survivalRate,
      grade: rateLevel(survivalRate),
      gradeManual: false,
      validity: 'effective',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.surveys.put(row);
    await enqueuePlotReconcile(draft.plotId);
    return row;
  });
}

/**
 * 普通编辑测次：只改实测值，株数快照与有效性保持不变
 * （待复核测次即便改了成活株数，仍需走「保留 / 重算 / 补证」复核决定）。
 */
export async function updateSurveyFrozen(
  id: string,
  draft: { plotId: string; round: number; date: string; aliveCount: number; avgHeightCm: number },
): Promise<void> {
  await db.transaction('rw', [db.surveys, db.plantings, db.replants, db.plots, db.pendingWrites], async () => {
    const existing = await db.surveys.get(id);
    if (!existing) return;
    const survivalRate =
      existing.plantedCount !== null ? calcSurvivalRate(draft.aliveCount, existing.plantedCount) : existing.survivalRate;
    await db.surveys.put({
      ...existing,
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      grade: existing.gradeManual ? existing.grade : rateLevel(survivalRate),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
    // 测次跨地块移动时，旧地块与新地块都要重新对账
    await enqueuePlotReconcile(draft.plotId);
    if (existing.plotId !== draft.plotId) await enqueuePlotReconcile(existing.plotId);
  });
}

/**
 * 复核决定（针对待复核 / 待补证测次）：
 * - keep 保留原测次：冻结株数不变，恢复有效；
 * - recompute 按新株数重算：快照更新为当前栽植总株数并重算成活率 / 等级；
 * - prove 人工补证：以补证株数为冻结株数重算。
 */
export async function reviewSurvey(id: string, decision: SurveyReviewDecision): Promise<Survey | null> {
  return db.transaction('rw', [db.surveys, db.plantings, db.replants, db.plots, db.pendingWrites], async () => {
    const existing = await db.surveys.get(id);
    if (!existing) return null;
    let plantedCount = existing.plantedCount;
    if (decision.action === 'recompute') {
      plantedCount = await currentPlantedCountInTx(existing.plotId);
      if (plantedCount <= 0) {
        throw new Error('当前没有栽植记录可作为株数依据，请先补录栽植或改用「保留原测次」');
      }
    } else if (decision.action === 'prove') {
      const proven = Math.max(0, Math.floor(decision.provenCount ?? 0));
      if (proven <= 0) throw new Error('补证株数必须为大于 0 的整数');
      plantedCount = proven;
    }
    const survivalRate =
      plantedCount !== null ? calcSurvivalRate(existing.aliveCount, plantedCount) : existing.survivalRate;
    const next: Survey = {
      ...existing,
      plantedCount,
      survivalRate,
      // 保留 / 重算 / 补证后等级一律按新口径自动判定（人工等级可之后再标）
      grade: rateLevel(survivalRate),
      gradeManual: false,
      // 保留原测次但历史株数本就无法证明时，仍然停在待补证
      validity: plantedCount === null ? 'unproven' : 'effective',
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await db.surveys.put(next);
    // 来源测次恢复有效后，挂在它名下的未完成计划重新进入有效范围
    await enqueuePlotReconcile(existing.plotId);
    return next;
  });
}

/** 批量调整成活率等级（人工复核覆盖；不影响数值与有效性） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

/** 删除测次：来源计划随之退出有效范围，缺株数重新对账 */
export async function removeSurvey(id: string): Promise<void> {
  await db.transaction('rw', db.surveys, db.plantings, db.replants, db.plots, db.pendingWrites, async () => {
    const existing = await db.surveys.get(id);
    await db.surveys.delete(id);
    if (existing) await enqueuePlotReconcile(existing.plotId);
  });
}

async function currentPlantedCountInTx(plotId: string): Promise<number> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.reduce((acc, row) => acc + row.count, 0);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

/** 保存补植计划并按最新有效范围重新对账（手工计划 sourceSurveyId 传空串） */
export async function saveReplant(row: Replant): Promise<void> {
  await db.transaction('rw', db.replants, db.surveys, db.plantings, db.plots, db.pendingWrites, async () => {
    await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    await enqueuePlotReconcile(row.plotId);
  });
}

export async function removeReplant(id: string): Promise<void> {
  await db.transaction('rw', db.replants, db.surveys, db.plantings, db.plots, db.pendingWrites, async () => {
    const existing = await db.replants.get(id);
    await db.replants.delete(id);
    if (existing) await enqueuePlotReconcile(existing.plotId);
  });
}

/**
 * 推进补植状态。进入「已补植」时不改写任何验收测次（成活率以测次冻结株数为准），
 * 只把「逐株对账缺株数 + 最近补植日期」作为关联回写放入待办队列，失败可重试。
 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.transaction('rw', db.replants, db.surveys, db.plantings, db.plots, db.pendingWrites, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
    await enqueuePlotReconcile(replant.plotId, next === '已补植' ? today() : undefined);
  });
}

/* ------------------------- 关联写入队列（outbox） ------------------------- */

const RECONCILE_ID = (plotId: string): string => `plot_reconcile:${plotId}`;

/**
 * 入队一次地块缺株数对账。值为绝对目标值（天然幂等）：
 * 地块缺株数 = 有效待补植计划缺株逐株合计。
 * 需在已含 plantings/surveys/replants/plots/pendingWrites 的事务内调用。
 */
async function enqueuePlotReconcile(plotId: string, lastReplantDate?: string): Promise<void> {
  const stamp = nowIso();
  const [surveys, plantings, replants] = await Promise.all([
    db.surveys.where('plotId').equals(plotId).toArray(),
    db.plantings.where('plotId').equals(plotId).toArray(),
    db.replants.where('plotId').equals(plotId).toArray(),
  ]);
  const view = reconcilePlot(plotId, surveys, plantings, replants);
  const id = RECONCILE_ID(plotId);
  const existing = await db.pendingWrites.get(id);
  const row: PendingWrite = {
    id,
    kind: 'plot_reconcile',
    plotId,
    payload: {
      missingCount: view.missingCount,
      lastReplantDate: lastReplantDate ?? existing?.payload.lastReplantDate,
    },
    attempts: existing?.attempts ?? 0,
    lastError: existing?.lastError ?? '',
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  await db.pendingWrites.put(row);
}

export async function listPendingWrites(): Promise<PendingWrite[]> {
  return db.pendingWrites.toArray();
}

/**
 * 启动 / 维护时的全量逐株对账自愈：
 * 对每个地块比对「记录缺株数」与「有效待补植计划合计」，不一致且尚无待办时补入一条对账写入。
 * 幂等，可反复执行。
 */
export async function reconcileAllPlots(): Promise<void> {
  const [plots, surveys, plantings, replants, pending] = await Promise.all([
    db.plots.toArray(),
    db.surveys.toArray(),
    db.plantings.toArray(),
    db.replants.toArray(),
    db.pendingWrites.toArray(),
  ]);
  const queuedPlotIds = new Set(pending.map((row) => row.plotId));
  const stamp = nowIso();
  const rows: PendingWrite[] = [];
  for (const plot of plots) {
    const view = reconcilePlot(plot.id, surveys, plantings, replants);
    if (plot.missingCount === view.missingCount) continue;
    if (queuedPlotIds.has(plot.id)) continue;
    rows.push({
      id: RECONCILE_ID(plot.id),
      kind: 'plot_reconcile',
      plotId: plot.id,
      payload: { missingCount: view.missingCount },
      attempts: 0,
      lastError: '',
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  if (rows.length > 0) await db.pendingWrites.bulkPut(rows);
}

/** 测试 / 维护用途：在既有事务之外补入一次地块对账（内部自行开启事务） */
export async function enqueuePlotReconcileStandalone(plotId: string, lastReplantDate?: string): Promise<void> {
  await db.transaction('rw', [db.plots, db.surveys, db.plantings, db.replants, db.pendingWrites], async () => {
    await enqueuePlotReconcile(plotId, lastReplantDate);
  });
}

export interface DrainResult {
  applied: number;
  failed: number;
}

/**
 * 排空关联写入队列：逐条落地到 plots 表，成功出队，失败留队并累计尝试次数，
 * 之后（启动 / 网络恢复 / 手动按钮）还能继续重试。
 */
export async function drainPendingWrites(): Promise<DrainResult> {
  const pending = await db.pendingWrites.toArray();
  let applied = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      await db.transaction('rw', db.plots, db.pendingWrites, async () => {
        const plot = await db.plots.get(item.plotId);
        if (!plot) {
          // 地块已被删除，待办随之作废
          await db.pendingWrites.delete(item.id);
          return;
        }
        const patch: Partial<Plot> = {
          missingCount: item.payload.missingCount,
          updatedAt: nowIso(),
        };
        if (item.payload.lastReplantDate) {
          patch.lastReplantDate = item.payload.lastReplantDate;
        }
        await db.plots.update(item.plotId, patch);
        await db.pendingWrites.delete(item.id);
      });
      applied += 1;
    } catch (err) {
      failed += 1;
      try {
        await db.pendingWrites.update(item.id, {
          attempts: item.attempts + 1,
          lastError: err instanceof Error ? err.message : '关联写入失败',
          updatedAt: nowIso(),
        });
      } catch {
        /* 连失败标记都写不进时，下轮再试 */
      }
    }
  }
  return { applied, failed };
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
  };
}

/** 用快照覆盖整库（导入存档）：归一化新字段并重建对账队列 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const stamp = nowIso();
  await db.transaction(
    'rw', [
    db.plots,
    db.seedlings,
    db.plantings,
    db.surveys,
    db.replants,
    db.pendingWrites,
    ],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.pendingWrites.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut((snapshot.surveys as unknown as Array<Record<string, unknown>>).map((row) => normalizeSurvey(row, stamp)));
      await db.replants.bulkPut(
        snapshot.replants.map((row) => ({
          ...row,
          sourceSurveyId: typeof row.sourceSurveyId === 'string' ? row.sourceSurveyId : '',
          sourceMissingCount:
            typeof row.sourceMissingCount === 'number' ? row.sourceMissingCount : row.missingCount,
          revision: ROW_REVISION,
        })),
      );
      // 导入数据未必自洽：按当前有效范围逐地块重建对账待办
      const plots = await db.plots.toArray();
      const [surveys, plantings, replants] = await Promise.all([
        db.surveys.toArray(),
        db.plantings.toArray(),
        db.replants.toArray(),
      ]);
      const pending: PendingWrite[] = plots.map((plot) => {
        const view = reconcilePlot(plot.id, surveys, plantings, replants);
        return {
          id: RECONCILE_ID(plot.id),
          kind: 'plot_reconcile',
          plotId: plot.id,
          payload: { missingCount: view.missingCount },
          attempts: 0,
          lastError: '',
          createdAt: stamp,
          updatedAt: stamp,
        };
      });
      if (pending.length > 0) await db.pendingWrites.bulkPut(pending);
    },
  );
  await drainPendingWrites();
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw', [
    db.plots,
    db.seedlings,
    db.plantings,
    db.surveys,
    db.replants,
    db.pendingWrites,
    ],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.pendingWrites.clear(),
      ]);
    },
  );
  await seedDatabase();
  await drainPendingWrites();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, pendingWrites] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.pendingWrites.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, pendingWrites };
}
