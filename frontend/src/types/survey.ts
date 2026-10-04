/**
 * 成活率验收（Survey）
 * 按测次登记成活株数与平均株高。
 * 成活率口径固定为「成活株数 ÷ 验收当次保存的栽植株数（plantedCount 快照）」，
 * 事后补录 / 修订栽植记录不会自动改动历史验收，只会把相关验收置为失效，待复核后决定保留或重算。
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

/**
 * 验收有效性：
 * - valid：有效（复核确认保留原测次，或按新株数重算后的结果）
 * - invalid：失效（其依据的栽植记录发生过补录 / 修订，等待复核决定保留或重算）
 * - pending_evidence：待补证（旧数据升级时无法证明当时的栽植株数）
 */
export type SurveyValidity = 'valid' | 'invalid' | 'pending_evidence';

export const SURVEY_VALIDITY_LABEL: Record<SurveyValidity, string> = {
  valid: '有效',
  invalid: '失效待复核',
  pending_evidence: '待补证',
};

/** 复核决策：保留原测次（沿用固定株数快照）或按最新栽植株数重算 */
export type SurveyReviewDecision = 'keep' | 'recalculate';

export const SURVEY_REVIEW_DECISION_LABEL: Record<SurveyReviewDecision, string> = {
  keep: '保留原测次',
  recalculate: '按新株数重算',
};

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
   * 验收当次保存的栽植株数快照（株）。
   * 一旦验收保存即固定，后续栽植记录补录 / 修订不再自动改写，保证历史成活率可追溯；
   * null 表示旧数据升级时无法证明当时株数，需补证后才能重新有效。
   */
  plantedCount: number | null;
  /** 成活率（百分比，保留 1 位小数）——成活株数 / plantedCount 派生 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整 */
  grade: RateLevel;
  /** 该等级是否被人工调整过 */
  gradeManual: boolean;
  /** 验收有效性（有效 / 失效待复核 / 待补证） */
  validity: SurveyValidity;
  /** 最近一次失效原因（栽植记录补录、修订、删除等），复核后清空 */
  invalidReason: string;
  /** 失效时间 ISO，未失效为空串 */
  invalidatedAt: string;
  /** 最近一次复核时间 ISO，未复核为空串 */
  reviewedAt: string;
  /** 最近一次复核采用的决策 */
  reviewDecision: SurveyReviewDecision | null;
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
