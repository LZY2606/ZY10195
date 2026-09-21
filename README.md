# 地下环闭合仪

本地三维洞穴导线环闭合与平差工具。服务端使用 Node.js + TypeScript + 内置 `node:sqlite`，页面使用原生 HTML Canvas 绘制站点图、误差椭球和残差向量；无需外部数据库服务。

## 快速开始

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run && corepack pnpm dev --host 127.0.0.1 --port 5535
```

访问：

```text
http://127.0.0.1:5535
```

页面标题为“地下环闭合仪”。SQLite 默认写入 `data/cave.db`；可用环境变量覆盖：

```bash
CAVE_DB=/absolute/path/cave.db CAVE_FIXTURE=/absolute/path/fixture.json corepack pnpm dev
```

## 固定验收数据

固定数据位于 `data/fixture.json`：

- 主分量 `A-B-C-D-A` 含一个度量独立闭合环，`A-E` 是支洞边。
- `obs-ab-1` 与 `obs-ba-1` 是同一边的两条往返观测证据，分别参与平差和往返校差。
- `obs-da-1` 是疑似测站标签写反的边；默认候选 `flip-da-1` 停用。启用候选只改变平差时的有效方向，不覆盖、不删除原观测。
- `F-G-H` 是孤立、仅有方位/倾角且无斜距的分量。
- 站点 `D` 和 `F` 名称同为“同名点”，但 ID 不同，系统不会按名称合并。

## 数据口径

- 坐标系：局部右手坐标，X 为东、Y 为北、Z 为上；站点种子坐标只用于初始化，锁定控制点坐标不变。
- 方位角：北方向 0°，顺时针至 360°；残差用最短环绕包装，因此 359.9° 到 0.1° 的误差解释为 +0.2°，不会生成 359.8°。
- 倾角：水平面为 0°，向上为正、向下为负。
- 斜距向量：水平分量为 `S cos(I)`，垂直观测分量为 `S sin(I)`；坐标高差还计入仪器高减觇高。
- 平差模型：每个斜距、方位、倾角分别形成观测行，使用非线性 Gauss–Newton 最小二乘，默认斜距 σ=0.005 m、角度 σ=0.02°，用户权重乘到这些行上。
- 往返观测：两条记录是两条证据；只有斜距边参与最小独立环基，往返校差单列显示，不用二边环覆盖真正的独立环。
- 翻转候选：候选是原始观测的解释副本。当前 fixture 采用“测站标签写反”的口径：交换有效端点，原始值仍保存在 `observations` 表中。
- 不可改写原观测：普通 SQL/API 不能更新观测端点、距离、方位、倾角或仪高；只能改用户权重，或在 `flip_candidates` 中创建/启停候选。
- 秩亏：无锁定控制点的孤立网报整体 X/Y/Z 平移；无斜距分量报射线长度/相对尺度不可识别。`F-G-H` 的理论秩为 4，9 个坐标参数有 5 个不可识别自由度：3 个平移 + 2 个尺度。

## 页面操作

- 锁定或解锁控制点。
- 修改某次观测权重；权重为 0 表示该观测行不参与正规方程。
- 启用或停用既有翻转候选，也可为任意观测新增候选。
- 查看站点图、最小独立闭合环、往返校差、正规方程诊断、秩亏模式、95% 误差椭球、逐行残差和“观测修正 = −残差”。
- 每次操作都会保存一条运行记录，包含锁、权重、启用候选快照和完整结果。

## HTTP API

- `GET /api/state`：当前站点、观测、候选和平差结果。
- `POST /api/adjust`：重新平差并写入运行记录。
- `POST /api/stations/lock`：请求体 `{ "station_id": "B", "locked": true }`。
- `POST /api/observations/weight`：请求体 `{ "observation_id": "obs-ab-1", "weight": 2 }`。
- `POST /api/flips/toggle`：请求体 `{ "candidate_id": "flip-da-1", "active": true }`。
- `POST /api/flips`：为指定 `observation_id` 创建并默认启用翻转候选。
- `GET /api/runs`：列出全部运行记录。
- `GET /api/export`：导出固定 fixture 与全部运行记录的 JSON 包。
- `POST /api/reset`：清空数据库并重新导入内置 fixture。
- `POST /api/import`：请求体 `{ "fixture": {...} }`，重建数据库后立即平差复核。

## 清空、导出与重放

在页面点击“导出运行记录”可下载 JSON。清空数据库可使用页面“清空并重导”，或：

```bash
curl -X POST http://127.0.0.1:5535/api/reset
```

用导出包复核时，将导出 JSON 中 `fixture` 字段提交给 `/api/import`；页面“导入复核”文件选择器同时接受完整导出包或单独 fixture。导入会重建表并生成一条新的平差运行记录。

## 开发命令

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build          # TypeScript 严格类型检查，不产出运行文件
corepack pnpm test -- --run  # Node 内置 test runner 自动化测试
corepack pnpm dev --host 127.0.0.1 --port 5535
```

## 项目结构

- `src/adjustment.ts`：观测模型、环基、平差、协方差、秩亏模式。
- `src/graph.ts`：多图、逻辑边、往返证据、候选生效视图。
- `src/matrix.ts`：矩阵乘法、对称矩阵特征分解和 Moore–Penrose 伪逆。
- `src/db.ts` / `src/repository.ts`：SQLite schema、fixture 导入、不可变触发器和运行记录。
- `src/server.ts`：本地 HTTP API 与静态文件服务。
- `public/`：Canvas 操作页面。
- `test/`：固定 fixture、翻转、重名站点、秩亏、SQLite 触发器和 HTTP 冒烟测试。
