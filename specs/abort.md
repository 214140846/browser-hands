# abort 模块规格

用户在浏览器里点 Stop 时，正在执行的那次工具调用要尽快停下。调用方为每次调用准备一个标准 `AbortSignal`，一路传给各个动作。本模块只提供三样小工具：造一个统一的「已停止」错误、在可停的点检查信号、一个能被信号打断的等待。

## 1. 冻结的导出签名

| 导出 | 形态 | 参数 | 返回 |
|---|---|---|---|
| `stoppedError` | 同步函数 | 无 | `Error`，额外带 `code: 'stopped'` |
| `checkAbort` | 同步函数 | `signal?: AbortSignal \| null` | `undefined`；已中止时抛错 |
| `abortableSleep` | 同步返回 Promise 的函数 | `ms: number`，`signal?: AbortSignal \| null` | `Promise<undefined>`；已中止时见第 2 节 |

只有这三个导出，不多不少。

## 2. 可观察行为

### stoppedError

- 每次调用返回一个**新的** `Error` 实例（两次调用得到的不是同一个对象）。
- `code` 字段恒为字符串 `stopped`（对外错误码，属接口）。
- `message` 是非空字符串，内容自定，测试不断言。对外展示时上层会把 `code` 拼在 message 前，所以 message 不需要再包含错误码。
- 除 `code` 外不要求其他附加字段。

### checkAbort

| 输入情形 | 可观察结果 |
|---|---|
| 不传 / `undefined` / `null` | 正常返回 `undefined` |
| 未中止的 `AbortSignal` | 正常返回 `undefined` |
| 已中止的 `AbortSignal`（不论 `abort()` 时传没传 reason、传了什么） | 同步抛出一个与 `stoppedError()` 同形的错误：`Error` 实例、`code` 为 `stopped`；不会抛出 reason 本身 |
| 传入的不是 `AbortSignal`（普通对象、数字等） | 未定义行为，调用方不得依赖 |

### abortableSleep

| 输入情形 | 可观察结果 |
|---|---|
| 不传信号，或信号始终未中止 | 约 `ms` 毫秒后以 `undefined` 成功；不会早于 `ms` 完成（计时器自身误差除外） |
| `ms` 为 0 | 尽快成功（不早于当前同步代码执行完） |
| 调用时信号已中止 | 以 stopped 错误失败，不等计时；形态可以是「调用时同步抛出」或「返回已拒绝的 Promise」，两者等价——调用方总在 async 里 `await` 它 |
| 等待中信号被中止 | 中止后立即以 stopped 错误失败（不等原定时长走完），与 `abort(reason)` 的 reason 无关 |
| 已成功之后信号才被中止 | 没有任何效果，不产生未处理的拒绝 |
| 同一信号上并行多次等待，然后中止 | 每一次等待都各自以 stopped 错误失败 |
| `ms` 为负数、`NaN` 等非正常数值 | 按 0 处理（与标准 `setTimeout` 的取整规则一致） |

资源要求：
- 计时只用全局 `setTimeout` / `clearTimeout`（测试靠替换它们观察计时器）。因中止而失败后，本次调用创建过的计时器一个都不残留（全部已清掉）。
- 订阅信号只用标准事件接口（测试靠计数观察）。调用返回之前对中止的响应就已生效：调用后同步触发中止，返回的 Promise 也会以中止失败。等待正常结束后，信号上不留本次的监听，长寿信号上不会越积越多。
- 单位：毫秒。

## 3. 依赖表

无同目录依赖，不 import 任何模块。只用到平台自带的 `Error`、`Promise`、`setTimeout` / `clearTimeout`、`AbortSignal` 的事件接口。

## 4. 导入时副作用

无。导入不挂任何监听、不读写全局状态。

## 5. 常量来由

- 错误码 `stopped`：对外接口词，服务端据此判定「用户主动停止」并把任务状态记为停止，与其他失败区分开。
- 本模块无数值常量；等待时长全由调用方传入。

## 6. 边界清单

- `checkAbort(undefined)`、`checkAbort(null)` 都不抛。
- 已中止信号上调用 `abortableSleep`，不论 `ms` 多大都立即失败。
- `abort('任意原因')` 或 `abort(new Error(...))` 后得到的仍是 stopped 错误，不是原因对象。
- 等待结束后再中止信号，不抛、不拒绝、不报未处理异常。
- 测试不断言的：错误 message 文案（自定）。
