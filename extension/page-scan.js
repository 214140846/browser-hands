// page-scan：注入网页的「页内工具箱」（经典脚本，不是 ES 模块）。
// 挂到 window.__jevScan 上 8 个函数；重复注入时什么都不做，已发的编号继续有效。
;(function () {
  if (window.__jevScan) return

  // ---------- 编号表：编号 → 弱引用，元素 → 编号 ----------
  const refOfEl = new WeakMap()
  const elOfRef = new Map()
  let lastRef = 0

  function refFor(el) {
    let n = refOfEl.get(el)
    if (!n) {
      n = ++lastRef
      refOfEl.set(el, n)
      elOfRef.set(n, new WeakRef(el))
    }
    return 'ref_' + n
  }

  // 失效（没发过 / 已回收 / 脱离文档）返回 null
  function elFor(ref) {
    const m = /^ref_([1-9]\d*)$/.exec(String(ref))
    if (!m) return null
    const n = Number(m[1])
    const w = elOfRef.get(n)
    if (!w) return null
    const el = w.deref()
    if (!el) {
      elOfRef.delete(n)
      return null
    }
    return el.isConnected ? el : null
  }

  // ---------- 通用小工具 ----------
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const tagOf = (el) => el.tagName.toLowerCase()
  const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight })
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title'])
  const NATIVE_INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'])
  const LANDMARKS = new Set(['article', 'aside', 'footer', 'header', 'main', 'nav', 'section'])
  const SENSITIVE_TOKENS = new Set([
    'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-number',
    'current-password', 'new-password', 'one-time-code',
  ])
  // 按内容取名的「可点选条目」角色
  const CONTENT_NAMED_ROLES = new Set([
    'button', 'link', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'treeitem', 'switch', 'heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'tooltip',
  ])
  const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'hidden', 'range', 'color'])
  const EDITABLE_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

  const inputType = (el) => (el.getAttribute('type') || 'text').toLowerCase()

  function isSensitive(el) {
    const t = tagOf(el)
    if (t !== 'input' && t !== 'select' && t !== 'textarea') return false
    if (t === 'input') {
      const ty = inputType(el)
      if (ty === 'password' || ty === 'hidden') return true
    }
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/)
    return ac.some((tok) => SENSITIVE_TOKENS.has(tok))
  }

  // 展平后的子元素：shadow root 替换宿主子节点，slot 换成分配进来的元素
  function kidsOf(el) {
    if (el.shadowRoot) return Array.from(el.shadowRoot.children)
    if (tagOf(el) === 'slot') {
      const got = el.assignedElements()
      return got.length ? got : Array.from(el.children)
    }
    return Array.from(el.children)
  }

  // 穿过 shadow 边界的父元素
  function upOf(el) {
    if (el.parentElement) return el.parentElement
    const root = el.getRootNode()
    return root && root.host ? root.host : null
  }

  // 「可交互」标记（不含手形起点）
  function isMarkedInteractive(el) {
    if (NATIVE_INTERACTIVE.has(tagOf(el))) return true
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true
    const role = el.getAttribute('role')
    if (role === 'button' || role === 'link') return true
    return el.getAttribute('contenteditable') === 'true'
  }

  // 手形起点：自己 cursor:pointer，父级不是
  function isPointerOrigin(el, style) {
    if (style.cursor !== 'pointer') return false
    const up = upOf(el)
    if (!up) return true
    return getComputedStyle(up).cursor !== 'pointer'
  }

  const looksHidden = (st) => st.visibility === 'hidden' || st.visibility === 'collapse' || st.opacity === '0'

  function offscreen(el) {
    const r = el.getBoundingClientRect()
    return r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth
  }

  // ---------- 角色 ----------
  const TAG_ROLE = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'image', nav: 'navigation',
    main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', article: 'article',
    section: 'region', form: 'form', dialog: 'dialog', option: 'option', summary: 'button', details: 'group',
    table: 'table', progress: 'progressbar', meter: 'meter', fieldset: 'group', output: 'status',
  }

  function roleOf(el) {
    const attr = el.getAttribute('role')
    if (attr) return attr
    const t = tagOf(el)
    if (t === 'input') {
      const ty = inputType(el)
      if (ty === 'checkbox' || ty === 'radio') return ty
      if (ty === 'submit' || ty === 'button' || ty === 'file' || ty === 'reset' || ty === 'image') return 'button'
      if (ty === 'range') return 'slider'
      return 'textbox'
    }
    if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (/^h[1-6]$/.test(t)) return 'heading'
    if (t === 'select' && el.multiple) return 'listbox'
    return TAG_ROLE[t] || 'generic'
  }

  // ---------- 名字 ----------
  function labelForText(el) {
    if (!el.id) return ''
    const root = el.getRootNode()
    if (!root || !root.querySelector) return ''
    const lab = root.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    return lab ? squash(lab.innerText || lab.textContent) : ''
  }

  const visibleText = (el) => squash(el.innerText) || squash(el.textContent)

  // 按「先看能不能拿到明确声明的名字，再按元素种类取」的顺序挑来源
  function rawName(el, role, interactive) {
    const aria = squash(el.getAttribute('aria-label'))
    const t = tagOf(el)
    if (isSensitive(el)) return aria || squash(el.getAttribute('title')) || labelForText(el)
    if (t === 'select') {
      if (aria) return aria
      const opt = el.selectedOptions && el.selectedOptions[0]
      return opt ? squash(opt.text) : ''
    }
    if (aria) return aria
    const sources = []
    if (t === 'input' || t === 'textarea') sources.push(el.getAttribute('placeholder'), el.getAttribute('title'))
    if (t === 'img') sources.push(el.getAttribute('alt'))
    for (const s of sources) if (squash(s)) return squash(s)
    const lab = labelForText(el)
    if (lab) return lab
    if (t === 'input') {
      const ty = inputType(el)
      if ((ty === 'submit' || ty === 'button' || ty === 'reset') && el.value) return squash(el.value)
      if (!NON_TEXT_INPUTS.has(ty)) {
        const v = squash(el.value)
        if (v && v.length <= 40) return v
      }
      return ''
    }
    if (t === 'textarea') return ''
    if (t === 'button' || t === 'a' || t === 'summary' || CONTENT_NAMED_ROLES.has(role)) return visibleText(el)
    if (interactive) return visibleText(el)
    return ''
  }

  function clip(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s
  }

  // ---------- scan ----------
  const DEFAULT_DEPTH = 15
  const MAX_NODES = 10000
  const oneLine = (v) => String(v).replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')

  function scan(opts) {
    const o = opts || {}
    const viewport = viewportSize()
    try {
      const interactiveOnly = o.filter === 'interactive'
      const depth = o.depth == null ? DEFAULT_DEPTH : Number(o.depth)
      let root = document.body
      if (o.refId != null) {
        root = elFor(o.refId)
        if (!root) return { error: 'Element ref is stale or unknown: ' + o.refId, errorCode: 'ref_stale', pageContent: '', viewport }
      }
      const lines = []
      const compactRows = []
      const st = { count: 0, full: false, depthHit: false }
      const focused = o.refId != null

      // 把一个元素写成一行（以及下拉的选项行）
      const emit = (el, level, role, name, marked) => {
        const ref = refFor(el)
        let line = ' '.repeat(level) + role
        if (name) line += ' "' + oneLine(clip(name, 100)) + '"'
        line += ' [' + ref + ']'
        for (const k of ['href', 'type', 'placeholder']) {
          if (el.hasAttribute(k)) line += ' ' + k + '="' + oneLine(el.getAttribute(k)) + '"'
        }
        lines.push(line)
        st.count++
        if (marked) compactRows.push(ref + ' ' + role + (name ? ' "' + oneLine(clip(name, 100)) + '"' : ''))
        if (tagOf(el) === 'select' && !isSensitive(el)) {
          const pad = ' '.repeat(level + 1)
          for (const op of Array.from(el.options)) {
            const txt = squash(op.text)
            let row = pad + 'option "' + oneLine(txt) + '"'
            if (op.value !== txt) row += ' value="' + oneLine(op.value) + '"'
            if (op.selected) row += ' (selected)'
            lines.push(row)
          }
        }
      }

      const visit = (el, level, forceRoot) => {
        if (SKIP_TAGS.has(tagOf(el))) return
        let style = null
        if (interactiveOnly) {
          style = getComputedStyle(el)
          if (style.display === 'none' && !forceRoot) return
        }
        const marked = isMarkedInteractive(el)
        const role = roleOf(el)
        let take
        if (forceRoot) take = true
        else if (interactiveOnly) {
          take = !looksHidden(style) && el.getAttribute('aria-hidden') !== 'true' &&
            (marked || isPointerOrigin(el, style)) && (focused || !offscreen(el))
        } else {
          take = marked || el.hasAttribute('role') || role === 'heading' || LANDMARKS.has(tagOf(el)) ||
            (role !== 'generic' && role !== 'image')
        }
        let name = ''
        if (take || !interactiveOnly) name = rawName(el, role, marked || (interactiveOnly && take))
        if (!take && !interactiveOnly && name) take = true
        let next = level
        if (take) {
          if (st.count >= MAX_NODES) { st.full = true; return }
          if (level > depth) { st.depthHit = true; return }
          emit(el, level, role, name, marked)
          next = level + 1
          if (tagOf(el) === 'select') return
        }
        for (const kid of kidsOf(el)) {
          if (st.full) return
          visit(kid, next, false)
        }
      }

      if (root) {
        if (focused) visit(root, 0, true)
        else for (const kid of kidsOf(root)) visit(kid, 0, false)
      }
      if (st.full) lines.push('(Output truncated at ' + MAX_NODES + ' elements; pass ref_id or a smaller depth to narrow the scan.)')
      if (st.depthHit) lines.push('(Depth limit ' + depth + ' reached; deeper elements omitted. Pass ref_id of a deep element or a larger depth.)')

      let pageContent = lines.join('\n')
      const max = o.maxChars == null ? null : Number(o.maxChars)
      if (max != null && pageContent.length > max) {
        let cut = pageContent.lastIndexOf('\n', max)
        const head = cut < 0 ? pageContent.slice(0, max) : pageContent.slice(0, cut)
        pageContent = head + '\n(Output truncated at ' + max + ' characters. Use ref_id to focus on a subtree, or a larger max_chars, to see more.)'
      }
      const res = { pageContent, viewport }
      if (o.compact) res.compact = compactRows.join('\n')
      return res
    } catch (e) {
      return { error: 'Scan failed: ' + (e && e.message), errorCode: 'injected_script_failed', pageContent: '', viewport }
    }
  }

  // ---------- pageText ----------
  function tidyText(s) {
    return String(s || '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function pageText(maxChars) {
    const base = { title: document.title, url: location.href }
    try {
      const richest = (list) => {
        let best = null
        let bestLen = -1
        for (const el of list) {
          const len = tidyText(el.innerText).length
          if (len > bestLen) { best = el; bestLen = len }
        }
        return best
      }
      let pick = null
      let source = 'body'
      const groups = [
        ['article', document.querySelectorAll('article')],
        ['main', document.querySelectorAll('main')],
        [null, document.querySelectorAll('[role="main"]')],
      ]
      for (const [label, list] of groups) {
        if (list.length) {
          pick = richest(list)
          source = label || tagOf(pick)
          break
        }
      }
      if (!pick) pick = document.body
      let text = tidyText(pick ? pick.innerText : '')
      if (text.length < 10) {
        return { text: '', source: 'none', ...base, error: 'Page has almost no readable text; take a screenshot instead.' }
      }
      const max = Number(maxChars)
      if (Number.isFinite(max) && text.length > max) {
        const cut = text.lastIndexOf('\n', max)
        const head = cut < 0 ? text.slice(0, max) : text.slice(0, cut)
        text = head + '\n[Text truncated at ' + max + ' characters.]'
      }
      return { text, source, ...base }
    } catch (e) {
      return { text: '', source: 'none', ...base, error: 'Reading page text failed: ' + (e && e.message) }
    }
  }

  // ---------- locate ----------
  function locate(ref) {
    const el = elFor(ref)
    if (!el) return { success: false, errorCode: 'ref_stale', error: 'Element ref is stale or unknown: ' + ref }
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      return { success: true, coordinates: [r.left + r.width / 2, r.top + r.height / 2] }
    } catch (e) {
      return { success: false, errorCode: 'injected_script_failed', error: 'Locate failed: ' + (e && e.message) }
    }
  }

  // ---------- scrollFallback ----------
  function canScroll(el, dx, dy) {
    const st = getComputedStyle(el)
    const open = (v) => v === 'auto' || v === 'scroll'
    const y = open(st.overflowY) && el.scrollHeight > el.clientHeight
    const x = open(st.overflowX) && el.scrollWidth > el.clientWidth
    return (dy ? y : false) || (dx ? x : false) || ((y || x) && !dx && !dy)
  }

  function scrollFallback(x, y, dx, dy) {
    try {
      let el = document.elementFromPoint(x, y)
      while (el && el !== document.body && el !== document.documentElement) {
        if (canScroll(el, dx, dy)) {
          el.scrollBy({ left: dx, top: dy, behavior: 'instant' })
          return true
        }
        el = upOf(el)
      }
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    } catch (e) {
      try { window.scrollBy(dx, dy) } catch (_) {}
    }
    return true
  }

  // ---------- formInput ----------
  const protoSetter = (proto, key) => Object.getOwnPropertyDescriptor(proto, key).set
  const SELECTABLE = new Set(['text', 'search', 'url', 'tel', 'password'])
  const DATE_LIKE = new Set(['date', 'time', 'datetime-local', 'month', 'week'])
  const fail = (errorCode, error) => ({ error, errorCode })

  function fireInputChange(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function writeValue(el, v) {
    const proto = tagOf(el) === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    protoSetter(proto, 'value').call(el, v)
  }

  // 每类控件一个处理器：返回结果对象
  const fillers = {
    select(el, value, secret) {
      const want = String(value)
      const opts = Array.from(el.options)
      let idx = opts.findIndex((op) => op.value === want)
      if (idx < 0) idx = opts.findIndex((op) => squash(op.text) === squash(want))
      if (idx < 0) {
        if (secret) return fail('input_invalid', 'No matching option in this select.')
        const list = opts.slice(0, 20).map((op) => JSON.stringify(squash(op.text))).join(', ')
        return fail('input_invalid', 'No option matches ' + JSON.stringify(want) + '. Options: ' + list)
      }
      el.focus()
      protoSetter(HTMLSelectElement.prototype, 'selectedIndex').call(el, idx)
      fireInputChange(el)
      return { output: secret ? 'Selected an option.' : 'Selected option ' + JSON.stringify(squash(opts[idx].text)) }
    },
    toggle(el, value, kind) {
      let target
      if (kind === 'checkbox') {
        if (typeof value !== 'boolean') return fail('input_invalid', 'Checkbox value must be a boolean.')
        target = value
      } else {
        if (value === false) return fail('input_invalid', 'A radio cannot be unchecked; select another radio in the group.')
        target = true
      }
      el.focus()
      if (el.checked !== target) el.click()
      if (el.checked !== target) return fail('input_invalid', 'The page prevented changing the ' + kind + '.')
      return { output: kind + (target ? ' checked' : ' unchecked') }
    },
    numeric(el, value, kind) {
      const s = value === '' ? '' : String(value)
      if (s === '' ? kind === 'range' : Number.isNaN(Number(s))) return fail('input_invalid', 'Value is not a number.')
      el.focus()
      writeValue(el, s)
      if (s !== '' && el.value === '') return fail('input_invalid', 'The browser rejected the value.')
      fireInputChange(el)
      return { output: 'Set ' + kind + ' to ' + el.value }
    },
    dated(el, value, kind) {
      const s = String(value)
      el.focus()
      writeValue(el, s)
      if (s !== '' && el.value === '') return fail('input_invalid', 'The browser rejected the ' + kind + ' value; check the format.')
      fireInputChange(el)
      return { output: 'Set ' + kind + ' to ' + JSON.stringify(el.value) }
    },
    text(el, value, secret, kind) {
      const s = String(value)
      el.focus()
      writeValue(el, s)
      if (kind === 'textarea' || SELECTABLE.has(kind)) {
        try { el.setSelectionRange(s.length, s.length) } catch (_) {}
      }
      fireInputChange(el)
      return { output: secret ? 'Filled the sensitive field.' : 'Set value to ' + JSON.stringify(s) }
    },
  }

  function formInput(ref, value) {
    const el = elFor(ref)
    if (!el) return fail('ref_stale', 'Element ref is stale or unknown: ' + ref)
    try {
      const t = tagOf(el)
      if (t !== 'input' && t !== 'select' && t !== 'textarea') return fail('element_unsupported', 'Only input, select and textarea can be filled.')
      if (el.disabled || (t !== 'select' && el.readOnly)) return fail('element_not_editable', 'The control is disabled or read-only.')
      const secret = isSensitive(el)
      if (t === 'select') return fillers.select(el, value, secret)
      const kind = t === 'textarea' ? 'textarea' : inputType(el)
      if (kind === 'checkbox' || kind === 'radio') return fillers.toggle(el, value, kind)
      if (kind === 'number' || kind === 'range') return fillers.numeric(el, value, kind)
      if (DATE_LIKE.has(kind)) return fillers.dated(el, value, kind)
      if (kind === 'file') return fail('element_unsupported', 'Use file upload for file inputs.')
      return fillers.text(el, value, secret, kind)
    } catch (e) {
      return fail('injected_script_failed', 'The page threw while filling: ' + (e && e.message))
    }
  }

  // ---------- 文件 ----------
  function makeFiles(specs) {
    return (specs || []).map((f) => {
      const bin = atob(f.data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new File([bytes], f.name, { type: f.mimeType || 'application/octet-stream' })
    })
  }

  function putFiles(input, files) {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(f)
    input.files = dt.files
  }

  const isFileInput = (el) => tagOf(el) === 'input' && inputType(el) === 'file'
  const names = (files) => files.map((f) => f.name).join(', ')

  function uploadFiles(ref, specs) {
    const el = elFor(ref)
    if (!el) return fail('ref_stale', 'Element ref is stale or unknown: ' + ref)
    if (!isFileInput(el)) return fail('element_unsupported', 'Element is not a file input.')
    try {
      const files = makeFiles(specs)
      putFiles(el, files)
      fireInputChange(el)
      return { output: 'Attached ' + files.length + ' file(s): ' + names(files) }
    } catch (e) {
      return fail('injected_script_failed', 'Attaching files failed: ' + (e && e.message))
    }
  }

  function dropFiles(x, y, specs, shown) {
    const sx = Math.round((shown && shown[0]) ?? x)
    const sy = Math.round((shown && shown[1]) ?? y)
    try {
      const files = makeFiles(specs)
      let target = document.elementFromPoint(x, y)
      if (!target) return { error: 'No element at (' + sx + ', ' + sy + ').' }
      let cx = x
      let cy = y
      if (tagOf(target) === 'iframe') {
        let doc = null
        try { doc = target.contentDocument } catch (_) {}
        if (doc) {
          const r = target.getBoundingClientRect()
          const inner = doc.elementFromPoint(x - r.left, y - r.top)
          if (inner) { target = inner; cx = x - r.left; cy = y - r.top }
        }
      }
      if (isFileInput(target)) {
        putFiles(target, files)
        target.dispatchEvent(new Event('change', { bubbles: true }))
        target.dispatchEvent(new Event('input', { bubbles: true }))
        return { output: 'Put ' + names(files) + ' into the file input at (' + sx + ', ' + sy + ').' }
      }
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, dataTransfer: dt }))
      }
      return { output: 'Dropped ' + names(files) + ' at (' + sx + ', ' + sy + ').' }
    } catch (e) {
      return { error: 'Drop failed: ' + (e && e.message) }
    }
  }

  // ---------- observe ----------
  function waitQuiet(quietMs, capMs) {
    return new Promise((resolve) => {
      let quietTimer = null
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(quietTimer)
        clearTimeout(capTimer)
        mo.disconnect()
        resolve(true)
      }
      const arm = () => {
        clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, quietMs)
      }
      const mo = new MutationObserver(arm)
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      const capTimer = setTimeout(finish, capMs)
      arm()
    })
  }

  function describe(el, role, secret) {
    const t = tagOf(el)
    const label = clip(squash(rawName(el, role, true)), 120).slice(0, 120) || role
    const item = { ref: refFor(el), role, label, inView: true }
    const ty = t === 'input' ? inputType(el) : ''
    if ((t === 'input' && !NON_TEXT_INPUTS.has(ty)) || t === 'textarea') {
      if (!secret) {
        const v = squash(el.value).slice(0, 200)
        if (v && v !== label) item.value = v
      }
    }
    if (ty === 'checkbox' || ty === 'radio') item.checked = String(el.checked)
    for (const k of ['checked', 'selected', 'expanded']) {
      const a = el.getAttribute('aria-' + k)
      if (a !== null) item[k] = a
    }
    if (t === 'a' && el.hasAttribute('href')) {
      let h = el.href
      try {
        const u = new URL(el.href)
        h = u.origin === location.origin ? u.pathname + u.search : u.href
      } catch (_) {}
      item.href = h.slice(0, 100)
    }
    if (t === 'select') {
      item.options = secret ? [] : Array.from(el.options).slice(0, 60).map((op, i) => ({
        i, label: squash(op.text).slice(0, 60), value: op.value, selected: op.selected, disabled: op.disabled,
      }))
    }
    const editable = t === 'textarea' || (t === 'input' && EDITABLE_INPUTS.has(ty)) || el.getAttribute('contenteditable') === 'true'
    if (editable) {
      item.editable = true
      const raw = el.getAttribute('type')
      if (raw !== null && raw.toLowerCase() !== 'text' && raw.toLowerCase() !== 'search') item.inputType = raw
    }
    return item
  }

  function collectObservable(max) {
    const picked = []
    let omitted = 0
    const stack = [document.body]
    // 栈式先序遍历，逆序压栈保持文档顺序
    while (stack.length) {
      const el = stack.pop()
      if (!el || SKIP_TAGS.has(tagOf(el))) continue
      const st = getComputedStyle(el)
      if (st.display === 'none') continue
      if (el !== document.body) {
        const r = el.getBoundingClientRect()
        const ok = (isMarkedInteractive(el) || isPointerOrigin(el, st)) &&
          el.getAttribute('aria-hidden') !== 'true' && !looksHidden(st) &&
          r.width > 0 && r.height > 0 && !offscreen(el) &&
          !el.matches(':disabled') && !el.closest('[aria-disabled="true"]')
        if (ok) {
          if (picked.length < max) picked.push(el)
          else omitted++
        }
      }
      const kids = kidsOf(el)
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
    return { picked, omitted }
  }

  async function observe(opts) {
    const o = opts || {}
    const max = o.max ?? 240
    const quietMs = o.quietMs ?? 120
    const capMs = o.capMs ?? 500
    const textChars = o.textChars ?? 6000
    try {
      await waitQuiet(quietMs, capMs)
      const { picked, omitted } = collectObservable(max)
      const items = picked.map((el) => ({ el, d: describe(el, roleOf(el), isSensitive(el)) }))
      // 去重：外层与里面某个被采集元素同名时丢外层；可编辑与下拉不丢
      const keep = items.filter((outer) => {
        if (outer.d.editable || tagOf(outer.el) === 'select') return true
        return !items.some((inner) => inner !== outer && outer.el.contains(inner.el) && inner.d.label === outer.d.label)
      })
      const de = document.documentElement
      const y = window.scrollY
      return {
        url: location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        scroll: { y: Math.round(y), height: de.scrollHeight, canDown: y + window.innerHeight < de.scrollHeight - 2, canUp: y > 0 },
        canGoBack: history.length > 1,
        text: squash(document.body ? document.body.innerText : '').slice(0, textChars),
        elements: keep.map((x) => x.d),
        omitted,
      }
    } catch (e) {
      return {
        url: location.href, title: document.title, viewport: { w: window.innerWidth, h: window.innerHeight },
        scroll: { y: 0, height: 0, canDown: false, canUp: false }, canGoBack: false, text: '', elements: [], omitted: 0,
        error: 'Observe failed: ' + (e && e.message),
      }
    }
  }

  window.__jevScan = { scan, pageText, locate, scrollFallback, formInput, observe, uploadFiles, dropFiles }
})()
