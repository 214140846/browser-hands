// 中止相关的三个小工具：统一的「已停止」错误、可停点检查、可被信号打断的等待。

// 造一个新的「已停止」错误；code 是对外接口词，message 不含错误码
export const stoppedError = () => {
  const err = new Error('Stopped by user')
  err.code = 'stopped'
  return err
}

// 已中止就同步抛 stopped（不抛 reason）；无信号或未中止则什么都不做
export const checkAbort = (signal) => {
  if (signal && signal.aborted) throw stoppedError()
}

// 可被信号打断的等待：成功时 resolve(undefined)；中止时清计时器并以 stopped 拒绝
export const abortableSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(stoppedError())
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      reject(stoppedError())
    }
    timer = setTimeout(() => {
      // 正常结束：摘掉监听，避免长寿信号上积累
      signal?.removeEventListener('abort', onAbort)
      resolve(undefined)
    }, ms)
    // 监听 once：触发后自动摘除；订阅在返回前同步完成
    signal?.addEventListener('abort', onAbort, { once: true })
  })
