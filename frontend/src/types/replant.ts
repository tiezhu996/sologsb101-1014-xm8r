/**
 * 补植计划（Replant）
 * 验收成活率偏低时生成的补植任务，记录来源验收与当时缺株；
 * 来源测次失效时，未完成（待补植）计划退出有效范围，已完成（已补植 / 已复核）计划保留并参与对账。
 */
import type { SeedlingSpecies } from './seedling';

/** 补植状态：待补植 / 已补植 / 已复核 */
export type ReplantState = '待补植' | '已补植' | '已复核';

export const REPLANT_STATE_OPTIONS: ReplantState[] = ['待补植', '已补植', '已复核'];

/** 补植状态流转顺序，用于「推进状态」动作 */
export const REPLANT_STATE_FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

/** 已完成的状态：计划已实际执行，来源失效也保留并参与对账 */
export function isReplantCompleted(state: ReplantState): boolean {
  return state === '已补植' || state === '已复核';
}

export interface Replant {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 缺株数（株）——计划创建时从来源验收的当时缺株复制 */
  missingCount: number;
  /** 来源验收 id：据此判断计划是否仍在有效范围；手工新建可为空串 */
  sourceSurveyId: string;
  /** 来源验收当时记录的缺株（株），用于来源失效后的留痕对账；手工新建可为 0 */
  sourceMissingCount: number;
  /** 计划补植日期 YYYY-MM-DD */
  planDate: string;
  /** 补植树种 */
  species: SeedlingSpecies;
  /** 补植状态 */
  state: ReplantState;
  /** 实际补植株数（状态推进到「已补植」时按缺株数落账，可在复核时修正） */
  replantedCount: number;
  /** 补植完成日期 YYYY-MM-DD，未完成为空串 */
  completedDate: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑补植计划的表单草稿 */
export interface ReplantDraft {
  plotId: string;
  missingCount: number;
  planDate: string;
  species: SeedlingSpecies;
  state: ReplantState;
}
