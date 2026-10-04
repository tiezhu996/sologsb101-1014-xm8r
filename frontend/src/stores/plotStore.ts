/**
 * 地块状态管理（Zustand）
 * 维护地块列表、当前选中地块、筛选条件与地块级派生统计；
 * 所有写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 *
 * v3 起订阅补植计划与关联写入待办队列：
 * - 成活率汇总按验收冻结株数 + 有效性派生；
 * - 地块缺株数与有效补植计划逐株对账，页面可看到差异并重试失败的关联写入。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Plot, PlotDraft, Substrate, TideZone } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { PendingWrite } from '../types/outbox';
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  drainPendingWrites,
  initDatabase,
  listPendingWrites,
  putPlot,
  removePlot,
} from '../utils/db';
import { buildSurvivalSummary, type SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, uuid } from '../utils/id';

/** 地块筛选条件（关键字 + 潮位带 + 底质），由 <FilterBar> 同步到 URL query */
export interface PlotFilters {
  keyword: string;
  tideZone: TideZone | 'all';
  substrate: Substrate | 'all';
}

/** 单个地块的派生统计，供地块台账与补植计划页复用 */
export interface PlotStat {
  plotId: string;
  /** 苗木批次数 */
  seedlingCount: number;
  /** 进场苗木合计（株） */
  seedlingQuantity: number;
  /** 栽植总株数（株，当前栽植台账口径） */
  plantTotal: number;
  /** 验收测次数（含待复核 / 待补证） */
  surveyCount: number;
  /** 有效测次数 */
  effectiveSurveyCount: number;
  /** 最新有效成活率（%） */
  latestRate: number;
  /** 最新等级 */
  level: SurvivalSummary['level'];
  /** 成活率环比变化（百分点） */
  trend: number;
  /** 建议补植株数（最新有效测次口径） */
  suggestReplant: number;
  /** 待复核测次数 */
  staleCount: number;
  /** 待补证测次数 */
  unprovenCount: number;
  /** 与有效补植计划逐株对账的目标缺株数 */
  expectedMissing: number;
  /** 地块记录缺株数与对账值是否一致 */
  missingConsistent: boolean;
}

const EMPTY_FILTERS: PlotFilters = { keyword: '', tideZone: 'all', substrate: 'all' };
const CURRENT_PLOT_KEY = 'gbmangrove:currentPlotId';

function readCurrentPlotId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PLOT_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function writeCurrentPlotId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PLOT_KEY, id ?? '');
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

interface PlotStoreState {
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  pendingWrites: PendingWrite[];
  currentPlotId: string | null;
  loading: boolean;
  ready: boolean;
  error: string;
  filters: PlotFilters;
  counts: Record<string, number>;
  stats: Record<string, PlotStat>;
  summaries: Record<string, SurvivalSummary>;
  /** 订阅 Dexie 并载入全部派生数据（幂等，可重复调用） */
  loadAll: () => Promise<void>;
  selectPlot: (plotId: string | null) => void;
  createPlot: (draft: PlotDraft) => Promise<Plot>;
  updatePlot: (plotId: string, draft: PlotDraft) => Promise<void>;
  deletePlot: (plotId: string) => Promise<void>;
  setFilters: (patch: Partial<PlotFilters>) => void;
  resetFilters: () => void;
  visiblePlots: () => Plot[];
  statOf: (plotId: string) => PlotStat;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  refreshCounts: () => Promise<void>;
  /** 手动重试尚未落地的关联写入 */
  retryPendingWrites: () => Promise<{ applied: number; failed: number }>;
}

const EMPTY_STAT: Omit<PlotStat, 'plotId'> = {
  seedlingCount: 0,
  seedlingQuantity: 0,
  plantTotal: 0,
  surveyCount: 0,
  effectiveSurveyCount: 0,
  latestRate: 0,
  level: 'poor',
  trend: 0,
  suggestReplant: 0,
  staleCount: 0,
  unprovenCount: 0,
  expectedMissing: 0,
  missingConsistent: true,
};

let subscribed = false;
let retryListenersBound = false;

/** 在网络恢复 / 页面重新可见时继续排空关联写入队列 */
function bindRetryListeners(retry: () => void): void {
  if (retryListenersBound) return;
  retryListenersBound = true;
  window.addEventListener('online', () => void retry());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void retry();
  });
}

export const usePlotStore = create<PlotStoreState>((set, get) => ({
  plots: [],
  seedlings: [],
  plantings: [],
  surveys: [],
  replants: [],
  pendingWrites: [],
  currentPlotId: readCurrentPlotId(),
  loading: true,
  ready: false,
  error: '',
  filters: { ...EMPTY_FILTERS },
  counts: {},
  stats: {},
  summaries: {},

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [plots, seedlings, plantings, surveys, replants, pendingWrites] = await Promise.all([
            db.plots.toArray(),
            db.seedlings.toArray(),
            db.plantings.toArray(),
            db.surveys.toArray(),
            db.replants.toArray(),
            listPendingWrites(),
          ]);
          return { plots, seedlings, plantings, surveys, replants, pendingWrites };
        }).subscribe({
          next: ({ plots, seedlings, plantings, surveys, replants, pendingWrites }) => {
            const stats: Record<string, PlotStat> = {};
            const summaries: Record<string, SurvivalSummary> = {};
            plots.forEach((plot) => {
              const plotSeedlings = seedlings.filter((row) => row.plotId === plot.id);
              const summary = buildSurvivalSummary(plot.id, surveys, plantings, replants);
              summaries[plot.id] = summary;
              stats[plot.id] = {
                plotId: plot.id,
                seedlingCount: plotSeedlings.length,
                seedlingQuantity: plotSeedlings.reduce((acc, row) => acc + row.quantity, 0),
                plantTotal: summary.totalCount,
                surveyCount: summary.points.length,
                effectiveSurveyCount: summary.effectivePoints.length,
                latestRate: summary.latestRate,
                level: summary.level,
                trend: summary.trend,
                suggestReplant: summary.suggestReplant,
                staleCount: summary.staleCount,
                unprovenCount: summary.unprovenCount,
                expectedMissing: summary.reconcile.missingCount,
                missingConsistent: plot.missingCount === summary.reconcile.missingCount,
              };
            });
            const sorted = [...plots].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
            const current = get().currentPlotId;
            const stillExists = current !== null && plots.some((plot) => plot.id === current);
            set({
              plots: sorted,
              seedlings,
              plantings,
              surveys,
              replants,
              pendingWrites,
              stats,
              summaries,
              loading: false,
              ready: true,
              error: '',
            });
            if (!stillExists) {
              const nextId = sorted.length > 0 ? sorted[0].id : null;
              set({ currentPlotId: nextId });
              writeCurrentPlotId(nextId);
            }
          },
          error: (err: unknown) => {
            set({ loading: false, error: err instanceof Error ? err.message : '读取地块数据失败' });
          },
        });
      }
      bindRetryListeners(() => void get().retryPendingWrites());
      await get().refreshCounts();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '初始化本地数据库失败' });
    }
  },

  selectPlot(plotId) {
    set({ currentPlotId: plotId });
    writeCurrentPlotId(plotId);
  },

  async createPlot(draft) {
    const stamp = nowIso();
    const row: Plot = {
      id: uuid('plot'),
      name: draft.name.trim() || '未命名地块',
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
      missingCount: 0,
      lastReplantDate: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putPlot(row);
    get().selectPlot(row.id);
    return row;
  },

  async updatePlot(plotId, draft) {
    const existing = await db.plots.get(plotId);
    if (!existing) return;
    await putPlot({
      ...existing,
      name: draft.name.trim() || existing.name,
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
    });
  },

  async deletePlot(plotId) {
    await removePlot(plotId);
    if (get().currentPlotId === plotId) {
      get().selectPlot(null);
    }
    await get().refreshCounts();
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  visiblePlots() {
    const { plots, filters } = get();
    const keyword = filters.keyword.trim().toLowerCase();
    return plots.filter((plot) => {
      if (filters.tideZone !== 'all' && plot.tideZone !== filters.tideZone) return false;
      if (filters.substrate !== 'all' && plot.substrate !== filters.substrate) return false;
      if (keyword === '') return true;
      return (
        plot.name.toLowerCase().includes(keyword) ||
        plot.restoreMode.toLowerCase().includes(keyword) ||
        plot.state.toLowerCase().includes(keyword)
      );
    });
  },

  statOf(plotId) {
    return get().stats[plotId] ?? { plotId, ...EMPTY_STAT };
  },

  summaryOf(plotId) {
    if (plotId === null) return buildSurvivalSummary('', [], [], []);
    return get().summaries[plotId] ?? buildSurvivalSummary(plotId, [], [], []);
  },

  async refreshCounts() {
    const counts = await countAll();
    set({ counts: { ...counts, schemaVersion: DB_SCHEMA_VERSION } });
  },

  async retryPendingWrites() {
    const result = await drainPendingWrites();
    await get().refreshCounts();
    return result;
  },
}));
