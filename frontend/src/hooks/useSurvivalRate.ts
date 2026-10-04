/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 * 口径：每条验收固定保存当次栽植株数（plantedCount 快照），成活率不随后续栽植变化漂移；
 * 失效 / 待补证测次只展示留痕，不参与「最新有效成活率」与补植建议统计。
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Survey, RateLevel, SurveyValidity } from '../types/survey';
import type { Planting } from '../types/planting';
import type { Replant } from '../types/replant';
import { db, initDatabase } from '../utils/db';
import {
  SURVIVAL_WARN_RATE,
  calcSurvivalRate,
  heightGrowth,
  rateLevel,
  round1,
} from '../utils/rate';
import { isSurveyActive, latestValidSurveyOf, surveyFixedRate, surveyMissingAt } from '../utils/reconcile';

/** 单个测次的成活率数据点 */
export interface SurvivalPoint {
  surveyId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  /** 当次固定保存的栽植株数；null = 待补证 */
  plantedCount: number | null;
  /** 该测次的成活率（%）；待补证时为 null */
  rate: number | null;
  /** 测次有效性：有效 / 失效待复核 / 待补证 */
  validity: SurveyValidity;
  /** 失效 / 待补证原因 */
  invalidReason: string;
  /** 是否计入统计口径（仅有效测次） */
  active: boolean;
  /** 该测次当时缺株；待补证时为 null */
  missing: number | null;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 当前栽植总株数（仅用于「按新株数重算」预览与提示） */
  totalCount: number;
  /** 按测次排序的全部数据点（含失效 / 待补证留痕） */
  points: SurvivalPoint[];
  /** 最新一测次（不论有效性） */
  latest: SurvivalPoint | null;
  /** 最新一条有效测次 */
  latestValid: SurvivalPoint | null;
  /** 有效测次中上一条（用于趋势与株高增幅） */
  previous: SurvivalPoint | null;
  /** 最新有效成活率（%），无有效测次时为 0 */
  latestRate: number;
  /** 与上一有效测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm，取相邻有效测次） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数（最新有效测次的当时缺株） */
  suggestReplant: number;
  /** 最新有效等级，无有效测次时为 poor */
  level: RateLevel;
  /** 是否有有效测次低于告警阈值 */
  warn: boolean;
  /** 有效测次条数 */
  validCount: number;
  /** 失效待复核条数 */
  invalidCount: number;
  /** 待补证条数 */
  pendingEvidenceCount: number;
  /** 是否存在需要复核 / 补证的测次 */
  hasReviewWork: boolean;
}

function toPoint(survey: Survey): SurvivalPoint {
  const rate = surveyFixedRate(survey);
  const active = isSurveyActive(survey);
  const resolvedRate = rate ?? survey.survivalRate;
  return {
    surveyId: survey.id,
    round: survey.round,
    date: survey.date,
    aliveCount: survey.aliveCount,
    avgHeightCm: survey.avgHeightCm,
    plantedCount: survey.plantedCount,
    rate,
    validity: survey.validity,
    invalidReason: survey.invalidReason,
    active,
    missing: surveyMissingAt(survey),
    gradeManual: survey.gradeManual,
    level: survey.gradeManual ? survey.grade : rateLevel(resolvedRate),
  };
}

/** 纯函数：由验收记录与栽植记录派生地块成活率汇总（补植计划用于对账，不改变统计口径） */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  _replants: Replant[] = [],
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const totalCount = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);

  const points: SurvivalPoint[] = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round || a.date.localeCompare(b.date))
    .map(toPoint);

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const activePoints = points.filter((point) => point.active && point.rate !== null);
  const latestValidPoint = activePoints.length > 0 ? activePoints[activePoints.length - 1] : null;
  const previous = activePoints.length > 1 ? activePoints[activePoints.length - 2] : null;
  const growth =
    latestValidPoint && previous
      ? heightGrowth(previous.avgHeightCm, latestValidPoint.avgHeightCm)
      : { delta: 0, pct: 0 };

  const invalidCount = points.filter((point) => point.validity === 'invalid').length;
  const pendingEvidenceCount = points.filter((point) => point.validity === 'pending_evidence').length;
  const warn = latestValidPoint !== null && latestValidPoint.rate !== null && latestValidPoint.rate < threshold;

  return {
    plotId,
    totalCount,
    points,
    latest,
    latestValid: latestValidPoint,
    previous,
    latestRate: latestValidPoint?.rate ?? 0,
    trend: latestValidPoint && previous ? round1((latestValidPoint.rate ?? 0) - (previous.rate ?? 0)) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant: latestValidPoint?.missing ?? 0,
    level: latestValidPoint?.level ?? 'poor',
    warn,
    validCount: activePoints.length,
    invalidCount,
    pendingEvidenceCount,
    hasReviewWork: invalidCount + pendingEvidenceCount > 0,
  };
}

export interface UseSurvivalRateResult {
  summary: SurvivalSummary;
  loading: boolean;
  error: string;
}

/** 空汇总，用于地块不存在或尚无数据时兜底，避免页面白屏 */
export function emptySummary(plotId: string): SurvivalSummary {
  return buildSurvivalSummary(plotId, [], []);
}

/**
 * 订阅某地块的验收与栽植记录，实时派生成活率、株高增幅与补植建议。
 */
export function useSurvivalRate(plotId: string | null, threshold: number = SURVIVAL_WARN_RATE): UseSurvivalRateResult {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows] = await Promise.all([db.surveys.toArray(), db.plantings.toArray()]);
      return { surveyRows, plantingRows };
    }).subscribe({
      next: ({ surveyRows, plantingRows }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setError('');
        setLoading(false);
      },
      error: (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取成活率数据失败');
        setLoading(false);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const summary = useMemo(
    () => (plotId === null ? emptySummary('') : buildSurvivalSummary(plotId, surveys, plantings, [], threshold)),
    [plotId, surveys, plantings, threshold],
  );

  return { summary, loading, error };
}

export { latestValidSurveyOf, calcSurvivalRate };
