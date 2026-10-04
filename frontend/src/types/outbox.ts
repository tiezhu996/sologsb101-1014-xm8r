/**
 * 关联写入待办队列（PendingWrite）
 * 业务主记录（栽植 / 验收 / 补植）写入成功后，地块缺株数等「关联回写」先入队，
 * 再异步落到 plots 表；任一回落失败都保留在队中，可反复重试直到逐株对账一致。
 */

/** 关联写入类型：按有效补植计划对账地块缺株数（可顺带回写最近补植日期） */
export type PendingWriteKind = 'plot_reconcile';

export interface PlotReconcilePayload {
  /** 对账后的目标缺株数（株） */
  missingCount: number;
  /** 最近补植日期（仅在补植完成时携带） */
  lastReplantDate?: string;
}

export interface PendingWrite {
  /** 一种地块同时只有一条对账待办：`plot_reconcile:${plotId}` */
  id: string;
  kind: PendingWriteKind;
  /** 关联地块 */
  plotId: string;
  /** 写入内容（绝对值，天然幂等，重试安全） */
  payload: PlotReconcilePayload;
  /** 已尝试次数 */
  attempts: number;
  /** 最近一次失败原因 */
  lastError: string;
  createdAt: string;
  updatedAt: string;
}
