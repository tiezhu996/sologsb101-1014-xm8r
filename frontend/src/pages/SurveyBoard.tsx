/**
 * /surveys 成活率与株高验收台
 * 按测次录入成活株数与平均株高，保存时固定当次栽植株数并自动算成活率；
 * 栽植记录变化后相关验收先失效，复核时决定保留原测次或按新株数重算，旧数据可人工补证。
 * 消费模型：Survey、Plot、Planting；复用组件：<RateTag>、<EmptyPanel>、<StatBadge>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Dropdown,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  RiseOutlined,
  FallOutlined,
  ToolOutlined,
  SafetyCertificateOutlined,
  HistoryOutlined,
  FileSearchOutlined,
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
  type SurveyValidity,
} from '../types/survey';
import { SURVIVAL_WARN_RATE, calcSurvivalRate, percentText } from '../utils/rate';

interface SurveyFormValues {
  plotId: string;
  round: number;
  date: Dayjs;
  aliveCount: number;
  avgHeightCm: number;
}

const VALIDITY_COLOR: Record<SurveyValidity, string> = {
  effective: 'green',
  stale: 'orange',
  unproven: 'red',
};

export default function SurveyBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const ready = usePlotStore((state) => state.ready);
  const statOf = usePlotStore((state) => state.statOf);
  const summaryOf = usePlotStore((state) => state.summaryOf);
  const plantings = usePlotStore((state) => state.plantings);
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
  const review = useSurveyStore((state) => state.review);
  const deleteSurvey = useSurveyStore((state) => state.deleteSurvey);
  const surveyRevision = useSurveyStore((state) => state.revision);

  const { rows, loading } = useIdbTable<Survey>(db.surveys, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Survey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** 待补证弹窗当前测次 */
  const [proving, setProving] = useState<Survey | null>(null);
  const [provenCount, setProvenCount] = useState<number | null>(null);
  const [form] = Form.useForm<SurveyFormValues>();

  const filtered = useMemo(() => {
    void surveyRevision;
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.validity !== 'all' && row.validity !== filters.validity) return false;
        if (filters.from !== '' && row.date < filters.from) return false;
        if (filters.to !== '' && row.date > filters.to) return false;
        if (filters.level !== 'all') {
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
    const rated = plots.filter((plot) => statOf(plot.id).effectiveSurveyCount > 0);
    const warn = rated.filter((plot) => statOf(plot.id).latestRate < SURVIVAL_WARN_RATE);
    const strong = rated.filter((plot) => statOf(plot.id).latestRate >= 85);
    return {
      ratedCount: rated.length,
      warnCount: warn.length,
      staleCount: plots.reduce((acc, plot) => acc + statOf(plot.id).staleCount, 0),
      unprovenCount: plots.reduce((acc, plot) => acc + statOf(plot.id).unprovenCount, 0),
      strongCount: strong.length,
      strongPct: rated.length === 0 ? 0 : Math.round((strong.length / rated.length) * 1000) / 10,
      avgRate:
        rated.length === 0
          ? 0
          : Math.round((rated.reduce((acc, plot) => acc + statOf(plot.id).latestRate, 0) / rated.length) * 10) / 10,
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
      const payload = {
        plotId: values.plotId,
        round: values.round,
        date: values.date.format('YYYY-MM-DD'),
        aliveCount: values.aliveCount,
        avgHeightCm: values.avgHeightCm,
      };
      if (editing === null) {
        const row = await createSurvey(payload);
        message.success(`已录入第 ${row.round} 测次，固定株数 ${row.plantedCount ?? 0} 株，成活率 ${row.survivalRate}%`);
        if (row.survivalRate < SURVIVAL_WARN_RATE) {
          message.warning(`成活率 ${row.survivalRate}% 低于告警阈值 ${SURVIVAL_WARN_RATE}%，建议生成补植计划`, 6);
        }
      } else {
        await updateSurvey(editing.id, payload);
        message.success('验收记录已更新（当次栽植株数快照保持不变）');
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
    message[result.includes('无缺株') || result.includes('没有有效') ? 'info' : 'success'](result);
  };

  const handleKeep = async (record: Survey): Promise<void> => {
    try {
      const kept = await review(record.id, 'keep');
      if (kept === null) return;
      message.success(`第 ${record.round} 测次已保留原株数快照 ${kept.plantedCount ?? '—'} 株，恢复有效`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '复核失败');
    }
  };

  const handleRecompute = async (record: Survey): Promise<void> => {
    const current = plantings
      .filter((row) => row.plotId === record.plotId)
      .reduce((acc, row) => acc + row.count, 0);
    try {
      const next = await review(record.id, 'recompute');
      if (next === null) return;
      message.success(
        `第 ${record.round} 测次已按当前栽植总株数 ${current} 株重算，成活率 ${next.survivalRate}%`,
      );
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重算失败');
    }
  };

  const openProve = (record: Survey): void => {
    setProving(record);
    setProvenCount(record.plantedCount ?? null);
  };

  const handleProve = async (): Promise<void> => {
    if (proving === null) return;
    if (provenCount === null || provenCount <= 0) {
      message.warning('请填写能证明的当次栽植株数');
      return;
    }
    const next = await review(proving.id, 'prove', provenCount);
    message.success(
      `第 ${proving.round} 测次已补证为 ${provenCount} 株，成活率 ${next?.survivalRate ?? '—'}%，恢复有效`,
    );
    setProving(null);
  };

  const columns: ColumnsType<Survey> = [
    {
      title: '地块',
      key: 'plot',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前栽植 {statOf(record.plotId).plantTotal.toLocaleString('zh-CN')} 株
            {record.plantedCount !== null && record.plantedCount !== statOf(record.plotId).plantTotal ? (
              <span>（当次固定 {record.plantedCount.toLocaleString('zh-CN')} 株）</span>
            ) : null}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '测次',
      dataIndex: 'round',
      key: 'round',
      width: 84,
      align: 'center',
      render: (value: number) => <Tag color="blue">第 {value} 次</Tag>,
      sorter: (a, b) => a.round - b.round,
    },
    { title: '验收日期', dataIndex: 'date', key: 'date', width: 128, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '成活株数',
      dataIndex: 'aliveCount',
      key: 'aliveCount',
      width: 110,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '固定株数',
      dataIndex: 'plantedCount',
      key: 'plantedCount',
      width: 110,
      align: 'right',
      render: (value: number | null) => (value === null ? <Tag color="red">待补证</Tag> : value.toLocaleString('zh-CN')),
    },
    {
      title: '成活率',
      key: 'rate',
      width: 180,
      render: (_value, record) => {
        const summary = summaryOf(record.plotId);
        const point = summary.points.find((item) => item.surveyId === record.id);
        if (record.validity === 'unproven') {
          return <Tag icon={<FileSearchOutlined />} color="red">待补证，成活率不可用</Tag>;
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
      width: 128,
      align: 'right',
      render: (value: number, record) => {
        const summary = summaryOf(record.plotId);
        const index = summary.points.findIndex((item) => item.surveyId === record.id);
        const previous = index > 0 ? summary.points[index - 1] : null;
        return (
          <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
            <span>{value} cm</span>
            {previous !== null ? (
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
      title: '有效性',
      key: 'validity',
      width: 130,
      render: (_value, record) => (
        <TooltipValidity record={record} />
      ),
    },
    {
      title: '等级来源',
      key: 'gradeSource',
      width: 110,
      render: (_value, record) =>
        record.gradeManual ? <Tag color="purple">人工复核</Tag> : <Tag>自动判定</Tag>,
    },
    {
      title: '复核操作',
      key: 'review',
      width: 170,
      render: (_value, record) => {
        if (record.validity === 'unproven') {
          return (
            <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => openProve(record)}>
              补证株数
            </Button>
          );
        }
        if (record.validity === 'stale') {
          const current = plantings
            .filter((row) => row.plotId === record.plotId)
            .reduce((acc, row) => acc + row.count, 0);
          const preview = calcSurvivalRate(record.aliveCount, current);
          return (
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'keep',
                    icon: <HistoryOutlined />,
                    label: `保留原测次（${record.plantedCount ?? '—'} 株，${record.survivalRate}%）`,
                    onClick: () => void handleKeep(record),
                  },
                  {
                    key: 'recompute',
                    icon: <RiseOutlined />,
                    label: `按新株数重算（${current} 株，${preview}%）`,
                    onClick: () => void handleRecompute(record),
                  },
                ],
              }}
            >
              <Button size="small" type="link" icon={<SafetyCertificateOutlined />}>
                去复核
              </Button>
            </Dropdown>
          );
        }
        return <Typography.Text type="secondary" style={{ fontSize: 12 }}>已确认有效</Typography.Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该测次记录？"
            description="以它为来源的未完成补植计划会退出有效范围。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteSurvey(record.id);
              message.success('验收记录已删除，缺株数已重新对账');
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
    return stat.effectiveSurveyCount > 0 && stat.latestRate < SURVIVAL_WARN_RATE;
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="验收记录" value={rows.length} suffix="条" tone="primary" icon={<ExperimentOutlined />} />
        <StatBadge label="有效验收地块" value={stats.ratedCount} suffix="块" tone="info" />
        <StatBadge label="平均成活率" value={percentText(stats.avgRate)} percent={stats.avgRate} tone="success" />
        <StatBadge label="优秀地块占比" value={percentText(stats.strongPct)} percent={stats.strongPct} tone="primary" />
        <StatBadge
          label="待复核测次"
          value={stats.staleCount}
          suffix="条"
          tone={stats.staleCount > 0 ? 'warning' : 'default'}
          hint="栽植记录变化后等待人工保留或重算的测次"
        />
        <StatBadge
          label="待补证测次"
          value={stats.unprovenCount}
          suffix="条"
          tone={stats.unprovenCount > 0 ? 'danger' : 'default'}
          hint="旧数据无法证明当次栽植株数，补证后才恢复有效"
        />
        <StatBadge
          label="告警地块"
          value={stats.warnCount}
          suffix="块"
          tone={stats.warnCount > 0 ? 'danger' : 'default'}
          hint={`最新有效成活率低于 ${SURVIVAL_WARN_RATE}% 的地块`}
        />
      </div>

      {stats.staleCount + stats.unprovenCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`${stats.staleCount} 个测次待复核、${stats.unprovenCount} 个测次待补证`}
          description="每次验收固定保存当次栽植株数，事后补录/修订栽植不会改动历史成活率。请在「复核操作」列选择保留原测次或按新株数重算；旧数据无法证明株数的测次请人工补证，补证前不参与告警与缺株对账。"
        />
      ) : null}

      {warnPlots.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${warnPlots.length} 个地块的最新有效成活率低于 ${SURVIVAL_WARN_RATE}%`}
          description={
            <Space direction="vertical" size={2}>
              {warnPlots.map((plot) => (
                <span key={plot.id}>
                  {plot.name}：最新有效成活率 {percentText(statOf(plot.id).latestRate)}，建议补植{' '}
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
              style={{ minWidth: 130 }}
              value={filters.validity}
              onChange={(value: string) => setFilters({ validity: value as SurveyValidity | 'all' })}
              options={[
                { value: 'all', label: '全部状态' },
                ...(['effective', 'stale', 'unproven'] as SurveyValidity[]).map((value) => ({
                  value,
                  label: SURVEY_VALIDITY_LABEL[value],
                })),
              ]}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>等级</span>
            <Select
              style={{ minWidth: 140 }}
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
            loading={loading || !ready}
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
        title={editing === null ? '录入验收测次' : '编辑验收测次'}
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
            成活率 = 成活株数 / 当次栽植株数，保存时把当时的栽植总株数固定下来；之后即便补录或修订栽植记录，
            本测次成活率也不再变化，而是等待复核时选择保留或重算。成活率低于 {SURVIVAL_WARN_RATE}% 会给出告警提示。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={proving ? `第 ${proving.round} 测次 · 人工补证当次栽植株数` : ''}
        open={proving !== null}
        onCancel={() => setProving(null)}
        onOk={() => void handleProve()}
        okText="补证并恢复有效"
        cancelText="取消"
      >
        {proving ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text>
              该测次为旧数据升级遗留，无法由历史成活率反推出可靠的当次栽植株数。请依据验收单据 / 现场记录补证：
            </Typography.Text>
            <InputNumber
              autoFocus
              min={1}
              max={500000}
              step={100}
              style={{ width: '100%' }}
              value={provenCount}
              onChange={(value) => setProvenCount(value)}
              placeholder="当次验收时实际栽植总株数"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前记录成活 {proving.aliveCount.toLocaleString('zh-CN')} 株；补证后成活率将按
              {provenCount && provenCount > 0
                ? ` ${calcSurvivalRate(proving.aliveCount, provenCount)}% `
                : ' 补证株数 '}
              重新计算，测次恢复有效并重新纳入缺株对账。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}

/** 有效性标签（带说明） */
function TooltipValidity({ record }: { record: Survey }) {
  const hint: Record<SurveyValidity, string> = {
    effective: '株数快照可证，成活率按当次固定株数计算',
    stale: '栽植记录已变化：保留着原测次快照，等待人工保留或重算',
    unproven: '旧数据无法证明当次栽植株数，补证前不参与对账',
  };
  return (
    <Space direction="vertical" size={0}>
      <Tag color={VALIDITY_COLOR[record.validity]} icon={record.validity === 'effective' ? undefined : <FileSearchOutlined />}>
        {SURVEY_VALIDITY_LABEL[record.validity]}
      </Tag>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {hint[record.validity]}
      </Typography.Text>
    </Space>
  );
}
