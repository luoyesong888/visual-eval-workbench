# 模型横评工具（改造版）

基于 [magau123/ImageBench](https://github.com/magau123/ImageBench) 改造。
核心流程一句话：**接几个模型 → 发同一个提示词 → 并行跑 → 并排看结果 → 按统一维度打分对比**。

上游是「人工打分」的对比工作台（42 道图像题 + 18 道视频题，你自己点 1–5 分）。
本改造提供了两条路径，首页用哪条由你决定：

| 页面 | 定位 | 打分方式 |
|---|---|---|
| `/`（首页） | 极简横评：一个提示词 + N 个模型 + 一张评分表 | **AI 自动打分**，10 个语义维度 |
| `/advanced` | 上游原版：题库、历史记录、提示词库 | 人工 1–5 分 + VBench/pyiqa 客观指标 |

---

## 快速开始

```bash
# 1. 前端
cd imagebench
npm install
./start.sh          # http://localhost:3000

# 2. 它是两个进程：Next.js(3000) + Python 打分服务(7861)
#    start.sh 会一起拉起来；只要 AI 打分的话，Python 服务可以不起。
```

首页右上角「裁判模型」填一个**支持视觉的** OpenAI 兼容接口即可开始：

```
Base URL   https://api.openai.com/v1        （或百炼/火山/中转站）
模型        gpt-4o / qwen-vl-max / doubao-vision ...
API Key    sk-...
```

然后在模型槽里填各家生图/生视频的 Key，点「开始对比」。

---

## 评测维度

一套维度同时适用于图像和视频。口径取自 GenEval、T2I-CompBench 和 VBench 的公开定义，不是自创。

| 维度 | 判定什么 | 学术对应 | 图 | 视 |
|---|---|---|:--:|:--:|
| 提示词遵循 | 要求的元素是否齐全，有无跑题或多画 | VBench `object_class` / `multiple_objects` | ✓ | ✓ |
| 主体一致性 | 人物/物体长相是否稳定、与描述相符 | VBench `subject_consistency`（DINO 跨帧） | ✓ | ✓ |
| 属性准确 | 颜色、材质、形状是否绑在正确物体上 | T2I-CompBench attribute binding | ✓ | ✓ |
| 数量准确 | 个数对不对 | GenEval counting | ✓ | ✓ |
| 空间站位 | 左右、上下、前后关系是否符合描述 | GenEval position / VBench `spatial_relationship` | ✓ | ✓ |
| 动作关系 | 谁对谁做了什么，交互是否成立 | T2I-CompBench non-spatial relation / VBench `human_action` | ✓ | ✓ |
| 画面质量 | 畸变、模糊、噪点、文字乱码 | VBench `imaging_quality`（MUSIQ） | ✓ | ✓ |
| 美学表现 | 构图、光影、色彩 | VBench `aesthetic_quality`（LAION 预测器） | ✓ | ✓ |
| 运动自然度 | 动作是否流畅，有无僵硬穿模 | VBench `motion_smoothness` / `dynamic_degree` | — | ✓ |
| 时序稳定 | 有无闪烁、抖动、背景乱变 | VBench `temporal_flickering` / `background_consistency` | — | ✓ |

评分范围 1–5 整数。3 = 基本做到但有明显瑕疵，5 = 无可挑剔。

维度定义在 `lib/eval-dims.ts`，每个维度带一段给裁判模型看的评分指引。想加维度或改口径，改这一个文件即可。

---

## AI 打分是怎么做的

```
素材 ─→ 落盘缓存 ─→ 视频抽 6 帧拼图 ─→ 送多模态模型 ─→ 按维度返回 1-5 分 + 评语
```

三个实现细节：

1. **视频抽帧拼图，不逐帧发送。** 按视频时长均匀取 6 帧，用 ffmpeg 拼成 3×2 网格（384px 一格）。送 30 张单帧成本高 5 倍，而多数视觉编码器会把输入降采样，信息量并没有增加。拼图上带时间戳，模型的时序判断更稳。
2. **强制低温度 + 要求 JSON 输出。** 温度 0.1，prompt 里明确「严格评分，3 分是大多数结果的位置」，并给出确切的 JSON schema。解析时做了容错（去掉 ```json 包裹、截取首尾大括号）。
3. **素材按 URL 的 sha1 缓存**在 `.data/`，重跑同一条不会重复下载。厂商返回的视频 URL 约 24 小时过期，缓存顺带解决了这个问题。

### 局限（重要）

- **AI 打分是主观的。** 同一素材重复评分可能相差约 1 分。要稳定结论就多跑几次取平均，或把温度降到 0（多数厂商支持但无法完全消除随机性）。
- **它不等于学术 benchmark。** GenEval 用目标检测器数物体、T2I-CompBench 用 UniDet 算检测框几何关系，是确定性的；而 detectron2/UniDet 在 arm64 macOS 上没有构建，所以这里用视觉语言模型替代。结论方向一致，数值不可直接对标论文。
- **中文提示词下裁判模型可能「理解过头」。** 它对语义的宽容度高于检测器，容易给「大致对」的画面较高分。

---

## 两条打分链路的分工

| | AI 打分（`/api/ai-score`） | 客观指标（`/api/score`） |
|---|---|---|
| 位置 | 首页 | `/advanced` 卡片内 |
| 引擎 | 多模态大模型（需你的 Key） | VBench + pyiqa（本地跑） |
| 擅长 | 语义：画对了没有、位置对不对 | 技术：清晰度、噪声、闪烁、跨帧稳定性 |
| 输出 | 1–5 分 + 每维评语 | 原始数值（0–1 / 0–100，不归一化） |
| 成本 | 按 token 计费 | 本地算力，免费 |
| 可复现 | 有随机性 | 确定性 |

两者不合并成一个总分——量纲不同，合并会伪造精度。

`/api/score` 需要单独起 Python 服务：`cd ../eval-suite && ./bin/evalctl score-server --port 7861`。

---

## 改动清单

```
app/page.tsx                    首页改为极简横评
app/advanced/page.tsx           新增，保留上游题库工作台
components/SimpleBench.tsx      新增，极简横评界面（约 500 行）
app/api/ai-score/route.ts       新增，AI 打分（含 ffmpeg 抽帧）
lib/eval-dims.ts                新增，10 维评测体系

app/api/score/route.ts          新增，客观指标代理（→ Python）
components/VideoWorkbench.tsx   改，卡片内加 VBench 指标 + 提示词库
components/BenchWorkbench.tsx   改，卡片内加 pyiqa 指标 + 提示词库
components/PromptLibrary.tsx    新增，提示词库面板
lib/prompt-library.ts           新增，提示词库读写
lib/db.ts                       新增，统一 IndexedDB 连接（版本 2）
lib/history.ts                  改，改用 lib/db.ts（避免版本冲突）
lib/evaluation.ts               改，GenerationResult 加 objective 等字段
start.sh                        新增，一键起两个服务
```

---

## 验证状态

本机 macOS arm64（Apple Silicon、无 CUDA）实测：

| 项目 | 状态 | 依据 |
|---|---|---|
| 极简页渲染 | ✅ | 图像/视频切换、模型槽增删、裁判设置均正常 |
| 视频抽帧拼图 | ✅ | 3 秒视频 → 6 帧 → 1152×768 拼图，时间戳清晰 |
| AI 打分 - 视频 | ✅ | 10 维全部返回分数与评语，裁判收到 1 张 131KB 拼图 |
| AI 打分 - 图片 | ✅ | 8 维（不含视频专属两项），返回正确 |
| **生成→打分→表格 全流程** | ✅ | 用本地 mock 服务模拟两个模型，两张不同图片入库、分数按维度差异正确渲染、最高分高亮、平均分正确 |
| 缺 Key 的错误提示 | ✅ | 返回「缺少裁判模型 API Key，请在页面右上角填写」 |
| TypeScript | ✅ | `npx tsc --noEmit` 无输出 |
| 真实厂商 API 生成 | ⚠️ 未验证 | 本机没有可用的生图/生视频 Key |
| 视频模式的 UI 渲染 | ⚠️ 未验证 | 视频 provider 只接厂商 API，无法用 mock 替代 |

---

## 已知限制

1. **Next.js 在带沙箱的环境里起不来。** 若 `NODE_OPTIONS` 注入了文件系统 hook，Next 无法操作 `.next/` 目录。`start.sh` 里已清空该变量。
2. **视频厂商 URL 24 小时过期。** 未打分的素材不会被主动下载，过期后卡片里的视频就播不了。打分过的会缓存。
3. **语义维度依赖裁判模型能力。** 换成小模型（如 7B 级视觉模型）后，空间站位、数量这类细粒度判断会明显变差。
4. **`/advanced` 的人工分与 AI 分不互通**，导出报告也分开（首页导 Markdown，`/advanced` 导 Blog）。

---

## 许可

上游 Apache-2.0（源自 `vercel-labs/ai-sdk-image-generator`），本改造沿用同一许可。
上游作者与仓库链接保留在 `README.md`。
