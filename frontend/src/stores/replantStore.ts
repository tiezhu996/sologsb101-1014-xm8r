/**
 * 补植计划状态管理（Zustand）
 * 维护补植计划的行内草稿、复核状态与批量选中项；
 * 计划记录来源验收与当时缺株；状态推进与「缺株数逐株对账」在 db.ts 事务内收口，
 * 关联写入失败由 outbox 保留，可在此手动继续重试。
 */
import { create } from 'zustand';
import type { Replant, ReplantDraft, ReplantState } from '../types/replant';
import {
  advanceReplantState,
  db,
  exportSnapshot,
  importSnapshot,
  initDatabase,
  listOutboxTasks,
  processOutbox,
  putReplant,
  reconcilePlot,
  removeReplant,
  resetDatabase,
  retryOutbox,
  ROW_REVISION,
  type DatabaseSnapshot,
} from '../utils/db';
import type { OutboxTask } from '../types/outbox';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

/** 补植计划筛选条件 */
export interface ReplantFilters {
  plotId: string | 'all';
  state: ReplantState | 'all';
  /** 有效范围：全部 / 有效计入缺株 / 已退出（来源失效或已完成） */
  scope: 'all' | 'effective' | 'exited';
  keyword: string;
}

export interface ReplantStoreState {
  filters: ReplantFilters;
  /** 每行的行内编辑草稿，key = replant id */
  drafts: Record<string, Partial<ReplantDraft>>;
  /** 当前复核选中的状态（用于批量推进） */
  reviewState: ReplantState | 'all';
  selectedIds: string[];
  lastMessage: string;
  revision: number;
  /** 待处理补偿任务（关联写入失败后继续重试） */
  pendingTasks: OutboxTask[];
  init: () => Promise<void>;
  setFilters: (patch: Partial<ReplantFilters>) => void;
  resetFilters: () => void;
  setDraft: (replantId: string, patch: Partial<ReplantDraft>) => void;
  clearDraft: (replantId: string) => void;
  hasDraft: (replantId: string) => boolean;
  saveDraft: (replantId: string) => Promise<void>;
  createReplant: (draft: ReplantDraft) => Promise<Replant>;
  /** 弹窗编辑保存（来源溯源字段保持不变），保存后重新对账 */
  updateReplan: (replantId: string, draft: ReplantDraft) => Promise<void>;
  deleteReplant: (replantId: string) => Promise<void>;
  /** 推进到下一状态；进入「已补植」时回写地块缺株数并逐株对账 */
  advance: (replantId: string) => Promise<ReplantState | null>;
  setState: (replantId: string, state: ReplantState) => Promise<void>;
  batchAdvance: () => Promise<number>;
  setSelectedIds: (ids: string[]) => void;
  setReviewState: (state: ReplantState | 'all') => void;
  /** 刷新补偿任务列表并继续重试，返回成功条数 */
  retryPendingWrites: () => Promise<number>;
  exportAll: () => Promise<DatabaseSnapshot>;
  importAll: (snapshot: DatabaseSnapshot) => Promise<void>;
  resetAll: () => Promise<void>;
}

const EMPTY_FILTERS: ReplantFilters = { plotId: 'all', state: 'all', scope: 'all', keyword: '' };
const FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

export const useReplantStore = create<ReplantStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  drafts: {},
  reviewState: 'all',
  selectedIds: [],
  lastMessage: '',
  revision: 0,
  pendingTasks: [],

  async init() {
    await initDatabase();
    const pendingTasks = await listOutboxTasks();
    set({ revision: get().revision + 1, pendingTasks });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setDraft(replantId, patch) {
    set({ drafts: { ...get().drafts, [replantId]: { ...get().drafts[replantId], ...patch } } });
  },

  clearDraft(replantId) {
    const next = { ...get().drafts };
    delete next[replantId];
    set({ drafts: next });
  },

  hasDraft(replantId) {
    return get().drafts[replantId] !== undefined;
  },

  async saveDraft(replantId) {
    const draft = get().drafts[replantId];
    if (draft === undefined) return;
    const existing = await db.replants.get(replantId);
    if (!existing) return;
    // 行内草稿只允许调整计划字段，来源验收与当时缺株不可改写
    await putReplant({ ...existing, ...draft } as Replant);
    // 缺株数或状态调整后，与新旧地块都要逐株对账
    const plotIds = Array.from(new Set([existing.plotId, draft.plotId ?? existing.plotId].filter(Boolean)));
    for (const plotId of plotIds) {
      await reconcilePlot(plotId);
    }
    get().clearDraft(replantId);
    set({ revision: get().revision + 1, lastMessage: '草稿已保存到补植计划，地块缺株数已重新对账' });
  },

  async createReplant(draft) {
    const stamp = nowIso();
    const row: Replant = {
      id: uuid('replant'),
      plotId: draft.plotId,
      missingCount: draft.missingCount,
      // 手工新建无来源验收，计划始终计入有效范围直到完成
      sourceSurveyId: '',
      sourceMissingCount: 0,
      planDate: draft.planDate,
      species: draft.species,
      state: draft.state,
      replantedCount: draft.state === '待补植' ? 0 : draft.missingCount,
      completedDate: draft.state === '待补植' ? '' : stamp.slice(0, 10),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putReplant(row);
    if (row.state === '待补植') {
      await reconcilePlot(row.plotId);
    }
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateReplan(replantId, draft) {
    const existing = await db.replants.get(replantId);
    if (!existing) return;
    await putReplant({
      ...existing,
      plotId: draft.plotId,
      missingCount: draft.missingCount,
      planDate: draft.planDate,
      species: draft.species,
      state: draft.state,
      replantedCount: draft.state === '待补植' ? 0 : Math.max(existing.replantedCount, draft.missingCount),
      completedDate: draft.state === '待补植' ? '' : existing.completedDate || nowIso().slice(0, 10),
    });
    const plotIds = Array.from(new Set([existing.plotId, draft.plotId]));
    for (const plotId of plotIds) {
      await reconcilePlot(plotId);
    }
    set({ revision: get().revision + 1 });
  },

  async deleteReplant(replantId) {
    await removeReplant(replantId);
    get().clearDraft(replantId);
    set({
      selectedIds: get().selectedIds.filter((id) => id !== replantId),
      revision: get().revision + 1,
    });
  },

  async advance(replantId) {
    const existing = await db.replants.get(replantId);
    if (!existing) return null;
    const index = FLOW.indexOf(existing.state);
    if (index < 0 || index >= FLOW.length - 1) return null;
    const next = FLOW[index + 1];
    await advanceReplantState(replantId, next);
    await usePlotStore.getState().refreshCounts();
    set({
      revision: get().revision + 1,
      lastMessage: next === '已补植' ? '已标记补植完成，地块缺株数已与有效计划逐株对账' : `状态已推进为「${next}」`,
    });
    return next;
  },

  async setState(replantId, state) {
    await advanceReplantState(replantId, state);
    set({ revision: get().revision + 1 });
  },

  async batchAdvance() {
    const ids = get().selectedIds;
    let count = 0;
    for (const id of ids) {
      const next = await get().advance(id);
      if (next !== null) count += 1;
    }
    set({ selectedIds: [], lastMessage: `已批量推进 ${count} 条补植计划` });
    return count;
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setReviewState(state) {
    set({ reviewState: state });
  },

  async retryPendingWrites() {
    const succeeded = await retryOutbox();
    // 兜底：再处理一次已到期任务，并刷新列表
    const extra = await processOutbox();
    const pendingTasks = await listOutboxTasks();
    await usePlotStore.getState().refreshCounts();
    set({
      pendingTasks,
      revision: get().revision + 1,
      lastMessage:
        succeeded + extra > 0 ? `已继续重试关联写入，成功处理 ${succeeded + extra} 项` : '关联写入补偿队列已清空，地块缺株数完成逐株对账',
    });
    return succeeded + extra;
  },

  async exportAll() {
    return exportSnapshot();
  },

  async importAll(snapshot) {
    await importSnapshot(snapshot);
    const pendingTasks = await listOutboxTasks();
    set({ revision: get().revision + 1, pendingTasks });
  },

  async resetAll() {
    await resetDatabase();
    set({ drafts: {}, selectedIds: [], pendingTasks: [], revision: get().revision + 1 });
  },
}));
