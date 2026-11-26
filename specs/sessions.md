# sessions 模块规格

负责：会话 ↔ 标签的归属。每个 MCP 会话有一个主标签和一组「本会话的标签」；工具只能操作本会话的标签。所有建组 / 入组动作排进一个串行队列。

## 1. 两种模式

| 模式 | 何时 | 「本会话的标签」怎么认 |
|---|---|---|
| 组模式 | 浏览器有 `chrome.tabGroups`，且 `browserKind()` 不是 `'arc'` | 会话一个标签组，组里的标签都算 |
| 清单模式 | 没有 `chrome.tabGroups`，或 `browserKind()` 为 `'arc'` | 会话自己记 `tabIds`，只有清单里还开着的标签算；**不调用任何 `chrome.tabGroups` / `chrome.tabs.group`** |

Arc 走清单模式的原因：Arc 有 `chrome.tabGroups`，但 `chrome.tabs.group()` 永不返回，组模式会让整个串行队列卡死。

一个会话一旦进入清单模式（有了 `tabIds`）就一直是清单模式。

## 2. 冻结的导出签名

| 导出 | 参数 | 返回 |
|---|---|---|
| `beginCall` | `sessionId: string` | `Promise<session>`：保证主标签存在（组模式还保证组存在） |
| `endCall` | `session` | `void` |
| `listTabs` | `session` | `Promise<Tab[]>`：本会话的标签 |
| `joinGroup` | `session, tabId: number` | `Promise<unknown>`：组模式入组；清单模式记进 `tabIds` |
| `admit` | `session, tabId: number` | `Promise<void>`：不属于本会话时 reject，`code: 'tab_outside_group'` |
| `tracksTabIds` | `session` | `boolean`：是否清单模式 |
| `setTask` | `session, name: string` | `Promise<void>`：设任务名并刷新标题 |
| `resolveTabId`、`closeSession`、`listSessions`、`sessionClosedHooks` | 不变 | 不变 |

## 3. 清单模式行为

| 情形 | 结果 |
|---|---|
| 新会话第一次 `beginCall` | 在最近聚焦的普通窗口开一个 `about:blank`（不激活）当主标签，`tabIds = [主标签]` |
| `joinGroup(s, t)` | `t` 追加进 `tabIds`（不重复） |
| `admit(s, t)`，`t` 在 `tabIds` 里且还开着 | 放行 |
| `admit(s, t)`，`t` 不在清单里（哪怕它也不在任何组里） | reject `tab_outside_group`，报错里列出可用 tabId |
| `listTabs` | 只返回 `tabIds` 里还开着的标签；**不能**按 `groupId: -1` 查（会把用户所有无组标签都算进来） |
| 会话里的标签打开了新标签（`openerTabId` 在 `tabIds` 里） | 新标签自动并入 |
| 清单里的标签被关 | 从 `tabIds` 划掉 |
| 主标签被关、清单里还有别的 | 改用清单里第一个还开着的 |
| 清单里全关了 | 再开一个 `about:blank` 当主标签 |

## 4. 标签组显示名（组模式的标题）

标题 = `<⌛|✅> <显示名>`，设了任务名则为 `<⌛|✅> <显示名> · <任务名>`。

| 项 | 规则 |
|---|---|
| 内部 key | `sessionId` 不变，形如 `<客户端>-<8位hex>@<目录名>`，随机部分不进标题 |
| 显示名 | 取 key 里 `-<8位hex>@` 之后的目录名；key 里没有这段（旧格式）就用整个 key |
| 重名 | 只在新会话创建时判断：已有存活会话显示名相同，后来的加 `·2`、`·3`…（取最小的空位）；会话关闭后名字释放。选这个而不是随机后缀，是因为短、可读、无需存额外状态 |
| 任务名 | `setTask(session, name)`，来自 `tabs_context_mcp` 的 `session_name`；空白合并、首尾去空、最长 40 字；空串清除；变更后立即刷新标题并存盘 |
| 用户手改组名 | 仍按原有逻辑改回 `titleOf` 的结果（含任务名） |

清单模式没有标签组，显示名 / 任务名只记在会话里（状态小窗用 `name`）。
