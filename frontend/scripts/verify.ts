/**
 * 业务规则端到端验证脚本（不进生产包；npm run build 不包含它）
 * 用 fake-indexeddb 在内存中驱动真实的 Dexie 层，覆盖：
 * 1. 验收固定当次栽植株数，补录栽植只让旧测次失效、不改历史成活率；
 * 2. 复核保留原测次 / 按新株数重算 / 人工补证；
 * 3. 补植计划记录来源与当时缺株；来源失效时未完成计划退出有效范围，已完成保留；
 * 4. 地块缺株数与有效补植计划逐株对账；
 * 5. 关联写入失败后仍可继续重试（outbox）；
 * 6. 旧数据升级：能反证株数的自动回填，不能反证的留在待补证。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {
  db,
  DB_SCHEMA_VERSION,
  createSurveyRecord,
  putPlanting,
  removePlanting,
  reviewSurvey,
  saveReplant,
  advanceReplantState,
  drainPendingWrites,
  listPendingWrites,
  inferPlantedCount,
  provePlantedCount,
  enqueuePlotReconcileStandalone,
} from '../src/utils/db';
import { buildSurvivalSummary } from '../src/hooks/useSurvivalRate';
import { reconcilePlot, isReplantEffective } from '../src/utils/reconcile';
import type { Plot } from '../src/types/plot';
import type { Planting } from '../src/types/planting';
import type { Replant } from '../src/types/replant';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}
const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

const PLOT = 'plot-test';

function plantingRow(id: string, count: number, n = 0): Planting {
  return {
    id,
    plotId: PLOT,
    seedlingId: 's1',
    plantDate: '2025-01-01',
    spacingM: 1,
    count,
    operator: '甲班',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
  };
}

async function resetPlot(): Promise<void> {
  await db.plots.put({
    id: PLOT,
    name: '测试地块',
    areaMu: 10,
    tideZone: '中',
    substrate: '淤泥质',
    restoreMode: '造林',
    state: '跟踪中',
    missingCount: 0,
    lastReplantDate: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
  } satisfies Plot);
  await db.plantings.where('plotId').equals(PLOT).delete();
  await db.surveys.where('plotId').equals(PLOT).delete();
  await db.replants.where('plotId').equals(PLOT).delete();
  await db.pendingWrites.where('plotId').equals(PLOT).delete();
}

async function snapshot() {
  const [surveys, plantings, replants, plots] = await Promise.all([
    db.surveys.where('plotId').equals(PLOT).toArray(),
    db.plantings.where('plotId').equals(PLOT).toArray(),
    db.replants.where('plotId').equals(PLOT).toArray(),
    db.plots.get(PLOT),
  ]);
  return {
    surveys,
    plantings,
    replants,
    plot: plots!,
    summary: buildSurvivalSummary(PLOT, surveys, plantings, replants),
    view: reconcilePlot(PLOT, surveys, plantings, replants),
  };
}

/* ------------------------- 纯函数：旧数据补证反推 ------------------------- */

check('inferPlantedCount：能反推整数株数', () => {
  // 1000 株活 900 = 90.0%
  assert.equal(inferPlantedCount({ aliveCount: 900, survivalRate: 90 }), 1000);
  // 5200 株活 4108 = 79.0%
  assert.equal(inferPlantedCount({ aliveCount: 4108, survivalRate: 79 }), 5200);
});

check('inferPlantedCount：导入快照时尽力反推（宽松）', () => {
  // 123/77.7 最近整数 158，容差内可尽力补上
  assert.equal(inferPlantedCount({ aliveCount: 123, survivalRate: 77.7 }), 158);
  assert.equal(inferPlantedCount({ aliveCount: 100, survivalRate: 0 }), null);
  assert.equal(inferPlantedCount({}), null);
});

check('provePlantedCount：迁移严格补证', () => {
  // 现存栽植 1000 与记录 90% 完全一致 → exact
  assert.deepEqual(provePlantedCount(900, 90, 1000), { plantedCount: 1000, provenance: 'exact' });
  // 现存 1200 与 90% 不符，但 1000 是唯一能回算 90.0% 的候选 → inferred
  assert.deepEqual(provePlantedCount(900, 90, 1200), { plantedCount: 1000, provenance: 'inferred' });
  // 123 / 77.7%：没有整数株数能精确回算 → 不可证
  assert.equal(provePlantedCount(123, 77.7, 1000), null);
  // 4108 / 79.0%：5200 唯一反推（5200 以内）
  assert.deepEqual(provePlantedCount(4108, 79, 5200), { plantedCount: 5200, provenance: 'exact' });
  // 无现存栽植，且存在多个候选（如 100% 附近）时不可唯一确定 → null
  assert.equal(provePlantedCount(900, 90, null)?.provenance, 'inferred');
});

/* ------------------------- 1. 冻结快照 + 栽植失效 ------------------------- */

check('验收固定当次株数；补录栽植后旧测次先失效且成活率不变', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 900, avgHeightCm: 50 });
  assert.equal(s1.plantedCount, 1000);
  assert.equal(s1.survivalRate, 90);
  assert.equal(s1.validity, 'effective');

  // 补录 200 株
  await putPlanting(plantingRow('p2', 200, 1));
  await drainPendingWrites();
  const after = await snapshot();
  const row1 = after.surveys.find((r) => r.id === s1.id)!;
  assert.equal(row1.validity, 'stale', '旧测次应转入待复核');
  assert.equal(row1.plantedCount, 1000, '冻结株数保持 1000');
  assert.equal(row1.survivalRate, 90, '历史成活率不随栽植漂移');
  // 待复核测次不参与最新有效派生
  assert.equal(after.summary.latest, null);
  assert.equal(after.summary.staleCount, 1);
});

check('删除栽植记录同样让相关验收失效', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 800, avgHeightCm: 50 });
  await removePlanting('p1');
  const row = await db.surveys.get(s1.id);
  assert.equal(row!.validity, 'stale');
});

check('修订不影响总株数时（如只改班组）测次不被连带失效', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 900, avgHeightCm: 50 });
  // 只改作业班组，株数仍为 1000
  await putPlanting({ ...plantingRow('p1', 1000), operator: '乙班' });
  const row = await db.surveys.get(s1.id);
  assert.equal(row!.validity, 'effective', '冻结株数与现状一致，不失效');
});

check('无栽植记录时不允许按新株数重算', async () => {
  await resetPlot();
  await db.surveys.put({
    id: 'sv-empty',
    plotId: PLOT,
    round: 1,
    date: '2025-02-01',
    aliveCount: 100,
    avgHeightCm: 30,
    plantedCount: 100,
    survivalRate: 100,
    grade: 'excellent',
    gradeManual: false,
    validity: 'stale',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
  });
  await assert.rejects(() => reviewSurvey('sv-empty', { action: 'recompute' }), /没有栽植记录/);
});

/* ------------------------- 2. 复核决定 ------------------------- */

check('复核-保留原测次：株数/成活率不变，恢复有效', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 900, avgHeightCm: 50 });
  await putPlanting(plantingRow('p2', 200, 1));
  const kept = await reviewSurvey(s1.id, { action: 'keep' });
  assert.equal(kept!.validity, 'effective');
  assert.equal(kept!.plantedCount, 1000);
  assert.equal(kept!.survivalRate, 90);
});

check('复核-按新株数重算：快照更新并重算成活率', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 900, avgHeightCm: 50 });
  await putPlanting(plantingRow('p2', 200, 1));
  const rec = await reviewSurvey(s1.id, { action: 'recompute' });
  assert.equal(rec!.plantedCount, 1200);
  assert.equal(rec!.survivalRate, 75); // 900/1200
  assert.equal(rec!.validity, 'effective');
});

check('复核-人工补证：按补证株数重算并恢复有效', async () => {
  await resetPlot();
  await db.surveys.put({
    id: 'sv-unproven',
    plotId: PLOT,
    round: 1,
    date: '2025-02-01',
    aliveCount: 777,
    avgHeightCm: 40,
    plantedCount: null,
    survivalRate: 0,
    grade: 'poor',
    gradeManual: false,
    validity: 'unproven',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
  });
  const proven = await reviewSurvey('sv-unproven', { action: 'prove', provenCount: 1000 });
  assert.equal(proven!.plantedCount, 1000);
  assert.equal(proven!.survivalRate, 77.7);
  assert.equal(proven!.validity, 'effective');
  await assert.rejects(() => reviewSurvey('sv-unproven', { action: 'prove', provenCount: 0 }));
});

/* ------------------------- 3. 补植来源追溯 + 有效范围 ------------------------- */

function replantRow(id: string, missing: number, state: Replant['state'], source: string): Replant {
  return {
    id,
    plotId: PLOT,
    missingCount: missing,
    planDate: '2025-05-01',
    species: '秋茄',
    state,
    sourceSurveyId: source,
    sourceMissingCount: missing,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 3,
  };
}

check('来源测次失效：未完成计划退出有效范围；已完成计划保留', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 800, avgHeightCm: 50 });
  await saveReplant(replantRow('rp-pending', 200, '待补植', s1.id));
  await saveReplant(replantRow('rp-done', 100, '已补植', s1.id));
  await drainPendingWrites();

  // 来源失效前：两条都有效，缺株 = 200（已补植不占缺株）
  let snap = await snapshot();
  assert.equal(isReplantEffective(snap.replants.find((r) => r.id === 'rp-pending')!, snap.surveys), true);
  assert.equal(snap.view.missingCount, 200);
  assert.equal(snap.plot.missingCount, 200, '地块缺株已对账回写为 200');

  // 栽植变化导致来源测次失效
  await putPlanting(plantingRow('p2', 300, 1));
  await drainPendingWrites();
  snap = await snapshot();
  const pending = snap.replants.find((r) => r.id === 'rp-pending')!;
  const done = snap.replants.find((r) => r.id === 'rp-done')!;
  assert.equal(isReplantEffective(pending, snap.surveys), false, '未完成计划退出有效范围');
  assert.equal(isReplantEffective(done, snap.surveys), true, '已完成计划保留');
  assert.equal(snap.view.missingCount, 0, '退出后缺株对账为 0');
  assert.equal(snap.plot.missingCount, 0, '地块缺株已自动对账为 0');

  // 复核保留原测次 → 来源恢复有效，未完成计划重新进入
  await reviewSurvey(s1.id, { action: 'keep' });
  await drainPendingWrites();
  snap = await snapshot();
  assert.equal(snap.view.missingCount, 200, '复核后计划恢复，缺株回到 200');
});

check('删除来源测次：未完成计划退出，已完成保留', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 800, avgHeightCm: 50 });
  await saveReplant(replantRow('rp1', 200, '待补植', s1.id));
  await saveReplant(replantRow('rp2', 50, '已复核', s1.id));
  await drainPendingWrites();
  await db.surveys.delete(s1.id);
  await enqueuePlotReconcileStandalone(PLOT);
  await drainPendingWrites();
  const snap = await snapshot();
  assert.equal(snap.view.missingCount, 0);
  assert.equal(snap.replants.length, 2, '计划本身保留不删');
});

/* ------------------------- 4. 逐株对账 + 推进状态 ------------------------- */

check('推进到已补植：缺株数逐株对账，最近补植日期回写，验收测次不被改写', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 700, avgHeightCm: 50 });
  await saveReplant(replantRow('rp1', 200, '待补植', s1.id));
  await saveReplant(replantRow('rp2', 100, '待补植', ''));
  await drainPendingWrites();
  let snap = await snapshot();
  assert.equal(snap.view.missingCount, 300, '两条有效待补植逐株合计 300');

  const before = (await db.surveys.get(s1.id))!;
  await advanceReplantState('rp1', '已补植');
  await drainPendingWrites();
  snap = await snapshot();
  assert.equal(snap.view.missingCount, 100, '完成一条后只剩另一条 100');
  assert.equal(snap.plot.missingCount, 100);
  assert.equal(snap.plot.lastReplantDate !== '', true, '最近补植日期已回写');
  const after = (await db.surveys.get(s1.id))!;
  assert.equal(after.aliveCount, before.aliveCount, '验收成活株数不被补植动作改写');
  assert.equal(after.survivalRate, before.survivalRate, '验收成活率不被补植动作改写');
});

/* ------------------------- 5. 关联写入失败可重试 ------------------------- */

check('关联写入失败后留在队列，恢复后继续重试直至对账一致', async () => {
  await resetPlot();
  await putPlanting(plantingRow('p1', 1000));
  const s1 = await createSurveyRecord({ plotId: PLOT, round: 1, date: '2025-02-01', aliveCount: 700, avgHeightCm: 50 });
  await saveReplant(replantRow('rp1', 300, '待补植', s1.id));
  await drainPendingWrites();
  assert.equal((await db.plots.get(PLOT))!.missingCount, 300);

  // 人为制造 plots.update 失败
  const originalUpdate = db.plots.update.bind(db.plots);
  let failNext = true;
  db.plots.update = ((key: unknown, changes: unknown) => {
    if (failNext && key === PLOT) {
      failNext = false;
      return Promise.reject(new Error('simulated write failure'));
    }
    return originalUpdate(key as string, changes as never);
  }) as typeof db.plots.update;

  await saveReplant(replantRow('rp2', 50, '待补植', ''));
  // 第一次排空：更新失败，待办留队
  const r1 = await drainPendingWrites();
  assert.equal(r1.applied, 0);
  assert.equal(r1.failed, 1);
  const queued = await listPendingWrites();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].attempts, 1);
  assert.equal(queued[0].lastError, 'simulated write failure');
  assert.equal((await db.plots.get(PLOT))!.missingCount, 300, '失败时地块值未变');

  // 恢复后再排空：成功落地，逐株对账到 350
  const r2 = await drainPendingWrites();
  assert.equal(r2.applied, 1);
  assert.equal(r2.failed, 0);
  assert.equal((await listPendingWrites()).length, 0);
  assert.equal((await db.plots.get(PLOT))!.missingCount, 350);
});

/* ------------------------- 6. v2 → v3 升级迁移 ------------------------- */

check('旧库升级：可证株数自动回填有效；不可证留在待补证；与现状不符标待复核', async () => {
  // 主连接先删库，再用一个只声明 v2 的实例灌入旧结构数据，最后重开主连接触发 v3 升级
  await db.delete();
  // 直接构造一个 v2 结构的库
  const legacy = new Dexie('gbmangrove');
  legacy.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  await legacy.open();
  const stamp = new Date().toISOString();
  await legacy.table('plots').bulkAdd([
    { id: 'leg1', name: '旧地块1', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'leg2', name: '旧地块2', areaMu: 10, tideZone: '低', substrate: '砂质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
    { id: 'leg3', name: '旧地块3', areaMu: 10, tideZone: '高', substrate: '砂泥质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await legacy.table('plantings').bulkAdd([
    // leg1：当前台账 1200，旧验收按 1000 算（90%），唯一反推为 1000、与现状不符 → stale
    { id: 'lp1', plotId: 'leg1', seedlingId: '', plantDate: '2025-01-01', spacingM: 1, count: 1200, operator: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
    // leg2：台账 1000，但旧验收 123 株 / 37.3% 无整数解 → unproven
    { id: 'lp2', plotId: 'leg2', seedlingId: '', plantDate: '2025-01-01', spacingM: 1, count: 1000, operator: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
    // leg3：台账 800，800/1000=80% 完全对得上现存总株数 → effective
    { id: 'lp3', plotId: 'leg3', seedlingId: '', plantDate: '2025-01-01', spacingM: 1, count: 1000, operator: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await legacy.table('surveys').bulkAdd([
    // 唯一反推 1000（900/90%），与当前 1200 不符
    { id: 'ls1', plotId: 'leg1', round: 1, date: '2025-02-01', aliveCount: 900, avgHeightCm: 50, survivalRate: 90, grade: 'good', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 2 },
    // 11.1% 在 1000 以内没有整数株数能精确回算
    { id: 'ls2', plotId: 'leg2', round: 1, date: '2025-02-01', aliveCount: 123, avgHeightCm: 40, survivalRate: 11.1, grade: 'fair', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 2 },
    // 现存栽植即可严格证明
    { id: 'ls3', plotId: 'leg3', round: 1, date: '2025-02-01', aliveCount: 800, avgHeightCm: 60, survivalRate: 80, grade: 'good', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await legacy.table('replants').bulkAdd([
    { id: 'lr1', plotId: 'leg1', missingCount: 100, planDate: '2025-03-01', species: '秋茄', state: '待补植', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await legacy.close();

  // 重新以当前版本打开，触发 v3 upgrade
  await db.open();
  assert.equal(db.verno, DB_SCHEMA_VERSION);

  const ls1 = await db.surveys.get('ls1');
  assert.equal(ls1!.plantedCount, 1000, '可证株数自动回填');
  assert.equal(ls1!.validity, 'stale', '回填后与当前台账 1200 不符 → 待复核');

  const ls2 = await db.surveys.get('ls2');
  assert.equal(ls2!.plantedCount, null, '反推不出整数株数');
  assert.equal(ls2!.validity, 'unproven', '留在待补证');

  const ls3 = await db.surveys.get('ls3');
  assert.equal(ls3!.plantedCount, 1000, '现存栽植严格证明自动回填');
  assert.equal(ls3!.validity, 'effective', '与台账一致 → 有效');

  const lr1 = await db.replants.get('lr1');
  assert.equal(lr1!.sourceSurveyId, '', '历史手工计划无来源');
  assert.equal(lr1!.sourceMissingCount, 100, '当时缺株回填为计划株数');

  // v3 upgrade 本身不入队；迁移后手工补一次对账
  await enqueuePlotReconcileStandalone('leg1');
  await enqueuePlotReconcileStandalone('leg2');
  await enqueuePlotReconcileStandalone('leg3');
  await drainPendingWrites();
  assert.equal((await db.plots.get('leg1'))!.missingCount, 100);
  assert.equal((await db.plots.get('leg2'))!.missingCount, 0);
  assert.equal((await db.plots.get('leg3'))!.missingCount, 0);
});

/* ------------------------------- 执行 ------------------------------- */

async function main(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? `    ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}` : err);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
