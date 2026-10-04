/**
 * 补植计划（Replant）
 * 验收成活率偏低时生成的补植任务，完成后回写地块缺株数。
 *
 * 追溯要点：
 * - 每条计划记录「来源验收」与「当时缺株」，事后可对账；
 * - 来源测次失效（待复核 / 待补证）时，未完成（待补植）的计划退出有效范围，不再占用地块缺株数；
 * - 已完成（已补植 / 已复核）的计划保留并参与对账，不随来源测次状态变动。
 */
import type { SeedlingSpecies } from './seedling';

/** 补植状态：待补植 / 已补植 / 已复核 */
export type ReplantState = '待补植' | '已补植' | '已复核';

export const REPLANT_STATE_OPTIONS: ReplantState[] = ['待补植', '已补植', '已复核'];

/** 补植状态流转顺序，用于「推进状态」动作 */
export const REPLANT_STATE_FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

export interface Replant {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 缺株数（株）——生成当时固定的计划补植株数 */
  missingCount: number;
  /** 计划补植日期 YYYY-MM-DD */
  planDate: string;
  /** 补植树种 */
  species: SeedlingSpecies;
  /** 补植状态 */
  state: ReplantState;
  /** 来源验收记录 id（生成计划的那一测次），可空用于历史手工计划 */
  sourceSurveyId: string;
  /** 生成当时记录的来源测次缺株数（株），用于事后对账 */
  sourceMissingCount: number;
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
