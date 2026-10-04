/**
 * 关联写入补偿任务（Outbox）
 * 栽植记录变化 → 验收失效 → 补植计划退出有效范围 → 地块缺株逐株对账，
 * 这条级联链路在同事务写入；若关联写入失败，任务保留在 outbox 中，
 * 下次启动 / 手动触发时继续重试，成功后删除。
 */

/**
 * 任务种类：
 * - planting_changed：某地块栽植记录发生补录 / 修订 / 删除，需失效相关验收并重新对账
 * - reconcile_plot：仅重算某地块缺株数并与有效补植计划逐株对账
 */
export type OutboxTaskType = 'planting_changed' | 'reconcile_plot';

export type OutboxTaskStatus = 'pending' | 'done' | 'failed';

export interface OutboxTask {
  /** 任务 id：同地块同类任务固定 id（`planting-changed:<plotId>`），自动去重 */
  id: string;
  type: OutboxTaskType;
  /** 目标地块；全量对账时为空串 */
  plotId: string;
  status: OutboxTaskStatus;
  /** 载荷（如触发原因） */
  payload: Record<string, unknown>;
  /** 已尝试次数 */
  attempts: number;
  /** 最近一次失败信息 */
  lastError: string;
  /** 下次可重试时间（指数退避） */
  runAfter: string;
  createdAt: string;
  updatedAt: string;
}
