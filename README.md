# IELTS Vocab Hub

面向中文学习者的本地 IELTS 词汇工作台，提供英汉/汉英查词、词形回退、个人词库、复习、听写、学习笔记和可选的自带 API AI 功能。

## 功能

- Cambridge 与 ECDICT 中文释义优先的智能查词
- 复数、时态、进行式、比较级和最高级的安全原形回退
- 多义项、例句、发音、同义替换和词汇分级
- FSRS 复习、听写训练、个人笔记和数据导入导出
- API 密钥与个人学习数据仅存放在本地运行目录，不进入仓库

## 本地运行

需要 Python 3。分别启动后端和静态页面：

```bash
python3 proxy.py
```

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

然后访问 <http://127.0.0.1:8080/>。也可以运行：

```bash
./start.sh
```

## 测试

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node tests/performance-ui.test.js
node tests/markdown.test.js
```

`tests/notes-ui.test.js` 需要本机安装 Playwright。

## 数据与许可

仓库包含应用运行所需的只读 ECDICT 词库快照。来源版本与校验信息见 `data/catalog-manifest.json`，第三方许可见 `THIRD_PARTY_NOTICES.md` 和 `vendor/licenses/`。

个人词库、对话、设置、API 配置、浏览器测试输出及运行数据库均被 `.gitignore` 排除。
