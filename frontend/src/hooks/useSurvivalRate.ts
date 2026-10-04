/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 *
 * 口径（v3）：
 * - 每条验收的成活率分母是该测次固定保存的 plantedCount，不再随栽植台账漂移；
 * - 待复核（stale）/ 待补证（unproven）测次保留历史数值用于展示，但不参与
 *   「最新成活率 / 告警 / 缺株建议」等派生；
 * - 缺株对账视图由 utils/reconcile 的纯函数产出。
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
import { reconcilePlot, type PlotReconcileView } from '../utils/reconcile';

/** 单个测次的成活率数据点 */
export interface SurvivalPoint {
  surveyId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  /** 该测次固定保存的栽植株数；旧数据待补证时为 null */
  plantedCount: number | null;
  /** 该测次的成活率（%，按冻结株数计算；待补证时回退历史数值） */
  rate: number;
  /** 该测次的有效性 */
  validity: SurveyValidity;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 当前栽植台账总株数（仅用于参照，不是历史测次的分母） */
  totalCount: number;
  /** 按测次排序的全部数据点（含待复核 / 待补证） */
  points: SurvivalPoint[];
  /** 仅含有效测次的数据点 */
  effectivePoints: SurvivalPoint[];
  /** 最新有效测次 */
  latest: SurvivalPoint | null;
  /** 上一次有效测次 */
  previous: SurvivalPoint | null;
  /** 最新有效测次成活率（%） */
  latestRate: number;
  /** 与上一有效测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数（最新有效测次冻结株数 - 成活株数） */
  suggestReplant: number;
  /** 最新有效等级 */
  level: RateLevel;
  /** 最新有效测次是否低于告警阈值 */
  warn: boolean;
  /** 待复核测次数（栽植记录变化后等待人工决定） */
  staleCount: number;
  /** 待补证测次数（旧数据无法证明原株数） */
  unprovenCount: number;
  /** 与有效补植计划逐株对账后的缺株视图 */
  reconcile: PlotReconcileView;
}

function toPoint(row: Survey): SurvivalPoint {
  const rate =
    row.plantedCount !== null ? calcSurvivalRate(row.aliveCount, row.plantedCount) : row.survivalRate;
  return {
    surveyId: row.id,
    round: row.round,
    date: row.date,
    aliveCount: row.aliveCount,
    avgHeightCm: row.avgHeightCm,
    plantedCount: row.plantedCount,
    rate,
    validity: row.validity,
    gradeManual: row.gradeManual,
    level: row.gradeManual ? row.grade : rateLevel(rate),
  };
}

/** 纯函数：由验收记录与栽植记录派生地块成活率汇总 */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  replants: Replant[] = [],
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const totalCount = plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);

  const points: SurvivalPoint[] = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round)
    .map(toPoint);

  const effectivePoints = points.filter((point) => point.validity === 'effective');
  const latest = effectivePoints.length > 0 ? effectivePoints[effectivePoints.length - 1] : null;
  const previous = effectivePoints.length > 1 ? effectivePoints[effectivePoints.length - 2] : null;
  const growth = latest && previous ? heightGrowth(previous.avgHeightCm, latest.avgHeightCm) : { delta: 0, pct: 0 };

  const suggestReplant =
    latest !== null && latest.plantedCount !== null
      ? Math.max(0, latest.plantedCount - latest.aliveCount)
      : 0;

  return {
    plotId,
    totalCount,
    points,
    effectivePoints,
    latest,
    previous,
    latestRate: latest ? latest.rate : 0,
    trend: latest && previous ? round1(latest.rate - previous.rate) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant,
    level: latest ? latest.level : 'poor',
    warn: latest !== null && latest.rate < threshold,
    staleCount: points.filter((point) => point.validity === 'stale').length,
    unprovenCount: points.filter((point) => point.validity === 'unproven').length,
    reconcile: reconcilePlot(plotId, surveys, plantings, replants),
  };
}

export interface UseSurvivalRateResult {
  summary: SurvivalSummary;
  loading: boolean;
  error: string;
}

/** 空汇总，用于地块不存在或尚无数据时兜底，避免页面白屏 */
export function emptySummary(plotId: string): SurvivalSummary {
  return buildSurvivalSummary(plotId, [], [], []);
}

/**
 * 订阅某地块的验收、栽植与补植记录，实时派生成活率、株高增幅与补植建议。
 */
export function useSurvivalRate(plotId: string | null, threshold: number = SURVIVAL_WARN_RATE): UseSurvivalRateResult {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const [replants, setReplants] = useState<Replant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows, replantRows] = await Promise.all([
        db.surveys.toArray(),
        db.plantings.toArray(),
        db.replants.toArray(),
      ]);
      return { surveyRows, plantingRows, replantRows };
    }).subscribe({
      next: ({ surveyRows, plantingRows, replantRows }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setReplants(replantRows);
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
    () =>
      plotId === null
        ? emptySummary('')
        : buildSurvivalSummary(plotId, surveys, plantings, replants, threshold),
    [plotId, surveys, plantings, replants, threshold],
  );

  return { summary, loading, error };
}
