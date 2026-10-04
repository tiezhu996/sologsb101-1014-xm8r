# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 5 个模块页面
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入并固定当次株数、失效复核（保留 / 重算）、待补证补录、低于阈值告警、批量调整等级 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：来源测次溯源与有效范围、状态流转（待补植→已补植→已复核）、行内草稿、outbox 失败重试、JSON 导入导出、结构版本查看 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引，`version(3)` 落地
  「验收固定口径 + 补植溯源 + 补偿队列」并执行 `.upgrade()` 迁移：
  * **验收固定当次株数**：`surveys` 增加 `plantedCount`（验收保存时的栽植总株数快照）、
    `validity`（`valid` 有效 / `invalid` 失效待复核 / `pending_evidence` 待补证）及复核留痕字段；
    成活率统一按「成活株数 ÷ plantedCount」计算，不随后续栽植补录 / 修订漂移。
    迁移时能由当前株数反推出原成活率的自动回填并保持有效，否则留在「待补证」。
  * **补植计划溯源**：`replants` 增加 `sourceSurveyId`、`sourceMissingCount`（来源验收与当时缺株）、
    `replantedCount`、`completedDate`；旧计划按计划日期就近匹配来源验收。
  * **补偿队列**：新增 `outbox` 表；栽植记录变化的级联写入（验收失效 → 计划退出有效范围 → 缺株对账）
    与业务行同事务登记，失败保留并指数退避重试，启动时与补植计划页均可继续重试。
  * 迁移最后把地块 `missingCount` 与有效补植计划逐株对账重算。
  * v1 → v2 的历史迁移（`updatedAt`、复合索引、`grade` 等）保持不变。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade, validity |
  | `replants` | id | plotId, planDate, state, species, sourceSurveyId |
  | `outbox` | id（同地块同类任务固定 id 去重） | type, plotId, status, runAfter |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 → 验收 → 补植** 三层互相引用：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（每地块 2 批）、6 条栽植记录（每地块 2 条，引用真实批次 id）；
  * 7 条验收记录（每地块 2–3 个测次，成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **成活率固定口径**：成活率 = 成活株数 ÷ **验收当次保存的栽植总株数快照**（`plantedCount`），
  统一在 `src/utils/rate.ts` 计算。每次验收保存即固定，之后补录 / 修订栽植记录不会自动改写历史成活率。
* **栽植变化 → 验收失效**：补录、修订或删除栽植记录（含删除被引用的苗木批次）后，同地块的有效验收
  自动置为「失效待复核」（同事务 + `outbox` 补偿，失败可继续重试）；已经复核保留的测次在再次变化时会被重新失效。
* **复核决策**：失效测次可在验收台选择「保留原测次」（沿用固定株数快照）或「按新株数重算」
  （以当前栽植总株数重锚快照）；旧数据升级时无法证明株数的测次留在「待补证」，补录当次株数后恢复有效。
* **补植计划溯源**：由验收生成的计划记录来源验收与当时缺株；来源测次失效 / 删除 / 待补证时，
  **待补植**计划退出有效范围（不再计入缺株），来源复核恢复有效后自动重新计入；
  **已补植 / 已复核**计划始终保留用于留痕对账，不随来源失效而删除。
* **缺株逐株对账**：地块缺株数 = 该地块全部「有效待补植」计划缺株数之和，在验收复核、计划增删改、
  补植完成、存档导入及启动时统一重算；地块台账展示账实差额，可在补植计划页一键重试对账。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
  （仅对有效测次判定，失效 / 待补证测次不参与统计与告警。）
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时落实际补植株数与完成日期、写入最近补植日期，
  计划退出有效范围并按上述规则逐株对账；历史验收的固定株数快照不被补植动作改写。
