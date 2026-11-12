// 注入网页的「操作指示器」：边缘光晕 + Stop 按钮 + 点击前的瞄准光标。
// 经典脚本（无 import / export），运行在扩展隔离世界；全部内容放进封闭 shadow root，与页面互不可见。
// 对外只挂 window.__jevIndicator 的 5 个函数。
(() => {
  if (window.__jevIndicator) return // 重复注入：保持原对象不动

  // ---- 自定视觉常量 ----
  const TEAL = '#19c3a6' // 光晕与光标主色（青绿）
  const INDIGO = '#3d3fd6' // Stop 按钮底色（靛蓝）
  const DWELL_MS = 1200 // 光标停留时长，之后淡出

  // 样式用可构造样式表：不会被页面 CSP 的 style-src 拦掉
  const CSS = `
    .glow { position: fixed; inset: 0; pointer-events: none; box-sizing: border-box;
      border: 2px solid ${TEAL};
      box-shadow: inset 0 0 22px 4px rgba(25,195,166,.55), inset 0 0 70px rgba(61,63,214,.22);
      animation: breathe 2.4s ease-in-out infinite; }
    @keyframes breathe { 0%,100% { opacity: .65 } 50% { opacity: 1 } }
    .stop { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
      pointer-events: auto; cursor: pointer; font: 600 14px/1 system-ui, sans-serif; letter-spacing: .04em;
      color: #fff; background: ${INDIGO}; border: 2px solid #fff; border-radius: 999px;
      padding: 11px 26px; box-shadow: 0 4px 16px rgba(20,20,80,.45), 0 0 0 3px ${TEAL}; margin: 0; }
    .stop:hover { background: #2b2db8 }
    .stop.away { visibility: hidden; pointer-events: none; }
    .reticle { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      pointer-events: none; opacity: 0; }
  `

  let host = null // 宿主元素
  let root = null // 封闭 shadow root
  let glow = null
  let stopBtn = null
  let reticle = null
  let ring = null // 光标外扩的脉冲圈
  let yielded = false // Stop 是否因光标让位而收起
  let cursorOn = false
  let timer = 0
  let lastCenter = null

  const svg = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    return e
  }

  // 保证宿主存在且挂在文档上；文档没有根元素时返回 false
  const ensureHost = () => {
    const parent = document.documentElement
    if (!parent) return false
    if (!host) {
      host = document.createElement('jev-indicator-host')
      const s = host.style
      s.setProperty('all', 'initial', 'important')
      s.setProperty('position', 'fixed', 'important')
      s.setProperty('inset', '0', 'important')
      s.setProperty('pointer-events', 'none', 'important')
      s.setProperty('z-index', '2147483647', 'important')
      root = host.attachShadow({ mode: 'closed' })
      try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(CSS)
        root.adoptedStyleSheets = [sheet]
      } catch (_) {}
    }
    if (!host.isConnected) parent.appendChild(host)
    return host.isConnected
  }

  const makeStop = () => {
    stopBtn = document.createElement('button')
    stopBtn.className = 'stop'
    stopBtn.type = 'button'
    stopBtn.textContent = '■ Stop'
    stopBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return // 只认真实用户输入
      try {
        Promise.resolve(chrome.runtime.sendMessage({ type: 'STOP' })).catch(() => {})
      } catch (_) {}
    })
    root.appendChild(stopBtn)
  }

  const makeReticle = () => {
    reticle = document.createElement('div')
    reticle.className = 'reticle'
    const g = svg('svg', { width: '44', height: '44', viewBox: '0 0 44 44' })
    // 瞄准镜：深色衬底圈 + 青绿圈 + 四向刻线 + 中心点
    g.appendChild(svg('circle', { cx: 22, cy: 22, r: 11, fill: 'rgba(25,195,166,.14)', stroke: 'rgba(10,20,40,.6)', 'stroke-width': 5 }))
    g.appendChild(svg('circle', { cx: 22, cy: 22, r: 11, fill: 'none', stroke: TEAL, 'stroke-width': 2.5 }))
    for (const d of ['M22 4v9', 'M22 31v9', 'M4 22h9', 'M31 22h9']) {
      g.appendChild(svg('path', { d, stroke: TEAL, 'stroke-width': 2.5, 'stroke-linecap': 'round' }))
    }
    g.appendChild(svg('circle', { cx: 22, cy: 22, r: 2.6, fill: '#fff', stroke: INDIGO, 'stroke-width': 1.5 }))
    ring = svg('circle', { cx: 22, cy: 22, r: 11, fill: 'none', stroke: TEAL, 'stroke-width': 2 })
    ring.style.transformOrigin = '22px 22px'
    g.appendChild(ring)
    reticle.appendChild(g)
    root.appendChild(reticle)
  }

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = 0
  }

  const show = () => {
    try {
      if (!ensureHost()) return true
      if (!glow) {
        glow = document.createElement('div')
        glow.className = 'glow'
        root.appendChild(glow)
      }
      if (!stopBtn) makeStop()
      yielded = false
      stopBtn.classList.remove('away')
      const r = stopBtn.getBoundingClientRect()
      lastCenter = [r.left + r.width / 2, r.top + r.height / 2]
    } catch (_) {}
    return true
  }

  const hide = () => {
    try {
      clearTimer()
      if (host) host.remove()
    } catch (_) {}
    host = root = glow = stopBtn = reticle = ring = null
    yielded = false
    cursorOn = false
    lastCenter = null
    return true
  }

  const moveCursor = (x, y) => {
    try {
      if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return true
      if (!ensureHost()) return true
      // 坐标落在 Stop 矩形内（含边界）：Stop 让位，直到下次 show
      if (stopBtn) {
        const r = stopBtn.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          yielded = true
          stopBtn.classList.add('away')
        }
      }
      if (!reticle) makeReticle()
      clearTimer()
      const pos = `translate(${x}px, ${y}px)`
      if (!cursorOn) {
        // 刚出现：直接落位，不从旧位置滑过来
        reticle.style.transition = 'opacity .1s'
        reticle.style.transform = pos
        void reticle.offsetWidth
      } else {
        reticle.style.transition = 'opacity .1s, transform .16s ease-out'
        reticle.style.transform = pos
      }
      reticle.style.opacity = '1'
      cursorOn = true
      if (ring.animate) ring.animate([{ transform: 'scale(.7)', opacity: 0.9 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 480, easing: 'ease-out' })
      timer = setTimeout(() => {
        timer = 0
        cursorOn = false
        if (reticle) {
          reticle.style.transition = 'opacity .35s'
          reticle.style.opacity = '0'
        }
      }, DWELL_MS)
    } catch (_) {}
    return true
  }

  const state = () => {
    const live = !!host && host.isConnected
    return {
      border: live && !!glow,
      stop: live && !!stopBtn && !yielded,
      cursor: live && cursorOn,
    }
  }

  const stopCenter = () => {
    if (!stopBtn) return null
    try {
      if (host && host.isConnected) {
        const r = stopBtn.getBoundingClientRect()
        lastCenter = [r.left + r.width / 2, r.top + r.height / 2]
      }
    } catch (_) {}
    return lastCenter
  }

  window.__jevIndicator = { show, hide, moveCursor, state, stopCenter }
})()
