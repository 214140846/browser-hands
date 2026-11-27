# find-ai 模块规格

负责：`find` 的可选小模型。用户在设置页配置了接口地址和密钥才启用；默认关闭，关闭时 `find` 完全走本地打分（`server/find-local.ts`）。实现文件 `extension/find-ai.js`，由 `dispatch` 的 `find_ai` 方法委托。

## 1. 接线

MCP 服务端的 `find` 先读页（`read_page`，`filter: 'all'`），再向插件发 `find_ai`，参数 `{ query, pageContent }`。插件回 `{ enabled: false }` 则服务端走本地；回 `{ enabled: true, text }` 则 `text` 就是最终文字。失败由插件抛带 `code` 的错误，服务端原样作为错误结果。密钥只在插件里：不发给服务端、不进日志和任何输出。

## 2. 配置（`chrome.storage.local`，不同步）

| 键 | 含义 |
|---|---|
| `findAiBaseUrl` | 接口地址 |
| `findAiKey` | 密钥 |
| `findAiModel` | 模型名，空则 `jev` |

启用条件：地址和密钥去空白后都非空。设置页（`options.html` / `options.js`）：密钥是密码框，已保存时不回显，只在 placeholder 提示「已保存」，留空保存不改；显示状态 On / Off；「Clear and turn off」删掉三个键。

## 3. 请求（两种格式，按模型名区分）

模型名含 `jev`（不分大小写，缺省 `jev` 即是）→ Jev 格式；其他名字 → OpenAI 格式。

**Jev 格式**：Jev 只做选择题（`POST {baseUrl}/systemone`），不生成文本。代码先按查询词在元素行里的重合数排序，取前 20 个带 `[ref_N]` 的行（查询词按空白切词，汉字另按单字计）；对每个候选问一道 `yes`/`no` 选择题（体 `{ model, state: { query, candidates }, questions }`）；`choice` 为 `yes` 且概率（有则看）≥0.5 的算匹配。输出走第 4 节的同一套格式化（无描述列）。`find_no_match` 的文字（含模型自己的 `ERROR` 说明）里出现的密钥同样换成 `***`。没有候选则不发请求，直接 `find_no_match`。

**OpenAI 格式**：

`POST {baseUrl 去末尾 /}/chat/completions`，头 `Authorization: Bearer <key>`，体 `{ model, max_tokens: 800, messages: [一条 user] }`，取 `choices[0].message.content`。超时 30 秒。

## 4. 解析与输出

模型按 `FOUND` / `SHOWING` / `---` / `ref | role | name | type | 理由` / `MORE` / `ERROR` 的格式输出。解析：整体 trim、按行 trim、丢空行；`FOUND:` 取整数（失败记 0）；`ERROR:` 取说明；`MORE:` 置 more；含 `|` 且以 `ref_` 开头（允许 `f<N>:` 的框架前缀）的行按 `|` 拆段，段数 ≥ 4 且 ref 出现在页面树的 `[ref_N]` 标记里才收，其余丢弃（防编造）。

输出：total 为 0 或无有效行 → 错误 `find_no_match`，文字为 `ERROR` 说明，缺省 `No matching elements found`。否则 `Found <total> matching element(s)`，more 时追加 ` (showing first <接受行数>, use a more specific query to narrow results)`；空一行后每元素一行 `- ref: role "name" (type) - description`（空字段省略）。

## 5. 错误

启用但请求失败（网络、非 2xx、响应无文本、超时）：错误码 `find_exception`，文字 `Failed to find element: <原因>`；不静默退回本地。原因里出现的密钥一律换成 `***`。

## 6. 导出

`DEFAULT_MODEL`、`REQUEST_TIMEOUT_MS`、`MAX_RESULTS`、`STORAGE_KEYS`、`isEnabled(cfg)`、`loadConfig(storage?)`、`buildPrompt(query, tree)`、`parseModelOutput(text, tree)`、`formatOutput(parsed)`、`askModel(cfg, prompt, fetch?)`、`isJevModel(model)`、`JEV_MAX_CANDIDATES`、`pickCandidates(query, tree)`、`askJev(cfg, query, tree, fetch?)`、`findAi(params, deps?)`；`deps` 可注入 `storage` 和 `fetch`（测试用）。测试：`test/unit/find-ai.test.ts`、`test/unit/mcp.test.ts` 的 `find` 一节。
