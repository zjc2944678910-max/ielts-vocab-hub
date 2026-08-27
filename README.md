# IELTS Vocab Hub

![License](https://img.shields.io/badge/license-MIT-green)

面向中文学习者的**本地优先**雅思词汇工作台：查词、科学复习、听写、口语、笔记与 AI 助教一站搞定。前端零构建、后端零依赖，`clone` 下来一个 Python 3 就能跑，所有学习数据和 API 密钥只存在你自己的机器上。

## 功能亮点

### 🔍 智能查词

- **四级查词链路**：本地词库 → 剑桥词典（英汉）→ Google 翻译 → AI 翻译兜底，自动合并多来源结果并标注来源覆盖。
- 支持英文、短语和**中文反查**（中文查询直接给出多个候选英文表达，点击继续查）。
- **词形回退**：查询复数、时态、比较级等词形时自动回退到原形。
- 查词结果可直接发音、一键收藏进生词本；内置词条编辑抽屉可自定义释义、Band 分级、词性、话题、学习模式（只认识 / 要会写）、标签和个人笔记。
- 顶栏实时显示词典引擎与 API 状态、今日学习进度环和连续学习天数。

### 🧠 科学复习（FSRS 间隔重复）

- 采用 [FSRS](https://github.com/open-spaced-repetition) 间隔重复算法（vendored 官方 py-fsrs v6.3.1，离线可用），按遗忘曲线安排每一步复习。
- 目标记忆率可选 85% / 90% / 95%，难度和节奏随目标自动调整。
- 新词按 10 词一组"看英选中"训练，连续答对 3 次才算记住，带答题计时。
- 到期复习自动混入每日学习，不用自己记复习清单。

### ✍️ 听写与同义替换训练

- **自由听写**：自选出题范围——到期拼写、历史错词、生词本、个人词库或整本词书，可叠加话题和题量过滤。
- **同义替换 Quiz**："选择最合适的学术表达"，专攻雅思写作与阅读的同义替换考点，带连胜计数。

### 🗣️ 口语练习

- 按 Part 1（每题 45 秒）/ Part 2（1 分钟准备 + 2 分钟陈述）/ Part 3（每题 60 秒）真实计时开口练，可打字或口答。
- 提交后即时本地点评（字数区间、要点覆盖、可换表达）；配置了 AI 后可升级为 AI 逐题点评，AI 不可用时自动回退本地。
- 内置多话题题库与本地练习历史。

### 📝 学习笔记

- 多笔记本 + Markdown 笔记，支持标题 / 标签 / 正文搜索。
- 编辑、预览、分屏三视图（分屏宽度可拖动），格式工具栏、KaTeX 数学公式。
- **版本历史**：任意笔记可查看历史版本并恢复。
- 支持导入 Markdown 文件、单篇导出、整库导出 ZIP。
- **AI 助教菜单**：向 AI 提问、总结、整理结构、润色、生成复习提纲，AI 草稿确认后一键应用。

### 🤖 AI 助教（可选）

- 多会话管理（新建 / 重命名 / 删除），SSE 流式回复，可随时停止或重新生成。
- 对话可挂参考笔记：RAG 检索你的笔记并输出引用来源，也支持"临时检索全部笔记"。
- AI 回复可携带**操作卡片**（例如"将 X 加入生词本"），确认后直接执行；回复可复制或保存为笔记。
- 按对话独立选模型，支持跟随全局、免费模型或 DeepSeek。

### 📖 词库

- 仓库自带 **7202 词条**只读开源词库快照（来源 ECDICT 固定 commit，sha256 校验），含 **185 个精选雅思学术词**（音标、Band 分级、话题、搭配、同义反义、考试替换语境、双语例句）和 CET-4 / CET-6 子集。
- 支持按话题、Band（6.5+ ~ 8.0+）、关键词筛选词条，任意词条可加入学习计划。
- 在本机有 Oxford 导出数据时，可用 `scripts/build_private_catalog.py` 生成结构化私有词库（Oxford IELTS / TOEFL / GRE / 考研等），私有库只存本机、绝不进入仓库和公网部署。

### 🔒 本地优先与隐私

- 学习数据、笔记、AI 对话全部存在本机 SQLite，API 密钥存在本机配置文件，不回显、不进备份、不进仓库。
- 发音代理只把当前待播的单词发送给 Google TTS。
- 一键导出 / 导入完整备份 JSON，可预览后合并或替换。

## 快速开始

需要 Python 3，无需安装任何第三方依赖：

```bash
git clone https://github.com/zjc2944678910-max/ielts-vocab-hub.git
cd ielts-vocab-hub
./start.sh          # 一键启动：后端 API + 静态页面 + 自动打开浏览器
```

或手动分别启动：

```bash
python3 proxy.py                              # 后端 API，默认 127.0.0.1:8081
python3 -m http.server 8080 --bind 127.0.0.1  # 静态页面
```

然后访问 <http://127.0.0.1:8080/>。不配置任何 AI Key 也能完整使用查词、复习、听写、口语和笔记功能。

## 架构一览

| 层 | 组成 |
| --- | --- |
| 前端 | 原生 JavaScript 单页应用，零构建、零 npm 依赖 |
| 后端 API | `proxy.py`：Python 3 标准库实现（ThreadingHTTPServer + SQLite），零 pip 依赖 |
| 学习调度 | vendored py-fsrs v6.3.1（FSRS 间隔重复算法），离线可用 |
| 公式渲染 | vendored KaTeX 0.18.4 |
| 词库 | ECDICT 固定 commit 快照（`data/catalog-manifest.json` 记录版本与 sha256） |
| 公网网关 | `public_server.py`：静态白名单 + API 反代 + HMAC 签名访客 Cookie + SSO 头识别 |

## 配置 AI（可选）

在「个人设置 → API 管理」中填入你的 Key 即可启用 AI 能力：

- **OpenRouter 免费智能分流**：只允许价格为 0 的免费模型白名单，按任务类型（翻译 / 词条扩展 / 雅思写作 / 问答 / 笔记助教）自动选择合适的免费模型；Provider 拥堵或超时自动切换下一个免费候选。系统不会启用 `openrouter/auto`，也绝不会自动调用付费模型。
- **DeepSeek**：自填 Base URL / 模型 / Key，可作为独立选择或最终兜底。

配置只保存在本机 `~/.config/ielts-vocab-hub/api.json`，界面和接口均不回显完整 Key。

## 公网部署（可选）

`./start-public.sh` 启动同源网关模式（网关 8090，后端 8091）：

- **访客数据隔离**：每位访客独立数据目录与 API 配置，互不可见。
- **强制开源词库**：公网模式始终使用仓库内开源词库，本机私有 Oxford 库不会被带上网。
- **SSO 支持**：识别 Cloudflare Access（`Cf-Access-*`）与 Authentik（`X-Authentik-*`）身份头，可用环境变量强制邮箱 / 用户白名单。
- 设计运行在 HTTPS 反向代理（如 Cloudflare）之后，自带安全响应头。

## 测试

```bash
python3 -m unittest discover -s tests -p 'test_*.py'   # 后端 7 个测试套件
node tests/markdown.test.js                            # Markdown 渲染
node tests/performance-ui.test.js                      # 前端静态断言
node tests/notes-ui.test.js                            # 需要本机 Playwright (Chromium)
node tests/model-ui.test.js                            # 需要本机 Playwright (Chromium)
```

## 数据与隐私

- 个人学习数据存于 `~/.local/share/ielts-vocab-hub/`，API 配置存于 `~/.config/ielts-vocab-hub/`，均被 `.gitignore` 排除。
- 仓库只包含应用运行所需的只读开源词库快照，来源版本与校验信息见 `data/catalog-manifest.json`。

## 许可证

- 项目代码：[MIT](LICENSE)
- 词库数据：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT，固定 commit，运行数据只含 CET-4 / CET-6 学习子集）
- 复习调度：[py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) v6.3.1（MIT，vendored）
- 公式渲染：[KaTeX](https://github.com/KaTeX/KaTeX) 0.18.4（MIT，vendored）

详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `vendor/licenses/`。
