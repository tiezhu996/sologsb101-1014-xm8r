/**
 * 缺株对账纯函数（不触碰 IndexedDB，便于单测）
 *
 * 口径：
 * - 有效验收：validity === 'effective'；待复核 / 待补证的测次不参与对账。
 * - 有效补植计划：
 *   · 待补植：必须来源验收仍然有效（手工无来源计划恒有效）；来源失效则退出有效范围；
 *   · 已补植 / 已复核：已实际作业，保留并继续参与对账。
 * - 地块缺株数 = 有效待补植计划缺株合计（逐株累加）。
 */
import type { Plot } from '../types/plot';
import type { Planting } from '../types/planting';
import type { Survey, SurveyValidity } from '../types/survey';
import type { Replant } from '../types/replant';
import { calcSurvivalRate } from './rate';

/** 验收是否参与有效范围 */
export function isSurveyEffective(survey: Survey): boolean {
  return survey.validity === 'effective';
}

/** 补植计划是否落在有效范围内 */
export function isReplantEffective(replant: Replant, surveys: Survey[]): boolean {
  if (replant.state !== '待补植') return true;
  if (replant.sourceSurveyId === '') return true; // 历史手工计划，无来源可判，保留有效
  const source = surveys.find((row) => row.id === replant.sourceSurveyId);
  // 来源测次不存在（已删除）与失效同等处理：未完成计划退出有效范围
  return source !== undefined && isSurveyEffective(source);
}

/** 取地块最新一条有效验收（按测次），无则 null */
export function latestEffectiveSurvey(surveys: Survey[], plotId: string): Survey | null {
  const list = surveys
    .filter((row) => row.plotId === plotId && isSurveyEffective(row))
    .sort((a, b) => a.round - b.round);
  return list.length > 0 ? list[list.length - 1] : null;
}

/** 地块当前栽植总株数（栽植台账实时口径） */
export function currentPlantedCount(plantings: Planting[], plotId: string): number {
  return plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

/** 计划生成当时的缺株 = 来源测次冻结株数 - 当时成活株数（无法证明时为 0） */
export function missingOfSurvey(survey: Survey): number {
  if (survey.plantedCount === null) return 0;
  return Math.max(0, survey.plantedCount - survey.aliveCount);
}

export interface PlotReconcileView {
  plotId: string;
  /** 当前栽植总株数（台账口径，用于参照） */
  plantedTotal: number;
  /** 有效测次数 */
  effectiveSurveyCount: number;
  /** 最新有效测次 */
  latest: Survey | null;
  /** 最新有效测次成活率（%） */
  latestRate: number;
  /** 最新有效测次成活株数 */
  aliveCount: number;
  /** 有效范围内的计划 */
  effectiveReplants: Replant[];
  /** 来源测次失效、已退出有效范围的未完成计划 */
  droppedReplants: Replant[];
  /** 对账目标缺株数：有效待补植计划逐株合计 */
  missingCount: number;
  /** 有效待补植计划缺株合计（= missingCount） */
  pendingMissing: number;
  /** 已补植 / 已复核计划缺株合计（已完成，保留并参与对账展示） */
  completedCount: number;
}

/** 单地块对账视图（纯计算） */
export function reconcilePlot(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  replants: Replant[],
): PlotReconcileView {
  const plotSurveys = surveys.filter((row) => row.plotId === plotId);
  const plotReplants = replants.filter((row) => row.plotId === plotId);
  const effectiveReplants = plotReplants.filter((row) => isReplantEffective(row, plotSurveys));
  const droppedReplants = plotReplants.filter((row) => !isReplantEffective(row, plotSurveys));
  const pending = effectiveReplants.filter((row) => row.state === '待补植');
  const completed = effectiveReplants.filter((row) => row.state !== '待补植');
  const latest = latestEffectiveSurvey(plotSurveys, plotId);
  const pendingMissing = pending.reduce((acc, row) => acc + row.missingCount, 0);

  return {
    plotId,
    plantedTotal: currentPlantedCount(plantings, plotId),
    effectiveSurveyCount: plotSurveys.filter(isSurveyEffective).length,
    latest,
    latestRate:
      latest !== null && latest.plantedCount !== null
        ? calcSurvivalRate(latest.aliveCount, latest.plantedCount)
        : 0,
    aliveCount: latest?.aliveCount ?? 0,
    effectiveReplants,
    droppedReplants,
    missingCount: pendingMissing,
    pendingMissing,
    completedCount: completed.reduce((acc, row) => acc + row.missingCount, 0),
  };
}

export interface ReconcileDiff {
  plotId: string;
  /** 地块当前记录值 */
  stored: number;
  /** 对账目标值 */
  expected: number;
  /** 差值（正：记录偏高，负：记录偏低） */
  diff: number;
  /** 是否一致 */
  consistent: boolean;
}

/** 逐株比对地块缺株数与有效补植计划 */
export function diffPlotMissing(plot: Plot, view: PlotReconcileView): ReconcileDiff {
  return {
    plotId: plot.id,
    stored: plot.missingCount,
    expected: view.missingCount,
    diff: plot.missingCount - view.missingCount,
    consistent: plot.missingCount === view.missingCount,
  };
}

export interface PlotValidityCounts {
  effective: number;
  stale: number;
  unproven: number;
}

/** 各地块验收有效性计数 */
export function surveyValidityCounts(surveys: Survey[], plotId: string): PlotValidityCounts {
  const counts: PlotValidityCounts = { effective: 0, stale: 0, unproven: 0 };
  for (const survey of surveys) {
    if (survey.plotId !== plotId) continue;
    counts[survey.validity as SurveyValidity] += 1;
  }
  return counts;
}
