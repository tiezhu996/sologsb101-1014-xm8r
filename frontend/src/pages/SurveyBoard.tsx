/**
 * /surveys 成活率与株高验收台
 * 按测次录入成活株数与平均株高；每次验收固定保存当次栽植株数，成活率按该固定口径计算。
 * 补录 / 修订栽植记录后相关验收自动失效，复核时决定保留原测次或按新株数重算；
 * 旧数据升级时无法证明株数的测次留在「待补证」，补证后恢复有效。
 * 消费模型：Survey、Plot、Planting；复用组件：<RateTag>、<EmptyPanel>、<StatBadge>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileProtectOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useSurveyStore } from '../stores/surveyStore';
import { db } from '../utils/db';
import {
  RATE_LEVEL_LABEL,
  RATE_LEVEL_OPTIONS,
  SURVEY_VALIDITY_LABEL,
  type RateLevel,
  type Survey,
  type SurveyDraft,
  type SurveyValidity,
} from '../types/survey';
import { SURVIVAL_WARN_RATE, percentText } from '../utils/rate';

interface SurveyFormValues {
  plotId: string;
  round: number;
  date: Dayjs;
  aliveCount: number;
  avgHeightCm: number;
}

const VALIDITY_COLOR: Record<SurveyValidity, string> = {
  valid: 'green',
  invalid: 'volcano',
  pending_evidence: 'gold',
};

const VALIDITY_OPTIONS: Array<{ value: SurveyValidity | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'valid', label: SURVEY_VALIDITY_LABEL.valid },
  { value: 'invalid', label: SURVEY_VALIDITY_LABEL.invalid },
  { value: 'pending_evidence', label: SURVEY_VALIDITY_LABEL.pending_evidence },
];

export default function SurveyBoard() {
  const { message, modal } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const statOf = usePlotStore((state) => state.statOf);
  const summaryOf = usePlotStore((state) => state.summaryOf);
  const filters = useSurveyStore((state) => state.filters);
  const setFilters = useSurveyStore((state) => state.setFilters);
  const resetFilters = useSurveyStore((state) => state.resetFilters);
  const selectedIds = useSurveyStore((state) => state.selectedIds);
  const setSelectedIds = useSurveyStore((state) => state.setSelectedIds);
  const gradeDraft = useSurveyStore((state) => state.gradeDraft);
  const setGradeDraft = useSurveyStore((state) => state.setGradeDraft);
  const bulkApplyGrade = useSurveyStore((state) => state.bulkApplyGrade);
  const generateReplant = useSurveyStore((state) => state.generateReplant);
  const createSurvey = useSurveyStore((state) => state.createSurvey);
  const updateSurvey = useSurveyStore((state) => state.updateSurvey);
  const deleteSurvey = useSurveyStore((state) => state.deleteSurvey);
  const reviewKeep = useSurveyStore((state) => state.reviewKeep);
  const reviewRecalculate = useSurveyStore((state) => state.reviewRecalculate);
  const provideEvidence = useSurveyStore((state) => state.provideEvidence);
  const surveyRevision = useSurveyStore((state) => state.revision);

  const { rows, loading } = useIdbTable<Survey>(db.surveys, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Survey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [evidenceTarget, setEvidenceTarget] = useState<Survey | null>(null);
  const [evidenceCount, setEvidenceCount] = useState<number | null>(null);
  const [evidenceSaving, setEvidenceSaving] = useState(false);
  const [form] = Form.useForm<SurveyFormValues>();

  const filtered = useMemo(() => {
    void surveyRevision;
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.from !== '' && row.date < filters.from) return false;
        if (filters.to !== '' && row.date > filters.to) return false;
        if (filters.validity !== 'all' && row.validity !== filters.validity) return false;
        if (filters.level !== 'all') {
          if (row.validity !== 'valid') return false;
          const summary = summaryOf(row.plotId);
          const point = summary.points.find((item) => item.surveyId === row.id);
          const level: RateLevel = point?.level ?? row.grade;
          if (level !== filters.level) return false;
        }
        if (key === '') return true;
        const plotName = plots.find((item) => item.id === row.plotId)?.name ?? '';
        return plotName.toLowerCase().includes(key) || row.date.includes(key) || `第${row.round}`.includes(key);
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.round - a.round);
    // surveyRevision 用于写操作后强制重算派生列
  }, [rows, filters, plots, summaryOf, surveyRevision]);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const stats = useMemo(() => {
    const rated = plots.filter((plot) => statOf(plot.id).validSurveyCount > 0);
    const warn = rated.filter((plot) => statOf(plot.id).latestRate < SURVIVAL_WARN_RATE);
    const strong = rated.filter((plot) => statOf(plot.id).latestRate >= 85);
    const invalid = plots.reduce((acc, plot) => acc + statOf(plot.id).invalidSurveyCount, 0);
    const pendingEvidence = plots.reduce((acc, plot) => acc + statOf(plot.id).pendingEvidenceCount, 0);
    return {
      ratedCount: rated.length,
      warnCount: warn.length,
      strongCount: strong.length,
      strongPct: rated.length === 0 ? 0 : Math.round((strong.length / rated.length) * 1000) / 10,
      avgRate:
        rated.length === 0
          ? 0
          : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10,
      invalid,
      pendingEvidence,
    };
  }, [plots, statOf]);

  const openCreate = (): void => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    const nextRound = rows.filter((row) => row.plotId === plotId).length + 1;
    setEditing(null);
    form.setFieldsValue({
      plotId,
      round: nextRound,
      date: dayjs(),
      aliveCount: 0,
      avgHeightCm: 0,
    });
    setOpen(true);
  };

  const openEdit = (row: Survey): void => {
    setEditing(row);
    form.setFieldsValue({
      plotId: row.plotId,
      round: row.round,
      date: dayjs(row.date),
      aliveCount: row.aliveCount,
      avgHeightCm: row.avgHeightCm,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: SurveyDraft = {
        plotId: values.plotId,
        round: values.round,
        date: values.date.format('YYYY-MM-DD'),
        aliveCount: values.aliveCount,
        avgHeightCm: values.avgHeightCm,
      };
      if (editing === null) {
        const row = await createSurvey(payload);
        message.success(`已录入第 ${row.round} 测次，固定当次株数 ${row.plantedCount ?? '-'} 株，成活率 ${row.survivalRate}%`);
        if (row.survivalRate < SURVIVAL_WARN_RATE) {
          message.warning(`成活率 ${row.survivalRate}% 低于告警阈值 ${SURVIVAL_WARN_RATE}%，建议生成补植计划`, 6);
        }
      } else {
        await updateSurvey(editing.id, payload);
        message.success('验收记录已更新（固定株数口径不变）');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkGrade = async (): Promise<void> => {
    const count = await bulkApplyGrade(gradeDraft);
    if (count === 0) {
      message.info('请先在列表中勾选需要调整等级的验收记录');
      return;
    }
    message.success(`已把 ${count} 条记录的成活率等级调整为「${RATE_LEVEL_LABEL[gradeDraft]}」`);
  };

  const handleGenerateReplant = async (): Promise<void> => {
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    if (plotId === '') {
      message.info('请先选择地块');
      return;
    }
    const result = await generateReplant(plotId);
    message.success(result);
  };

  const handleReview = (record: Survey, decision: 'keep' | 'recalculate'): void => {
    const summary = summaryOf(record.plotId);
    if (decision === 'keep') {
      modal.confirm({
        title: `保留第 ${record.round} 测次原测次？`,
        content: `沿用验收时固定保存的株数快照（${record.plantedCount ?? '-'} 株）重算并恢复有效，不采用补录 / 修订后的株数。`,
        okText: '保留原测次',
        cancelText: '取消',
        onOk: async () => {
          try {
            await reviewKeep(record.id);
            message.success('已保留原测次并恢复有效');
          } catch (error) {
            message.error(error instanceof Error ? error.message : '复核失败');
          }
        },
      });
      return;
    }
    modal.confirm({
      title: `按新株数重算第 ${record.round} 测次？`,
      content: `以当前栽植总株数 ${summary.totalCount} 株重锚当次株数并重算成活率，重算后恢复有效。`,
      okText: '按新株数重算',
      cancelText: '取消',
      onOk: async () => {
        try {
          await reviewRecalculate(record.id);
          message.success('已按新株数重算并恢复有效');
        } catch (error) {
          message.error(error instanceof Error ? error.message : '重算失败');
        }
      },
    });
  };

  const openEvidence = (record: Survey): void => {
    setEvidenceTarget(record);
    setEvidenceCount(record.plantedCount ?? (statOf(record.plotId).plantTotal || null));
  };

  const submitEvidence = async (): Promise<void> => {
    if (evidenceTarget === null || evidenceCount === null) return;
    try {
      setEvidenceSaving(true);
      await provideEvidence(evidenceTarget.id, evidenceCount);
      message.success('已补证当次栽植株数并恢复有效');
      setEvidenceTarget(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '补证失败');
    } finally {
      setEvidenceSaving(false);
    }
  };

  const columns: ColumnsType<Survey> = [
    {
      title: '地块',
      key: 'plot',
      width: 190,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前栽植 {statOf(record.plotId).plantTotal.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 80,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
      sorter: (a, b) => a.round - b.round,
    },
    { title: '验收日期', dataIndex: 'date', key: 'date', width: 116, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '当次株数',
      key: 'plantedCount',
      width: 110,
      align: 'right',
      render: (_value, record) =>
        record.plantedCount === null ? (
          <Tag color="gold">待补证</Tag>
        ) : (
          <Tooltip title="该测次保存时固定的栽植总株数，不随后续补录 / 修订变化">
            {record.plantedCount.toLocaleString('zh-CN')}
          </Tooltip>
        ),
    },
    {
      title: '成活株数',
      dataIndex: 'aliveCount',
      key: 'aliveCount',
      width: 100,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '成活率',
      key: 'rate',
      width: 178,
      render: (_value, record) => {
        const summary = summaryOf(record.plotId);
        const point = summary.points.find((item) => item.surveyId === record.id);
        if (record.validity === 'pending_evidence') {
          return <Tag color="gold">待补证 · 暂不计入</Tag>;
        }
        if (record.validity === 'invalid') {
          return (
            <Tooltip title={record.invalidReason}>
              <Space direction="vertical" size={0}>
                <Tag color="volcano">失效待复核</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }} delete>
                  原 {record.survivalRate.toFixed(1)}%
                </Typography.Text>
              </Space>
            </Tooltip>
          );
        }
        return (
          <RateTag
            rate={point?.rate ?? record.survivalRate}
            level={point?.level ?? record.grade}
            manual={record.gradeManual}
          />
        );
      },
    },
    {
      title: '平均株高',
      dataIndex: 'avgHeightCm',
      key: 'avgHeightCm',
      width: 120,
      align: 'right',
      render: (value: number, record) => {
        const summary = summaryOf(record.plotId);
        const index = summary.points.findIndex((item) => item.surveyId === record.id);
        const previous = index > 0 ? summary.points[index - 1] : null;
        return (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <span>{value} cm</span>
            {previous !== null && record.validity === 'valid' ? (
              <Typography.Text
                type={value >= previous.avgHeightCm ? 'success' : 'danger'}
                style={{ fontSize: 12 }}
              >
                {value >= previous.avgHeightCm ? <RiseOutlined /> : <FallOutlined />}{' '}
                {Math.abs(Math.round((value - previous.avgHeightCm) * 10) / 10)} cm
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '状态 / 复核',
      key: 'validity',
      width: 230,
      render: (_value, record) => {
        if (record.validity === 'valid') {
          return (
            <Space size={4} wrap>
              <Tag color="green">{SURVEY_VALIDITY_LABEL.valid}</Tag>
              {record.gradeManual ? <Tag color="purple">等级人工</Tag> : <Tag>自动判定</Tag>}
              {record.reviewDecision !== null ? (
                <Tooltip title={`最近复核：${record.reviewDecision === 'keep' ? '保留原测次' : '按新株数重算'}`}>
                  <Tag icon={<AuditOutlined />} color="cyan">
                    {record.reviewDecision === 'keep' ? '保留原测次' : '已重算'}
                  </Tag>
                </Tooltip>
              ) : null}
            </Space>
          );
        }
        return (
          <Space size={4} wrap>
            <Tooltip title={record.invalidReason}>
              <Tag color={VALIDITY_COLOR[record.validity]}>{SURVEY_VALIDITY_LABEL[record.validity]}</Tag>
            </Tooltip>
            {record.validity === 'pending_evidence' ? (
              <Button size="small" type="link" icon={<FileProtectOutlined />} onClick={() => openEvidence(record)}>
                补证
              </Button>
            ) : (
              <>
                <Button
                  size="small"
                  type="link"
                  disabled={record.plantedCount === null}
                  onClick={() => handleReview(record, 'keep')}
                >
                  保留原测次
                </Button>
                <Button size="small" type="link" onClick={() => handleReview(record, 'recalculate')}>
                  按新株数重算
                </Button>
              </>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该测次记录？"
            description="引用该测次的待补植计划将退出有效范围并重新对账缺株数。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteSurvey(record.id);
              message.success('验收记录已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const warnPlots = plots.filter((plot) => {
    const stat = statOf(plot.id);
    return stat.validSurveyCount > 0 && stat.latestRate < SURVIVAL_WARN_RATE;
  });

  const reviewWorkPlots = plots.filter((plot) => statOf(plot.id).invalidSurveyCount + statOf(plot.id).pendingEvidenceCount > 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="验收记录" value={rows.length} suffix="条" tone="primary" icon={<ExperimentOutlined />} />
        <StatBadge label="有效验收地块" value={stats.ratedCount} suffix="块" tone="info" />
        <StatBadge label="平均成活率" value={percentText(stats.avgRate)} percent={stats.avgRate} tone="success" />
        <StatBadge
          label="优秀地块占比"
          value={percentText(stats.strongPct)}
          percent={stats.strongPct}
          tone="primary"
          hint="最新有效成活率 ≥ 85% 的地块占比"
        />
        <StatBadge
          label="告警地块"
          value={stats.warnCount}
          suffix="块"
          tone={stats.warnCount > 0 ? 'danger' : 'default'}
          hint={`最新有效成活率低于 ${SURVIVAL_WARN_RATE}% 的地块`}
        />
        <StatBadge
          label="待复核 / 待补证"
          value={stats.invalid + stats.pendingEvidence}
          suffix="测次"
          tone={stats.invalid + stats.pendingEvidence > 0 ? 'warning' : 'default'}
          hint="栽植记录补录 / 修订后失效，或旧数据无法证明当次株数"
        />
      </div>

      {reviewWorkPlots.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${reviewWorkPlots.length} 个地块的验收测次需要复核或补证`}
          description={
            <Space direction="vertical" size={2}>
              {reviewWorkPlots.map((plot) => {
                const stat = statOf(plot.id);
                return (
                  <span key={plot.id}>
                    {plot.name}：{stat.invalidSurveyCount} 测次失效待复核
                    {stat.pendingEvidenceCount > 0 ? `，${stat.pendingEvidenceCount} 测次待补证` : ''}
                    ，可在列表中选择「保留原测次」或「按新株数重算」
                  </span>
                );
              })}
            </Space>
          }
        />
      ) : null}

      {warnPlots.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${warnPlots.length} 个地块的最新有效成活率低于 ${SURVIVAL_WARN_RATE}%`}
          description={
            <Space direction="vertical" size={2}>
              {warnPlots.map((plot) => (
                <span key={plot.id}>
                  {plot.name}：最新有效成活率 {percentText(statOf(plot.id).latestRate)}，当时缺株{' '}
                  {statOf(plot.id).suggestReplant} 株
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card
        title="成活率与株高验收台"
        extra={
          <Space>
            <Button icon={<ToolOutlined />} onClick={() => void handleGenerateReplant()}>
              生成补植计划
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plots.length === 0}>
              录入测次
            </Button>
          </Space>
        }
      >
        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>地块</span>
            <Select
              style={{ minWidth: 200 }}
              value={filters.plotId}
              onChange={(value: string) => setFilters({ plotId: value })}
              options={[
                { value: 'all', label: '全部地块' },
                ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>有效性</span>
            <Select
              style={{ minWidth: 140 }}
              value={filters.validity}
              onChange={(value: string) => setFilters({ validity: value as SurveyValidity | 'all' })}
              options={VALIDITY_OPTIONS}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>等级</span>
            <Select
              style={{ minWidth: 130 }}
              value={filters.level}
              onChange={(value: string) => setFilters({ level: value as RateLevel | 'all' })}
              options={[
                { value: 'all', label: '全部等级' },
                ...RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>日期区间</span>
            <DatePicker
              value={filters.from === '' ? null : dayjs(filters.from)}
              onChange={(value) => setFilters({ from: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="开始日期"
            />
            <DatePicker
              value={filters.to === '' ? null : dayjs(filters.to)}
              onChange={(value) => setFilters({ to: value === null ? '' : value.format('YYYY-MM-DD') })}
              placeholder="结束日期"
            />
          </Space>
          <Button onClick={resetFilters}>重置筛选</Button>
          <Tag color="cyan">
            命中 {filtered.length} / {rows.length} 条
          </Tag>
        </Space>

        <Space size={12} wrap style={{ marginBottom: 14 }}>
          <Tag color={selectedIds.length > 0 ? 'purple' : 'default'}>已选 {selectedIds.length} 条</Tag>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>批量调整为</span>
            <Select
              style={{ minWidth: 120 }}
              value={gradeDraft}
              onChange={(value: RateLevel) => setGradeDraft(value)}
              options={RATE_LEVEL_OPTIONS.map((level) => ({ value: level, label: RATE_LEVEL_LABEL[level] }))}
            />
          </Space>
          <Button type="primary" ghost disabled={selectedIds.length === 0} onClick={() => void handleBulkGrade()}>
            批量调整成活率等级
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={() => setSelectedIds([])}>
            取消选择
          </Button>
        </Space>

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有任何验收记录"
            description="按测次录入成活株数与平均株高，保存时固定当次栽植株数并自动计算成活率，低于阈值时告警。"
            actionText="录入第一个测次"
            onAction={openCreate}
          />
        ) : (
          <Table<Survey>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1560 }}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel title="没有符合筛选条件的验收记录" actionText="重置筛选" onAction={resetFilters} />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '录入验收测次' : `编辑验收测次 · 第 ${editing.round} 测次`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plotId" label="地块" style={{ flex: 2 }} rules={[{ required: true, message: '请选择地块' }]}>
              <Select options={plots.map((plot) => ({ value: plot.id, label: plot.name }))} />
            </Form.Item>
            <Form.Item name="round" label="测次" style={{ flex: 1 }} rules={[{ required: true, message: '请填写测次' }]}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="验收日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="aliveCount"
              label="成活株数"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写成活株数' }]}
            >
              <InputNumber min={0} max={500000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="avgHeightCm"
              label="平均株高（cm）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写平均株高' }]}
            >
              <InputNumber min={0} max={2000} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存时固定当次栽植总株数，成活率 = 成活株数 ÷ 该固定株数；之后补录 / 修订栽植记录只会把测次置为失效，
            由复核决定保留原测次或按新株数重算。成活率低于 {SURVIVAL_WARN_RATE}% 会给出告警提示。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={evidenceTarget === null ? '' : `补证 · 第 ${evidenceTarget.round} 测次当次栽植株数`}
        open={evidenceTarget !== null}
        onCancel={() => setEvidenceTarget(null)}
        onOk={() => void submitEvidence()}
        confirmLoading={evidenceSaving}
        okText="补证并恢复有效"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          旧数据缺少该测次验收时的栽植株数，无法证明成活率口径。请依据原始验收单据补录当时的栽植总株数，
          补证后按固定株数恢复有效。
        </Typography.Paragraph>
        <InputNumber
          autoFocus
          min={1}
          max={500000}
          step={100}
          style={{ width: '100%' }}
          placeholder="当次栽植总株数（株）"
          value={evidenceCount}
          onChange={(value) => setEvidenceCount(value)}
        />
      </Modal>
    </div>
  );
}
