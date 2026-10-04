/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 结构版本：v1 初版 → v2 补齐索引/回写字段 → v3
 *   验收固定当次栽植株数快照与有效性、补植计划记录来源验收/当时缺株、outbox 补偿队列
 * - 栽植记录变化采用「同事务写业务行 + outbox 任务」：关联写入成功即生效，
 *   失败的任务保留在 outbox，启动 / 手动触发时继续重试
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, SurveyReviewDecision } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { OutboxTask } from '../types/outbox';
import { calcSurvivalRate, rateLevel } from './rate';
import { expectedMissingOf } from './reconcile';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** 来源验收匹配计划日期的容差（天） */
const SOURCE_SURVEY_DATE_TOLERANCE_DAYS = 15;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  outbox!: Table<OutboxTask, string>;

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
    this.version(2).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
      seedlings: 'id, plotId, species, source, arrivalDate, quantity',
      plantings: 'id, plotId, seedlingId, plantDate, spacingM',
      // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
      surveys: 'id, plotId, [plotId+round], date, grade',
      replants: 'id, plotId, planDate, state, species',
    });

    // ---------- v3：验收固定株数快照 + 有效性、补植溯源、outbox 补偿队列 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade, validity',
        replants: 'id, plotId, planDate, state, species, sourceSurveyId',
        outbox: 'id, type, plotId, status, runAfter',
      })
      .upgrade(async (tx) => {
        // 迁移 1（v2 遗留）：补齐基础元数据与地块回写字段
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = 2;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });

        // 迁移 2（v3）：当前各地块栽植株数，用于证明旧验收的当次株数
        const allPlantings = (await tx.table('plantings').toArray()) as Planting[];
        const totalByPlot = new Map<string, number>();
        allPlantings.forEach((row) => {
          totalByPlot.set(row.plotId, (totalByPlot.get(row.plotId) ?? 0) + row.count);
        });

        // 验收记录：能由当前株数反推成活率的，自动回填株数快照并保持有效；否则留待补证
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const plotId = String(row.plotId ?? '');
          const total = totalByPlot.get(plotId) ?? 0;
          const alive = typeof row.aliveCount === 'number' ? row.aliveCount : 0;
          const storedRate = typeof row.survivalRate === 'number' ? row.survivalRate : null;
          const proven =
            total > 0 &&
            alive >= 0 &&
            alive <= total &&
            storedRate !== null &&
            calcSurvivalRate(alive, total) === storedRate;
          row.plantedCount = proven ? total : null;
          row.validity = proven ? 'valid' : 'pending_evidence';
          row.invalidReason = proven ? '' : '旧数据缺少当次栽植株数记录，无法证明成活率口径，请补证后复核';
          row.invalidatedAt = '';
          row.reviewedAt = '';
          row.reviewDecision = null;
        });

        const allSurveys = (await tx.table('surveys').toArray()) as Survey[];
        const surveysByPlot = new Map<string, Survey[]>();
        allSurveys.forEach((row) => {
          const list = surveysByPlot.get(row.plotId) ?? [];
          list.push(row);
          surveysByPlot.set(row.plotId, list);
        });

        // 补植计划：回填来源验收与当时缺株、已完成计划的实际补植株数
        await tx.table('replants').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.sourceSurveyId !== 'string') {
            const plotId = String(row.plotId ?? '');
            const planDate = typeof row.planDate === 'string' ? row.planDate : '';
            const candidates = (surveysByPlot.get(plotId) ?? []).slice().sort((a, b) => a.round - b.round);
            const toleranceMs = SOURCE_SURVEY_DATE_TOLERANCE_DAYS * 24 * 3600 * 1000;
            let source: Survey | undefined;
            if (planDate !== '') {
              source = candidates
                .filter((item) => item.date <= planDate)
                .sort((a, b) => b.date.localeCompare(a.date))[0];
              if (source === undefined) {
                const closest = candidates
                  .map((item) => ({ item, diff: Math.abs(new Date(item.date).getTime() - new Date(planDate).getTime()) }))
                  .filter((entry) => entry.diff <= toleranceMs)
                  .sort((a, b) => a.diff - b.diff)[0];
                source = closest?.item;
              }
            }
            row.sourceSurveyId = source?.id ?? '';
            const missing = source === undefined ? null : Math.max(0, (source.plantedCount ?? 0) - source.aliveCount);
            row.sourceMissingCount = source !== undefined && source.plantedCount !== null ? missing : 0;
          }
          const state = String(row.state ?? '待补植') as ReplantState;
          if (typeof row.replantedCount !== 'number') {
            row.replantedCount = state === '待补植' ? 0 : typeof row.missingCount === 'number' ? row.missingCount : 0;
          }
          if (typeof row.completedDate !== 'string') row.completedDate = '';
        });

        // 迁移 3（v3）：地块缺株数与有效补植计划逐株对账后重算
        const migratedSurveys = (await tx.table('surveys').toArray()) as Survey[];
        const migratedReplants = (await tx.table('replants').toArray()) as Replant[];
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          row.missingCount = expectedMissingOf(String(row.id ?? ''), migratedReplants, migratedSurveys);
        });
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise；打开后先补偿 outbox，再做一次全量对账兜底。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
      // 启动即继续重试历史失败的关联写入，并全量对账兜底
      void processOutbox().catch(() => undefined);
      void reconcileAllPlots().catch(() => undefined);
    })();
  }
  return initPromise;
}

/* ------------------------- 行结构归一（导入兼容） ------------------------- */

function normalizeSurvey(row: Record<string, unknown>): Survey {
  const survivalRate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
  const validity = row.validity === 'valid' || row.validity === 'invalid' || row.validity === 'pending_evidence'
    ? row.validity
    : typeof row.plantedCount === 'number'
      ? 'valid'
      : 'pending_evidence';
  return {
    id: String(row.id ?? ''),
    plotId: String(row.plotId ?? ''),
    round: Number(row.round ?? 1),
    date: String(row.date ?? ''),
    aliveCount: Number(row.aliveCount ?? 0),
    avgHeightCm: Number(row.avgHeightCm ?? 0),
    plantedCount: typeof row.plantedCount === 'number' ? row.plantedCount : null,
    survivalRate,
    grade: typeof row.grade === 'string' ? (row.grade as Survey['grade']) : rateLevel(survivalRate),
    gradeManual: Boolean(row.gradeManual),
    validity,
    invalidReason: typeof row.invalidReason === 'string' ? row.invalidReason : '',
    invalidatedAt: typeof row.invalidatedAt === 'string' ? row.invalidatedAt : '',
    reviewedAt: typeof row.reviewedAt === 'string' ? row.reviewedAt : '',
    reviewDecision: row.reviewDecision === 'keep' || row.reviewDecision === 'recalculate' ? row.reviewDecision : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : nowIso(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : nowIso(),
    revision: ROW_REVISION,
  };
}

function normalizeReplant(row: Record<string, unknown>): Replant {
  const state = (['待补植', '已补植', '已复核'].includes(String(row.state)) ? String(row.state) : '待补植') as ReplantState;
  return {
    id: String(row.id ?? ''),
    plotId: String(row.plotId ?? ''),
    missingCount: Number(row.missingCount ?? 0),
    sourceSurveyId: typeof row.sourceSurveyId === 'string' ? row.sourceSurveyId : '',
    sourceMissingCount: Number(row.sourceMissingCount ?? 0),
    planDate: String(row.planDate ?? ''),
    species: row.species as Replant['species'],
    state,
    replantedCount: Number(row.replantedCount ?? (state === '待补植' ? 0 : row.missingCount ?? 0)),
    completedDate: typeof row.completedDate === 'string' ? row.completedDate : '',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : nowIso(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : nowIso(),
    revision: ROW_REVISION,
  };
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

/** 删除地块并级联清理其下全部子记录与补偿任务 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.outbox],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.outbox.where('plotId').equals(id).delete();
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

/**
 * 删除苗木批次：引用它的栽植记录一并删除（避免悬空引用），
 * 并为受影响地块登记「栽植变化」补偿任务，随后驱动级联。
 */
export async function removeSeedling(id: string): Promise<void> {
  const affectedPlotIds: string[] = [];
  await db.transaction('rw', db.seedlings, db.plantings, db.outbox, async () => {
    const plantings = await db.plantings.where('seedlingId').equals(id).toArray();
    plantings.forEach((row) => {
      if (!affectedPlotIds.includes(row.plotId)) affectedPlotIds.push(row.plotId);
    });
    await db.plantings.where('seedlingId').equals(id).delete();
    const stamp = nowIso();
    for (const plotId of affectedPlotIds) {
      await enqueuePlantingChangedTx(plotId, stamp, '引用的苗木批次被删除');
    }
    await db.seedlings.delete(id);
  });
  void pumpOutboxSoon();
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

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 保存栽植记录（新增 / 修订）并触发级联：
 * 业务行与「栽植变化」补偿任务在同一事务提交，随后执行级联；
 * 级联失败时任务留在 outbox，启动或手动触发时继续重试。
 */
export async function savePlanting(row: Planting): Promise<void> {
  const stamp = nowIso();
  await db.transaction('rw', db.plantings, db.outbox, async () => {
    await db.plantings.put({ ...row, updatedAt: stamp, revision: ROW_REVISION });
    await enqueuePlantingChangedTx(row.plotId, stamp, '栽植记录补录或修订');
  });
  void pumpOutboxSoon();
}

/** 删除栽植记录并为地块登记补偿任务 */
export async function removePlanting(id: string): Promise<void> {
  const existing = await db.plantings.get(id);
  if (existing === undefined) return;
  const stamp = nowIso();
  await db.transaction('rw', db.plantings, db.outbox, async () => {
    await db.plantings.delete(id);
    await enqueuePlantingChangedTx(existing.plotId, stamp, '栽植记录删除');
  });
  void pumpOutboxSoon();
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

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖，不触碰有效性与株数快照） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

/**
 * 复核失效 / 待补证验收：
 * - keep：保留原测次，沿用固定株数快照（必须已有快照）；
 * - recalculate：按当前栽植总株数重算并重锚株数快照。
 * 复核后重新对账地块缺株数（来源恢复有效后，待补植计划重新计入）。
 */
export async function reviewSurvey(surveyId: string, decision: SurveyReviewDecision): Promise<Survey> {
  return db.transaction('rw', [db.surveys, db.replants, db.plots, db.plantings], async () => {
    const survey = await db.surveys.get(surveyId);
    if (survey === undefined) throw new Error('验收记录不存在或已被删除');
    const stamp = nowIso();
    let next = { ...survey };

    if (decision === 'keep') {
      if (survey.plantedCount === null || survey.plantedCount <= 0) {
        throw new Error('该测次缺少当次栽植株数，无法保留原测次，请改为按新株数重算或先补证');
      }
      next = {
        ...next,
        survivalRate: calcSurvivalRate(survey.aliveCount, survey.plantedCount),
        validity: 'valid',
        invalidReason: '',
        invalidatedAt: '',
        reviewedAt: stamp,
        reviewDecision: 'keep',
      };
    } else {
      const plantings = await db.plantings.where('plotId').equals(survey.plotId).toArray();
      const total = plantings.reduce((acc, item) => acc + item.count, 0);
      if (total <= 0) {
        throw new Error('该地块当前没有栽植记录，无法按新株数重算');
      }
      next = {
        ...next,
        plantedCount: total,
        survivalRate: calcSurvivalRate(survey.aliveCount, total),
        validity: 'valid',
        invalidReason: '',
        invalidatedAt: '',
        reviewedAt: stamp,
        reviewDecision: 'recalculate',
      };
    }
    next.grade = next.gradeManual ? next.grade : rateLevel(next.survivalRate);
    next.updatedAt = stamp;
    await db.surveys.put(next);
    await reconcilePlotInTx(survey.plotId);
    return next;
  });
}

/** 为待补证验收补录当次栽植株数，补齐后自动恢复有效 */
export async function provideSurveyEvidence(surveyId: string, plantedCount: number): Promise<Survey> {
  return db.transaction('rw', db.surveys, db.replants, db.plots, async () => {
    const survey = await db.surveys.get(surveyId);
    if (survey === undefined) throw new Error('验收记录不存在或已被删除');
    if (!Number.isFinite(plantedCount) || plantedCount <= 0) {
      throw new Error('请填写有效的当次栽植株数');
    }
    const stamp = nowIso();
    const next: Survey = {
      ...survey,
      plantedCount: Math.round(plantedCount),
      survivalRate: calcSurvivalRate(survey.aliveCount, Math.round(plantedCount)),
      validity: 'valid',
      invalidReason: '',
      invalidatedAt: '',
      reviewedAt: stamp,
      reviewDecision: survey.reviewDecision ?? 'keep',
      updatedAt: stamp,
    };
    next.grade = next.gradeManual ? next.grade : rateLevel(next.survivalRate);
    await db.surveys.put(next);
    await reconcilePlotInTx(survey.plotId);
    return next;
  });
}

/** 删除验收：引用它的待补植计划会因来源缺失自动退出有效范围，随后对账 */
export async function removeSurvey(id: string): Promise<void> {
  const survey = await db.surveys.get(id);
  await db.transaction('rw', db.surveys, db.replants, db.plots, async () => {
    await db.surveys.delete(id);
    if (survey !== undefined) await reconcilePlotInTx(survey.plotId);
  });
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

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除补植计划后重新对账地块缺株数 */
export async function removeReplant(id: string): Promise<void> {
  const replant = await db.replants.get(id);
  await db.transaction('rw', [db.replants, db.plots, db.surveys], async () => {
    await db.replants.delete(id);
    if (replant !== undefined) await reconcilePlotInTx(replant.plotId);
  });
}

/**
 * 补植完成：
 * 1）按缺株数落实际补植株数、记完成日期与最近补植日期；
 * 2）该计划退出「有效待补植」范围（已完成保留留痕）；
 * 3）地块缺株数按有效补植计划逐株对账重算。
 * 历史验收的固定株数快照不被改写。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, async () => {
    const replant = await db.replants.get(replantId);
    if (replant === undefined) return;
    const stamp = nowIso();
    const day = today();
    await db.replants.update(replant.id, {
      state: '已补植',
      replantedCount: Math.max(replant.replantedCount, replant.missingCount),
      completedDate: replant.completedDate !== '' ? replant.completedDate : day,
      updatedAt: stamp,
    });
    await db.plots.update(replant.plotId, { lastReplantDate: day, updatedAt: stamp });
    await reconcilePlotInTx(replant.plotId);
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），进入「已补植」时触发回写对账 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  const replant = await db.replants.get(replantId);
  if (replant === undefined) return;
  if (next !== '待补植' && replant.state === '待补植') {
    await applyReplantCompletion(replantId);
    if (next === '已复核') {
      await db.replants.update(replantId, { state: '已复核', updatedAt: nowIso() });
    }
    return;
  }
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
}

/* --------------------- 缺株数 ↔ 有效补植计划对账 --------------------- */

/** 事务内：按有效补植计划逐株重算并回写单个地块缺株数，返回对账差额 */
async function reconcilePlotInTx(plotId: string): Promise<number> {
  const [plot, replants, surveys] = await Promise.all([
    db.plots.get(plotId),
    db.replants.where('plotId').equals(plotId).toArray(),
    db.surveys.where('plotId').equals(plotId).toArray(),
  ]);
  if (plot === undefined) return 0;
  const expected = expectedMissingOf(plotId, replants, surveys);
  if (plot.missingCount !== expected) {
    await db.plots.update(plotId, { missingCount: expected, updatedAt: nowIso() });
  }
  return plot.missingCount - expected;
}

/** 对外：重算单个地块缺株数并与有效补植计划逐株对账 */
export async function reconcilePlot(plotId: string): Promise<number> {
  return db.transaction('rw', db.plots, db.replants, db.surveys, async () => reconcilePlotInTx(plotId));
}

/** 全量对账：所有地块缺株数与有效补植计划对齐，返回修正的地块数 */
export async function reconcileAllPlots(): Promise<number> {
  return db.transaction('rw', db.plots, db.replants, db.surveys, async () => {
    const plots = await db.plots.toArray();
    let fixed = 0;
    for (const plot of plots) {
      const drift = await reconcilePlotInTx(plot.id);
      if (drift !== 0) fixed += 1;
    }
    return fixed;
  });
}

/* --------------------------- 栽植变化级联 --------------------------- */

/**
 * 事务内：失效相关验收并对账缺株数。
 * 仅失效「自本次栽植变化后未再复核保留」的有效验收；
 * 已复核保留（reviewedAt ≥ changedAt）的测次不被重复打扰，待补证测次维持待补证。
 */
async function cascadePlantingChangedInTx(plotId: string, changedAt: string, reason: string): Promise<void> {
  await db.surveys.where('plotId').equals(plotId).modify((survey: Survey) => {
    if (
      survey.validity === 'valid' &&
      (survey.reviewedAt === '' || survey.reviewedAt < changedAt)
    ) {
      survey.validity = 'invalid';
      survey.invalidReason = `${reason}，早先验收的成活率口径待复核：保留原测次或按新株数重算`;
      survey.invalidatedAt = changedAt;
    }
  });
  await reconcilePlotInTx(plotId);
}

/** 事务内登记补偿任务（同地块同类任务去重，保留最早创建时间、更新触发时刻） */
async function enqueuePlantingChangedTx(plotId: string, changedAt: string, reason: string): Promise<void> {
  const id = `planting-changed:${plotId}`;
  const existing = await db.outbox.get(id);
  const stamp = nowIso();
  if (existing === undefined) {
    await db.outbox.put({
      id,
      type: 'planting_changed',
      plotId,
      status: 'pending',
      payload: { changedAt, reason },
      attempts: 0,
      lastError: '',
      runAfter: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    });
  } else {
    const prevChangedAt = typeof existing.payload.changedAt === 'string' ? existing.payload.changedAt : '';
    await db.outbox.put({
      ...existing,
      status: 'pending',
      payload: { changedAt: changedAt > prevChangedAt ? changedAt : prevChangedAt, reason },
      runAfter: stamp,
      lastError: '',
      updatedAt: stamp,
    });
  }
}

/** 事务内登记「仅对账」补偿任务 */
async function enqueueReconcileTx(plotId: string, reason: string): Promise<void> {
  const stamp = nowIso();
  await db.outbox.put({
    id: `reconcile:${plotId || 'all'}`,
    type: 'reconcile_plot',
    plotId,
    status: 'pending',
    payload: { reason },
    attempts: 0,
    lastError: '',
    runAfter: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

/** 列出待处理补偿任务（页面展示 / 手动重试入口） */
export async function listOutboxTasks(): Promise<OutboxTask[]> {
  const rows = await db.outbox.toArray();
  return rows.sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt));
}

/** 待处理补偿任务数（含退避等待中的） */
export async function countPendingOutbox(): Promise<number> {
  return db.outbox.where('status').equals('pending').count();
}

let outboxRunning: Promise<number> | null = null;

/** 取一个待处理任务并在独立事务中执行；成功删除任务，失败按指数退避保留 */
async function runOutboxTask(task: OutboxTask): Promise<boolean> {
  try {
    await db.transaction('rw', db.surveys, db.replants, db.plots, db.outbox, async () => {
      const changedAt = typeof task.payload.changedAt === 'string' ? task.payload.changedAt : task.createdAt;
      const reason = typeof task.payload.reason === 'string' ? task.payload.reason : '栽植记录变化';
      if (task.type === 'planting_changed') {
        await cascadePlantingChangedInTx(task.plotId, changedAt, reason);
      } else {
        const plotIds = task.plotId === '' ? (await db.plots.toArray()).map((row) => row.id) : [task.plotId];
        for (const plotId of plotIds) {
          await reconcilePlotInTx(plotId);
        }
      }
      await db.outbox.delete(task.id);
    });
    return true;
  } catch (err) {
    const attempts = task.attempts + 1;
    const delayMs = Math.min(1000 * 2 ** (attempts - 1), 3600 * 1000);
    await db.outbox.update(task.id, {
      attempts,
      lastError: err instanceof Error ? err.message : String(err),
      runAfter: new Date(Date.now() + delayMs).toISOString(),
      updatedAt: nowIso(),
    });
    return false;
  }
}

/** 处理全部到期补偿任务，返回成功条数；并发调用共用同一次执行 */
export function processOutbox(): Promise<number> {
  if (outboxRunning !== null) return outboxRunning;
  outboxRunning = (async (): Promise<number> => {
    let succeeded = 0;
    try {
      const now = nowIso();
      const tasks = await db.outbox.where('status').equals('pending').toArray();
      const due = tasks
        .filter((task) => task.runAfter <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const task of due) {
        if (await runOutboxTask(task)) succeeded += 1;
      }
    } finally {
      outboxRunning = null;
    }
    return succeeded;
  })();
  return outboxRunning;
}

/** 业务写入后尽快驱动一次补偿（失败静默，由 outbox 保留重试） */
function pumpOutboxSoon(): void {
  setTimeout(() => {
    void processOutbox().catch(() => undefined);
  }, 0);
}

/** 手动重试（补植计划页入口）：登记一次全量对账并立即处理到期任务 */
export async function retryOutbox(): Promise<number> {
  await db.transaction('rw', db.outbox, async () => {
    await enqueueReconcileTx('', '手动重试：全量逐株对账');
    const pending = await db.outbox.where('status').equals('pending').toArray();
    const stamp = nowIso();
    for (const task of pending) {
      await db.outbox.update(task.id, { runAfter: stamp });
    }
  });
  return processOutbox();
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
  /** 补偿任务可选导出；导入时不恢复 pending 任务，改由全量对账重建一致状态 */
  outbox?: OutboxTask[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, outbox] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.outbox.toArray(),
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
    outbox,
  };
}

/**
 * 用快照覆盖整库（导入存档）：
 * 旧版本快照先按当前行结构归一，导入后统一逐株对账，不恢复历史补偿任务。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.outbox],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.outbox.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => normalizeSurvey(row as unknown as Record<string, unknown>)));
      await db.replants.bulkPut(snapshot.replants.map((row) => normalizeReplant(row as unknown as Record<string, unknown>)));
      const plots = await db.plots.toArray();
      for (const plot of plots) {
        await reconcilePlotInTx(plot.id);
      }
    },
  );
}

/** 清空全部数据并重新灌入演示数据（bulkPut 不触发级联，播种数据自带一致状态） */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.outbox],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.outbox.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, outboxPending] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    countPendingOutbox(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, outboxPending };
}
