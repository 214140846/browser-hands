// 页面指示器（注入页面，隔离世界）：四周柔光框 + 顶部状态条（含 Stop）+ 常驻幽灵光标（带弧线轨迹），全放在一个 closed shadow root 里。
// 要点：宿主元素上被页面加的属性每次都清掉、宿主始终挪到 body 末尾；Stop 只认可信点击；
// 截图 / 点击前后台会调 hide / restore 让光框和 Stop 瞬间消失、光标换成素色；光框淡入淡出 300ms，呼吸 2000ms。
// 顶部状态条（标签条模式）：条里有图形、文字、「移到另一边」和 Stop，可在顶部 / 底部手动翻转。
// 不做：静音音频、心跳、静态指示条、打开聊天、悬停原因卡、需要输入悬浮条、涟漪、朗读行。
;(() => {
  if (window.__jevIndicator) return

  // ---- 配色与数值 token（强调色 #D97757，其余自选）----
  const ACCENT = '#D97757' // 辉光、实线内边
  const ACCENT_RGB = '217,119,87'
  const STRIP_BG = '#C4623F' // 条底色：比辉光强调色略深
  const STRIP_TEXT = '#FFFFFF'
  const STRIP_BTN = 'rgba(0,0,0,0.18)' // 条内通用按钮底
  const STRIP_BTN_HOVER = 'rgba(0,0,0,0.28)'
  const STOP_BG = '#1E1C1A' // Stop 近黑底
  const STOP_BG_HOVER = '#3A3733'
  const TIP_BG = '#1E1C1A'
  const SURFACE = '#F4F1EA' // 失败气泡底
  const INK = '#23211E'
  const Z_TOP = 2147483647
  const Z_LOW = 2147483646
  const FADE_MS = 300
  const STOP_ACK_MS = 1500
  const STRIP_H = 47
  const LABEL_TEXT = 'Browser Hands is working in this tab'
  const BUBBLE_TEXT = 'The stop request did not go through. Dismiss the debugging notice or reload this page to stop.'

  const STYLE = `
    :host { all: initial !important; display: contents !important; }
    * { box-sizing: border-box; }
    .edge { position: fixed; inset: 0; pointer-events: none; z-index: ${Z_TOP}; opacity: 0; transition: opacity ${FADE_MS}ms ease-in-out; }
    .glow { position: absolute; inset: 0; opacity: 0.6; animation: breathe 2000ms ease-in-out infinite;
      box-shadow: inset 0 0 22px rgba(${ACCENT_RGB},0.8), inset 0 0 44px rgba(${ACCENT_RGB},0.5), inset 0 0 66px rgba(${ACCENT_RGB},0.25); }
    .edge::after { content: ''; position: absolute; inset: 0; border: 3px solid ${ACCENT}; pointer-events: none; }
    .edge.paused .glow { animation-play-state: paused; }
    .edge.shot { opacity: 0 !important; transition: none !important; }
    @keyframes breathe { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
    .gone { display: none !important; }

    .strip { position: absolute; top: 0; left: 0; right: 0; margin: 0 auto; z-index: 1; width: fit-content; max-width: calc(100vw - 16px); height: ${STRIP_H}px;
      display: flex; align-items: center; gap: 8px; padding: 3px 8px 0 14px; border-radius: 0 0 14px 14px;
      background: ${STRIP_BG}; color: ${STRIP_TEXT}; font: 600 14px/20px system-ui, -apple-system, 'Segoe UI', sans-serif;
      direction: ltr; user-select: none; white-space: nowrap; pointer-events: auto;
      filter: drop-shadow(0 2px 5px rgba(0,0,0,0.22)); }
    .edge.bottom .strip { top: auto; bottom: 0; padding: 0 8px 3px 14px; border-radius: 14px 14px 0 0; filter: drop-shadow(0 -2px 5px rgba(0,0,0,0.22)); }
    .mark { width: 16px; height: 16px; flex: none; display: block; }
    .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .label::before { content: '${LABEL_TEXT}'; }
    .strip button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; flex: none; height: 28px; padding: 0 9px;
      border-radius: 8px; background: ${STRIP_BTN}; color: ${STRIP_TEXT}; font: 500 14px/20px system-ui, -apple-system, 'Segoe UI', sans-serif; cursor: pointer; }
    .strip button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
    .strip .stop { gap: 2px; padding-left: 4px; background: ${STOP_BG}; }
    .strip .stop svg { width: 20px; height: 20px; flex: none; }
    .strip .stop[disabled] { pointer-events: none; opacity: 0; }
    .strip .move { position: relative; width: 24px; height: 24px; padding: 0; margin: 0 -2px 0 -4px; border-radius: 7px; opacity: 0; }
    .strip .move svg { width: 16px; height: 16px; }
    .edge.bottom .move svg { transform: rotate(180deg); }
    .strip:hover .move, .strip:focus-within .move { opacity: 1; }
    .tip { position: absolute; left: 50%; top: 29px; transform: translateX(-50%); display: none; pointer-events: none; padding: 3px 8px; border-radius: 6px;
      background: ${TIP_BG}; color: #fff; font: 400 13px/18px system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
    .edge.bottom .tip { top: auto; bottom: 28px; }
    .move:focus-visible .tip { display: block; }
    @media (hover: hover) {
      .strip button:hover { background: ${STRIP_BTN_HOVER}; }
      .strip .stop:hover { background: ${STOP_BG_HOVER}; }
      .move:hover .tip { display: block; }
    }
    @media (hover: none), (pointer: coarse) {
      .strip button { min-height: 44px; }
      .strip .move { width: 44px; margin: 0; opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) { .glow { animation: none; } .edge { transition: none; } }
    @media print { .edge { display: none !important; } }
    @media (forced-colors: active) {
      .edge::after { border-color: CanvasText; }
      .strip, .tip, .strip button { border: 1px solid CanvasText; }
    }
    .bubble { position: fixed; bottom: 88px; left: 50%; transform: translateX(-50%); pointer-events: none; z-index: ${Z_LOW};
      background: ${SURFACE}; color: ${INK}; font: 500 13px/1.3 system-ui, sans-serif; padding: 8px 14px; border-radius: 18px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.16); opacity: 0; transition: opacity 150ms ease-out; }
    .cursor { position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: ${Z_TOP}; opacity: 0; transition: opacity 120ms ease-out; }
    .cursor.leaving { transition-duration: 200ms; }
    .arrow { position: absolute; left: -3px; top: -2px; width: 22px; height: 22px; transform-origin: 3px 2px; overflow: visible;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.28)); }
    .arrow path { fill: ${ACCENT}; stroke: #fff; stroke-width: 1.5; stroke-linejoin: round; }
    .cursor.plain .arrow path { fill: ${INK}; }
  `

  // ---- 纯函数：移动时长与轨迹（测试通过 plan 直接调用）----
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (10 - 15 * t + 6 * t * t))
  const SEGMENTS = 16

  function durationFor(dist) {
    if (dist < 0.5) return 0
    return Math.round(Math.min(380, Math.max(140, 80 + 70 * Math.log2(dist / 24 + 1))))
  }

  function plan(x0, y0, x1, y1) {
    const dx = x1 - x0
    const dy = y1 - y0
    const dist = Math.max(Math.hypot(dx, dy), 1e-6)
    const T = durationFor(Math.hypot(dx, dy))
    const over = Math.min(0.03 * dist, 4)
    const bow = (0.8 * dx - 0.6 * dy > 0 ? -1 : 1) * Math.min(0.1 * dist, 30)
    const points = []
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS
      const pull = over * smooth((s - 0.66) / 0.34)
      const c = ((dist + over) * smooth(s / 0.8) - pull) / dist
      const side = (bow * Math.sin(Math.PI * Math.min(1, Math.max(0, c)))) / dist
      points.push([x0 + dx * c - dy * side, y0 + dy * c + dx * side])
    }
    points[SEGMENTS] = [x1, y1] // 终点精确落在目标
    const leans = points.map((_, i) => {
      if (i === 0 || i === SEGMENTS) return 0
      const a = points[i - 1]
      const b = points[i + 1]
      const v = (((b[0] - a[0]) - (b[1] - a[1])) * (Math.SQRT2 / 2) * SEGMENTS) / (2 * T)
      return 9 * Math.tanh(v / 1.8)
    })
    return { T, points, leans }
  }

  // ---- 状态 ----
  let hostEl = null
  let shadow = null
  let edgeEl = null
  let stripEl = null
  let stopBtn = null
  let moveBtn = null
  let tipEl = null
  let bubbleEl = null
  let cursorEl = null
  let arrowEl = null
  let leaving = false // 正在淡出（300ms 后移除）
  let captured = false // 截图 / 点击期间：光框和条不透明度置 0（仍在 DOM 里）
  let side = 'top' // 条当前在哪一边
  let removeTimer = null
  let bubbleTimer = null
  let moveAnim = null
  let leanAnim = null
  let cursorTarget = null
  let agentPoint = null // 点击类隐藏时 agent 的点击目标
  let hideCount = 0 // 测试观察：隐藏被调用的次数
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  // 每次更新都清掉宿主上被页面加的属性，并保证挪到 body 末尾
  function ensureRoot() {
    if (!hostEl) {
      hostEl = document.createElement('div')
      shadow = hostEl.attachShadow({ mode: 'closed' })
      const sheet = document.createElement('style')
      sheet.textContent = STYLE
      shadow.appendChild(sheet)
    }
    for (const attr of hostEl.getAttributeNames()) hostEl.removeAttribute(attr)
    const mount = document.body || document.documentElement
    if (hostEl.parentNode !== mount || hostEl.nextElementSibling) mount.appendChild(hostEl)
    return shadow
  }

  function el(tag, cls) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    return node
  }

  const STOP_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="4.5" width="11" height="11" rx="3.5" fill="currentColor"/></svg>'
  const MARK = '<svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.75" fill="currentColor"/><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.8"/></svg>'
  const MOVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.5M4 8.75l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const ARROW = '<svg class="arrow" viewBox="0 0 18 18" aria-hidden="true"><path d="M2.4545 1.6364 L15.7 7.6 L9.4 9.4 L7.9 15.6 Z"/></svg>'
  const moveText = () => (side === 'top' ? 'Move to bottom' : 'Move to top')

  // 条内按钮的点击：只认可信点击；agent 自己的点击（坐标 1px 内）忽略
  const isAgentClick = (e) => agentPoint && e instanceof MouseEvent && Math.abs(e.clientX - agentPoint[0]) <= 1 && Math.abs(e.clientY - agentPoint[1]) <= 1

  function makeStrip() {
    stripEl = el('div', 'strip')
    stripEl.setAttribute('role', 'group')
    stripEl.setAttribute('aria-label', LABEL_TEXT)
    stripEl.insertAdjacentHTML('beforeend', MARK)
    stripEl.appendChild(el('span', 'label'))
    moveBtn = el('button', 'move')
    moveBtn.type = 'button'
    moveBtn.innerHTML = MOVE_ICON
    tipEl = el('span', 'tip')
    tipEl.setAttribute('aria-hidden', 'true')
    moveBtn.appendChild(tipEl)
    moveBtn.addEventListener('click', onMoveClick)
    stopBtn = el('button', 'stop')
    stopBtn.type = 'button'
    stopBtn.innerHTML = `${STOP_ICON}<span>Stop</span>`
    stopBtn.addEventListener('click', onStopClick)
    stripEl.append(moveBtn, stopBtn)
    // 条上终止事件冒泡，按下时阻止默认行为（不抢页面焦点）
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'contextmenu', 'touchstart']) {
      stripEl.addEventListener(t, (e) => {
        e.stopPropagation()
        if (t === 'pointerdown' || t === 'mousedown') e.preventDefault()
      })
    }
    applySide()
    return stripEl
  }

  function applySide() {
    edgeEl?.classList.toggle('bottom', side === 'bottom')
    if (moveBtn) {
      moveBtn.setAttribute('aria-label', moveText())
      tipEl.textContent = moveText()
    }
  }

  function onMoveClick(e) {
    if (!e.isTrusted || captured || isAgentClick(e)) return
    side = side === 'top' ? 'bottom' : 'top'
    applySide()
    chrome.runtime.sendMessage({ type: 'STRIP_MOVED', side }).catch(() => {})
  }

  function onStopClick(e) {
    if (!e.isTrusted) return // 页面脚本伪造的点击无效
    if (isAgentClick(e)) return // agent 自己正在点：坐标各差不超过 1px，不算用户点 Stop
    chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {})
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      if (!edgeEl || leaving) return // 已被撤掉就说明停止成功
      if (!bubbleEl) shadow.appendChild((bubbleEl = el('div', 'bubble')))
      bubbleEl.textContent = BUBBLE_TEXT
      void bubbleEl.offsetWidth
      bubbleEl.style.opacity = '1'
    }, STOP_ACK_MS)
  }

  // 强制回流后再设终态，保证过渡触发（不依赖 rAF，后台标签也能走）
  function fadeIn() {
    void edgeEl.offsetWidth
    edgeEl.style.opacity = '1'
  }

  function show() {
    clearTimeout(removeTimer)
    const root = ensureRoot()
    leaving = false
    captured = false
    agentPoint = null
    const fresh = !edgeEl
    if (!edgeEl) {
      edgeEl = el('div', 'edge')
      edgeEl.appendChild(el('div', 'glow'))
      edgeEl.appendChild(makeStrip())
      root.appendChild(edgeEl)
      applySide()
    }
    edgeEl.classList.remove('paused', 'gone', 'shot')
    stopBtn.disabled = false
    if (cursorEl) {
      cursorEl.classList.remove('leaving', 'gone')
      cursorEl.style.opacity = '1'
    }
    if (fresh) fadeIn()
    else edgeEl.style.opacity = '1'
    return true
  }

  function removeAll() {
    for (const n of [edgeEl, bubbleEl, cursorEl]) n?.remove()
    moveAnim?.cancel()
    leanAnim?.cancel()
    hostEl?.remove()
    hostEl = shadow = edgeEl = stripEl = stopBtn = moveBtn = tipEl = bubbleEl = cursorEl = arrowEl = moveAnim = leanAnim = cursorTarget = agentPoint = null
    leaving = captured = false
  }

  // 整体隐藏：光框连条 300ms 淡出、光标淡出，300ms 后统一移除（期间被重新显示则不移除）
  function hide() {
    clearTimeout(bubbleTimer)
    bubbleEl?.remove()
    bubbleEl = null
    if (!hostEl) return true
    leaving = true
    clearTimeout(removeTimer)
    if (edgeEl) edgeEl.style.opacity = '0'
    if (cursorEl) {
      cursorEl.classList.add('leaving')
      cursorEl.style.opacity = '0'
    }
    removeTimer = setTimeout(() => leaving && removeAll(), FADE_MS)
    return true
  }

  // 截图 / 点击前：光框连条不透明度立即 0、无过渡（不用 display none，条仍在命中测试里）。point 为点击目标时，落在 Stop 上的点击把按钮设为不可交互。
  function suppress(point) {
    hideCount++
    captured = true
    agentPoint = point || null
    edgeEl?.classList.add('shot', 'paused')
    if (point && stopBtn) {
      const box = stopBtn.getBoundingClientRect()
      if (point[0] >= box.left - 1 && point[0] <= box.right + 1 && point[1] >= box.top - 1) stopBtn.disabled = true
    }
    cursorEl?.classList.add('plain')
    return true
  }

  // 恢复：取消「截图中」标记，由内联不透明度 1 接管，300ms 淡回；只恢复被 suppress 的
  function restore() {
    if (!captured) return true
    captured = false
    agentPoint = null
    if (stopBtn) stopBtn.disabled = false
    if (!leaving) edgeEl?.classList.remove('shot', 'paused')
    cursorEl?.classList.remove('plain')
    return true
  }

  function currentPoint() {
    const box = cursorEl.getBoundingClientRect()
    return [box.left, box.top]
  }

  function ensureCursor() {
    if (cursorEl) return
    cursorEl = el('div', 'cursor')
    cursorEl.innerHTML = ARROW
    arrowEl = cursorEl.firstChild
    shadow.appendChild(cursorEl) // 在光框之后，盖在光框上
  }

  // 光标：常驻到会话结束。首次直接就位；之后从当前实际位置沿弧线走过去。返回落点完成时 resolve 的 promise
  function moveCursor(x, y) {
    x = Math.round(x)
    y = Math.round(y)
    ensureRoot()
    clearTimeout(removeTimer)
    leaving = false
    if (cursorEl && cursorTarget && cursorTarget[0] === x && cursorTarget[1] === y) return Promise.resolve(true)
    const first = !cursorEl
    ensureCursor()
    cursorEl.classList.remove('leaving')
    if (captured) cursorEl.classList.add('plain')
    const place = (px, py) => (cursorEl.style.transform = `translate(${px}px,${py}px)`)
    const finalize = () => {
      place(x, y)
      moveAnim = leanAnim = null
    }
    if (first) {
      const outside = x < 0 || y < 0 || x > innerWidth || y > innerHeight
      const [px, py] = outside ? [Math.min(Math.max(x, 4), innerWidth - 24), Math.min(Math.max(y, 4), innerHeight - 24)] : [x, y]
      place(px, py)
      cursorTarget = [x, y]
      void cursorEl.offsetWidth
      cursorEl.style.opacity = '1'
      return Promise.resolve(true)
    }
    const [x0, y0] = currentPoint()
    moveAnim?.cancel()
    leanAnim?.cancel()
    cursorTarget = [x, y]
    cursorEl.style.opacity = '1'
    const { T, points, leans } = plan(reduced() ? x : x0, reduced() ? y : y0, x, y)
    place(x, y)
    if (T === 0 || reduced()) return Promise.resolve(true)
    moveAnim = cursorEl.animate(points.map(([px, py]) => ({ transform: `translate(${px}px,${py}px)` })), { duration: T, easing: 'linear' })
    leanAnim = arrowEl.animate(leans.map((deg) => ({ transform: `rotate(${deg}deg)` })), { duration: T, easing: 'linear' })
    return new Promise((resolve) => {
      const mine = moveAnim
      const timer = setTimeout(resolve, T + 220, true) // 后台标签动画可能不推进：兜底应答
      const done = () => (clearTimeout(timer), mine === moveAnim && finalize(), resolve(true))
      mine.onfinish = done
      mine.oncancel = () => (clearTimeout(timer), resolve(true))
    })
  }

  // 给测试和后台看状态
  function state() {
    return {
      border: !!edgeEl?.isConnected && !leaving,
      stop: !!stopBtn?.isConnected && !leaving && !captured,
      cursor: !!cursorEl?.isConnected && !leaving && cursorEl.style.opacity === '1',
      captured,
      side,
      hasStop: !!stopBtn?.isConnected,
      hasMove: !!moveBtn?.isConnected,
      stripTop: stripEl ? stripEl.getBoundingClientRect().top : null,
      stripHeight: stripEl ? stripEl.getBoundingClientRect().height : null,
      edgeOpacity: edgeEl ? Number(getComputedStyle(edgeEl).opacity) : null,
      hideCount,
      cursorPos: cursorEl ? currentPoint() : null,
      cursorTarget,
    }
  }

  // 测试用：条内按钮中心（视口像素）
  const center = (b) => {
    if (!b) return null
    const r = b.getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  }
  const stopCenter = () => center(stopBtn)
  const moveCenter = () => center(moveBtn)

  window.__jevIndicator = { show, hide, moveCursor, state, stopCenter, suppress, restore, plan, moveCenter }
})()
