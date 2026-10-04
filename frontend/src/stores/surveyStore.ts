/**
 * 验收状态管理（Zustand）
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * - 验收保存时固定当次栽植株数快照，成活率口径此后不随栽植变化漂移；
 * - 栽植记录变化由 db.ts 级联把相关验收置为失效，复核时决定保留原测次或按新株数重算；
 * - 生成补植计划时记录来源验收与当时缺株。
 */
import { create } from 'zustand';
import type { RateLevel, Survey, SurveyDraft } from '../types/survey';
import {
  db,
  initDatabase,
  patchSurveyGrades,
  provideSurveyEvidence,
  putSurvey,
  reconcilePlot,
  removeSurvey,
  reviewSurvey,
  ROW_REVISION,
} from '../utils/db';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, uuid } from '../utils/id';
import { calcSurvivalRate, rateLevel } from '../utils/rate';
import type { Replant } from '../types/replant';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 有效性 + 关键字 + 日期区间） */
export interface SurveyFilters {
  plotId: string | 'all';
  level: RateLevel | 'all';
  validity: Survey['validity'] | 'all';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = {
  plotId: 'all',
  level: 'all',
  validity: 'all',
  keyword: '',
  from: '',
  to: '',
};

interface SurveyStoreState {
  filters: SurveyFilters;
  /** 批量操作选中的验收记录 id */
  selectedIds: string[];
  /** 批量调整使用的目标等级 */
  gradeDraft: RateLevel;
  /** 每次写操作后的版本号，页面据此重新拉取列表 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<SurveyFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  setGradeDraft: (level: RateLevel) => void;
  createSurvey: (draft: SurveyDraft) => Promise<Survey>;
  updateSurvey: (surveyId: string, draft: SurveyDraft) => Promise<void>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（人工复核） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /** 复核失效测次：保留原测次 */
  reviewKeep: (surveyId: string) => Promise<Survey>;
  /** 复核失效测次：按当前栽植株数重算并重锚快照 */
  reviewRecalculate: (surveyId: string) => Promise<Survey>;
  /** 为待补证测次补录当次栽植株数 */
  provideEvidence: (surveyId: string, plantedCount: number) => Promise<Survey>;
  /** 按最新有效测次生成补植计划（记录来源验收与当时缺株，并逐株对账地块缺株数） */
  generateReplant: (plotId: string) => Promise<string>;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
}

function totalPlantedOf(plotId: string): number {
  return usePlotStore
    .getState()
    .plantings.filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

/** 组装一条有效验收行，固定保存当次栽植株数 */
function buildSurveyRow(
  draft: SurveyDraft,
  existing: Partial<Survey> | null,
  stamp: string,
): { row: Survey; total: number } {
  const total = totalPlantedOf(draft.plotId);
  const plantedCount = existing?.plantedCount ?? total;
  const survivalRate = calcSurvivalRate(draft.aliveCount, plantedCount);
  const row: Survey = {
    id: existing?.id ?? uuid('survey'),
    plotId: draft.plotId,
    round: draft.round,
    date: draft.date,
    aliveCount: draft.aliveCount,
    avgHeightCm: draft.avgHeightCm,
    plantedCount,
    survivalRate,
    grade: existing?.gradeManual ? (existing.grade ?? rateLevel(survivalRate)) : rateLevel(survivalRate),
    gradeManual: existing?.gradeManual ?? false,
    validity: existing?.validity ?? 'valid',
    invalidReason: existing?.invalidReason ?? '',
    invalidatedAt: existing?.invalidatedAt ?? '',
    reviewedAt: existing?.reviewedAt ?? '',
    reviewDecision: existing?.reviewDecision ?? null,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  return { row, total };
}

export const useSurveyStore = create<SurveyStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  gradeDraft: 'good',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setGradeDraft(level) {
    set({ gradeDraft: level });
  },

  async createSurvey(draft) {
    const total = totalPlantedOf(draft.plotId);
    if (total <= 0) {
      throw new Error('该地块还没有栽植记录，请先登记栽植株数再验收');
    }
    const stamp = nowIso();
    const { row } = buildSurveyRow(draft, null, stamp);
    await putSurvey(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateSurvey(surveyId, draft) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    const stamp = nowIso();
    // 编辑仅改实测值，株数快照保持验收当次口径不变；失效 / 待补证状态不被编辑自动恢复
    const { row } = buildSurveyRow(draft, existing, stamp);
    row.validity = existing.validity;
    row.invalidReason = existing.invalidReason;
    row.invalidatedAt = existing.invalidatedAt;
    row.reviewedAt = existing.reviewedAt;
    row.reviewDecision = existing.reviewDecision;
    await putSurvey(row);
    set({ revision: get().revision + 1 });
  },

  async deleteSurvey(surveyId) {
    await removeSurvey(surveyId);
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async bulkApplyGrade(level) {
    const ids = get().selectedIds;
    if (ids.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值与株数快照，保证数据可追溯
    await patchSurveyGrades(ids, level);
    set({ revision: get().revision + 1, lastMessage: `已批量调整 ${ids.length} 条验收记录的成活率等级` });
    return ids.length;
  },

  async reviewKeep(surveyId) {
    const row = await reviewSurvey(surveyId, 'keep');
    set({
      revision: get().revision + 1,
      lastMessage: `第 ${row.round} 测次已保留原测次（固定株数 ${row.plantedCount ?? '-'} 株）`,
    });
    return row;
  },

  async reviewRecalculate(surveyId) {
    const row = await reviewSurvey(surveyId, 'recalculate');
    set({
      revision: get().revision + 1,
      lastMessage: `第 ${row.round} 测次已按新株数 ${row.plantedCount ?? '-'} 株重算，成活率 ${row.survivalRate}%`,
    });
    return row;
  },

  async provideEvidence(surveyId, plantedCount) {
    const row = await provideSurveyEvidence(surveyId, plantedCount);
    set({
      revision: get().revision + 1,
      lastMessage: `第 ${row.round} 测次已补证当次株数 ${row.plantedCount ?? '-'} 株并恢复有效`,
    });
    return row;
  },

  async generateReplant(plotId) {
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return '地块不存在，无法生成补植计划';
    const summary = get().summaryOf(plotId);
    const source =
      usePlotStore
        .getState()
        .surveys.filter((row) => row.plotId === plotId && row.validity === 'valid')
        .sort((a, b) => a.round - b.round)
        .at(-1) ?? null;
    const missing = source === null ? 0 : summary.suggestReplant;
    if (source === null) return '该地块没有有效验收测次，请先完成验收复核再生成补植计划';
    if (missing <= 0) return '最新有效测次无缺株，无需生成补植计划';

    // 同一来源验收只允许一条未完成的补植计划，避免重复计入缺株
    const duplicated = usePlotStore
      .getState()
      .replants.some((row) => row.sourceSurveyId === source.id && row.state === '待补植');
    if (duplicated) return '该有效测次已生成过待补植计划，请勿重复生成';

    const species = usePlotStore.getState().seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄';
    const stamp = nowIso();
    const row: Replant = {
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      sourceSurveyId: source.id,
      sourceMissingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species,
      state: '待补植',
      replantedCount: 0,
      completedDate: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.replants.put(row);
    // 地块缺株数与有效补植计划逐株对账回写
    await reconcilePlot(plotId);
    set({ revision: get().revision + 1, lastMessage: `已为「${plot.name}」生成补植计划：缺株 ${missing} 株` });
    return `已生成补植计划：缺株 ${missing} 株`;
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries).filter((item) => item.latestValid !== null);
    if (list.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = list.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: list.length,
      warnCount: list.filter((item) => item.warn).length,
      avgRate: Math.round((sum / list.length) * 10) / 10,
    };
  },
}));
