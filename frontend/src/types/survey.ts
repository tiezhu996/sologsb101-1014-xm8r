/**
 * 成活率验收（Survey）
 * 按测次登记成活株数与平均株高；成活率 = 成活株数 ÷ 当次验收固定保存的栽植株数。
 *
 * 口径要点（防止栽植记录补录/修订后历史验收被连带改动）：
 * - 每次验收在保存瞬间固定保存「当次栽植株数」plantedCount，此后该测次成活率不再随栽植台账漂移；
 * - 栽植记录发生增删改后，受影响地块的相关验收进入「待复核」状态，由人工决定保留原测次或按新株数重算；
 * - 旧数据升级时无法证明原株数的验收留在「待补证」状态，补证或重算前不参与缺株对账。
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

/**
 * 验收有效性：
 * - effective 有效：株数快照可证，成活率按快照计算；
 * - stale 待复核：栽植记录变化后快照与现状不一致，等待人工保留或重算；
 * - unproven 待补证：旧数据无法证明原株数，需要人工补证后才恢复有效。
 */
export type SurveyValidity = 'effective' | 'stale' | 'unproven';

export const SURVEY_VALIDITY_LABEL: Record<SurveyValidity, string> = {
  effective: '有效',
  stale: '待复核',
  unproven: '待补证',
};

export const SURVEY_VALIDITY_OPTIONS: SurveyValidity[] = ['effective', 'stale', 'unproven'];

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

export interface Survey {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……） */
  round: number;
  /** 验收日期 YYYY-MM-DD */
  date: string;
  /** 成活株数 */
  aliveCount: number;
  /** 平均株高（厘米） */
  avgHeightCm: number;
  /**
   * 当次验收固定保存的栽植株数（成活率分母，保存即冻结）。
   * 旧数据缺失时为 null，表示等待补证（validity = unproven）。
   */
  plantedCount: number | null;
  /** 成活率（百分比，保留 1 位小数）——按 plantedCount 快照派生，不再随栽植台账变化 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整 */
  grade: RateLevel;
  /** 该等级是否被人工调整过 */
  gradeManual: boolean;
  /** 有效性状态 */
  validity: SurveyValidity;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑验收记录的表单草稿 */
export interface SurveyDraft {
  plotId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
}

/** 复核决定：保留原测次 / 按当前新株数重算 / 人工补证原株数 */
export type SurveyReviewAction = 'keep' | 'recompute' | 'prove';

export interface SurveyReviewDecision {
  action: SurveyReviewAction;
  /** action = prove 时由人工补证的当次栽植株数 */
  provenCount?: number;
}
