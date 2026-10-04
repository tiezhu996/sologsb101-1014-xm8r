/**
 * 验收有效性与「地块缺株数 ↔ 有效补植计划」逐株对账（纯函数）
 * - 有效补植计划：待补植 且（手工计划无来源，或来源验收仍有效）；已补植 / 已复核计划始终保留用于留痕对账。
 * - 地块缺株数 = 该地块全部有效待补植计划缺株数之和。
 * 不触碰 IndexedDB，便于测试与在 store / hook / 导出中复用同一口径。
 */
import type { Replant } from '../types/replant';
import { isReplantCompleted } from '../types/replant';
import type { Survey } from '../types/survey';
import { calcSurvivalRate } from './rate';

/** 验收是否仍可作为统计依据（有效） */
export function isSurveyActive(survey: Survey): boolean {
  return survey.validity === 'valid';
}

/**
 * 验收当时缺株 = 当次固定株数快照 - 成活株数；
 * 待补证（无株数快照）返回 null。
 */
export function surveyMissingAt(survey: Survey): number | null {
  if (survey.plantedCount === null || survey.plantedCount === undefined) return null;
  return Math.max(0, survey.plantedCount - survey.aliveCount);
}

/** 按固定株数快照计算的成活率；待补证返回 null */
export function surveyFixedRate(survey: Survey): number | null {
  if (survey.plantedCount === null || survey.plantedCount === undefined) {
    return survey.validity === 'pending_evidence' ? null : survey.survivalRate;
  }
  if (survey.plantedCount <= 0) return survey.validity === 'pending_evidence' ? null : survey.survivalRate;
  return calcSurvivalRate(survey.aliveCount, survey.plantedCount);
}

/** 取地块最新一测次（不论有效性，按测次排序） */
export function latestSurveyOf(plotId: string, surveys: Survey[]): Survey | null {
  const list = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round || a.date.localeCompare(b.date));
  return list.length > 0 ? list[list.length - 1] : null;
}

/** 取地块最新一条有效验收 */
export function latestValidSurveyOf(plotId: string, surveys: Survey[]): Survey | null {
  const list = surveys
    .filter((row) => row.plotId === plotId && isSurveyActive(row))
    .sort((a, b) => a.round - b.round || a.date.localeCompare(b.date));
  return list.length > 0 ? list[list.length - 1] : null;
}

/**
 * 一条待补植计划是否仍在有效范围：
 * - 已完成计划（已补植 / 已复核）不再计入缺株，但保留留痕，返回 false；
 * - 无来源验收的手工计划，只要尚未完成就始终有效；
 * - 有来源验收时，来源验收必须仍有效（未失效、未删除）。
 */
export function isOpenReplanEffective(replant: Replant, surveysById: Map<string, Survey>): boolean {
  if (isReplantCompleted(replant.state)) return false;
  if (replant.sourceSurveyId === '') return true;
  const source = surveysById.get(replant.sourceSurveyId);
  return source !== undefined && isSurveyActive(source);
}

export interface ReplanLedgerItem {
  replan: Replant;
  /** 是否仍计入地块缺株数 */
  effective: boolean;
  /** 退出有效范围的原因（来源失效 / 来源删除 / 已完成保留） */
  note: string;
}

/** 某地块补植计划逐条对账结果 */
export function buildReplanLedger(plotId: string, replants: Replant[], surveys: Survey[]): ReplanLedgerItem[] {
  const surveysById = new Map(surveys.map((row) => [row.id, row]));
  return replants
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.planDate.localeCompare(b.planDate))
    .map((replan) => {
      if (isReplantCompleted(replan.state)) {
        return { replan, effective: false, note: '已完成，保留留痕并按实际补植株数对账' };
      }
      if (replan.sourceSurveyId === '') {
        return { replan, effective: true, note: '手工计划，无来源测次' };
      }
      const source = surveysById.get(replan.sourceSurveyId);
      if (source === undefined) {
        return { replan, effective: false, note: '来源测次已删除，退出有效范围' };
      }
      if (!isSurveyActive(source)) {
        return { replan, effective: false, note: `来源测次已${source.validity === 'pending_evidence' ? '待补证' : '失效'}，退出有效范围` };
      }
      return { replan, effective: true, note: '来源测次有效' };
    });
}

/**
 * 逐株对账：地块缺株数应为多少。
 * 有效待补植计划缺株数逐株相加；已完成计划提供已补植株数合计用于留痕核对。
 */
export function expectedMissingOf(plotId: string, replants: Replant[], surveys: Survey[]): number {
  const surveysById = new Map(surveys.map((row) => [row.id, row]));
  return replants
    .filter((row) => row.plotId === plotId && isOpenReplanEffective(row, surveysById))
    .reduce((acc, row) => acc + row.missingCount, 0);
}

/** 已完成补植（已实际补下）的株数合计，用于留痕对账 */
export function completedReplantCountOf(plotId: string, replants: Replant[]): number {
  return replants
    .filter((row) => row.plotId === plotId && isReplantCompleted(row.state))
    .reduce((acc, row) => acc + Math.max(row.replantedCount ?? 0, row.missingCount), 0);
}

export interface MissingReconcileResult {
  plotId: string;
  /** 对账后的应有缺株数 */
  expected: number;
  /** 当前记录的缺株数 */
  actual: number;
  /** 差额（actual - expected），0 表示账实相符 */
  drift: number;
  /** 有效待补植计划条数 */
  openEffectiveCount: number;
  /** 已完成保留的计划条数 */
  completedCount: number;
  /** 逐条对账明细 */
  ledger: ReplanLedgerItem[];
}

/** 对单个地块做逐株对账（actual 取自当前地块记录） */
export function reconcileMissing(
  plot: { id: string; missingCount: number },
  replants: Replant[],
  surveys: Survey[],
): MissingReconcileResult {
  const ledger = buildReplanLedger(plot.id, replants, surveys);
  const expected = ledger
    .filter((item) => item.effective)
    .reduce((acc, item) => acc + item.replan.missingCount, 0);
  return {
    plotId: plot.id,
    expected,
    actual: plot.missingCount,
    drift: plot.missingCount - expected,
    openEffectiveCount: ledger.filter((item) => item.effective).length,
    completedCount: ledger.filter((item) => isReplantCompleted(item.replan.state)).length,
    ledger,
  };
}
