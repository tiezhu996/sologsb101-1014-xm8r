/**
 * 验收状态管理（Zustand）
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * 成活率派生值统一由 hooks/useSurvivalRate 的纯函数产出，避免口径分散。
 *
 * v3 规则：
 * - 录入测次时固定保存当次栽植株数，成活率当场冻结；
 * - 栽植记录变化后相关验收先失效（待复核），由 reviewSurvey 决定保留原测次 / 重算 / 补证；
 * - 旧数据中无法证明原株数的测次为待补证，不参与告警与补植建议。
 */
import { create } from 'zustand';
import type { RateLevel, Survey, SurveyDraft, SurveyReviewAction, SurveyValidity } from '../types/survey';
import {
  createSurveyRecord,
  drainPendingWrites,
  initDatabase,
  patchSurveyGrades,
  removeSurvey,
  reviewSurvey,
  saveReplant,
  updateSurveyFrozen,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { ROW_REVISION } from '../utils/db';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 有效性 + 等级 + 关键字 + 日期区间） */
export interface SurveyFilters {
  plotId: string | 'all';
  validity: SurveyValidity | 'all';
  level: RateLevel | 'all';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = {
  plotId: 'all',
  validity: 'all',
  level: 'all',
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
  /** 复核待失效测次：保留原测次 / 按新株数重算 / 人工补证 */
  review: (surveyId: string, action: SurveyReviewAction, provenCount?: number) => Promise<Survey | null>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（人工复核） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /** 按最新有效测次生成补植计划（记录来源测次与当时缺株，回写地块缺株数） */
  generateReplant: (plotId: string) => Promise<string>;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
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
    const row = await createSurveyRecord(draft);
    // 新测次可能改变最新有效缺株，顺手把关联回写落地（失败仍在队列中，可重试）
    await drainPendingWrites();
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateSurvey(surveyId, draft) {
    await updateSurveyFrozen(surveyId, draft);
    await drainPendingWrites();
    set({ revision: get().revision + 1 });
  },

  async review(surveyId, action, provenCount) {
    const next = await reviewSurvey(surveyId, { action, provenCount });
    await drainPendingWrites();
    set({
      revision: get().revision + 1,
      lastMessage:
        action === 'keep'
          ? '已保留原测次的栽植株数快照，测次恢复有效'
          : action === 'recompute'
            ? '已按当前栽植总株数重算，测次恢复有效'
            : '已按补证株数重算，测次恢复有效',
    });
    return next;
  },

  async deleteSurvey(surveyId) {
    await removeSurvey(surveyId);
    await drainPendingWrites();
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async bulkApplyGrade(level) {
    const ids = get().selectedIds;
    if (ids.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值，保证数据可追溯
    await patchSurveyGrades(ids, level);
    set({ revision: get().revision + 1, lastMessage: `已批量调整 ${ids.length} 条验收记录的成活率等级` });
    return ids.length;
  },

  async generateReplant(plotId) {
    const summary = get().summaryOf(plotId);
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return '地块不存在，无法生成补植计划';
    const latest = summary.latest;
    if (latest === null || latest.plantedCount === null) {
      return '该地块没有有效测次可作为补植依据，请先完成验收复核或补证';
    }
    const missing = summary.suggestReplant;
    if (missing <= 0) return '该地块最新有效测次无缺株，无需生成补植计划';
    const species = usePlotStore.getState().seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄';
    const stamp = nowIso();
    await saveReplant({
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species,
      state: '待补植',
      // 记录来源验收与当时缺株：来源测次日后失效，本计划（未完成）即退出有效范围
      sourceSurveyId: latest.surveyId,
      sourceMissingCount: missing,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await drainPendingWrites();
    set({ revision: get().revision + 1, lastMessage: `已为「${plot.name}」生成补植计划：缺株 ${missing} 株（来源第 ${latest.round} 测次）` });
    return `已生成补植计划：缺株 ${missing} 株`;
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries);
    const withSurvey = list.filter((item) => item.latest !== null);
    if (withSurvey.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = withSurvey.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: withSurvey.length,
      warnCount: withSurvey.filter((item) => item.warn).length,
      avgRate: Math.round((sum / withSurvey.length) * 10) / 10,
    };
  },
}));
