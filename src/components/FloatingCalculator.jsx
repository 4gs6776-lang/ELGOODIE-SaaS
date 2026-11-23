import { useState, useEffect, useRef, useCallback } from 'react'

// =====================================================================
// FloatingCalculator — a professional floating calculator for the Billing
// module. Operations: + − × ÷ % decimal AC backspace ± = . Keyboard
// support (digits, operators, Enter, Escape, Backspace, c for clear).
// Session history. Copy result. Transfer result into a billing field
// via the onTransfer callback. Never modifies an invoice on its own.
//
// Positioning is handled by the parent (Billing.jsx) via the `position`
// and `onPositionChange` props — see useSmartPosition hook. This keeps
// the calculator logic decoupled from layout concerns.
// =====================================================================

const BTN = {
  base: {
    border: '1px solid var(--border, #e2e2e2)',
    background: 'var(--bg-elevated, #fff)',
    color: 'var(--text, #1a1a1a)',
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 600,
    padding: '12px 0',
    cursor: 'pointer',
    transition: 'transform .05s ease, background .12s ease',
    fontFamily: 'var(--font-display, inherit)',
    minHeight: 44,
  },
  op: { background: 'var(--teal, #0d9488)', color: '#fff', borderColor: 'transparent' },
  eq: { background: 'var(--gold, #c8a44a)', color: '#fff', borderColor: 'transparent' },
  fn: { background: 'var(--bg-muted, #f1f1f1)', color: 'var(--muted, #666)' },
  press: { transform: 'scale(0.94)' },
}

// Safe expression evaluator. Supports + − × ÷ % and decimals. Uses the
// shunting-yard approach so we never eval() untrusted input. Percentage
// is treated as a binary operator: "50+10%" → 50 + (50*0.10) = 55, and
// as unary trailing: "10%" of the running total.
function safeEval(expr) {
  if (!expr || !expr.trim()) return { value: 0, ok: true }
  // Tokenize
  const tokens = []
  let buf = ''
  for (let i = 0; i < i + 1; i++) {
    const ch = expr[i]
    if (ch === undefined) break
    if ('0123456789.'.includes(ch)) { buf += ch; continue }
    if (buf) { tokens.push(buf); buf = '' }
    if ('+-×÷%'.includes(ch)) { tokens.push(ch); continue }
    if (ch.trim() === '') continue
    return { value: 0, ok: false }
  }
  if (buf) tokens.push(buf)
  if (tokens.length === 0) return { value: 0, ok: true }

  // Resolve trailing unary % : "10%" → of running total; "50+10%" → percent of left
  const out = []
  const ops = []
  const prec = { '×': 3, '÷': 3, '%': 2, '+': 1, '−': 1 }
  let prev = null
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!'+−×÷%'.includes(t)) {
      out.push(t)
    } else if (t === '%' && prev !== null && !'+−×÷%'.includes(prev)) {
      // binary percent: left % right means left * right/100
      out.push(t)
    } else if (t === '%') {
      // unary trailing percent: convert to /100
      out.push('×'); out.push('0.01')
    } else {
      while (ops.length && prec[ops[ops.length - 1]] >= prec[t]) out.push(ops.pop())
      ops.push(t)
    }
    prev = t
  }
  while (ops.length) out.push(ops.pop())

  // Evaluate postfix
  const st = []
  for (const tk of out) {
    if (!'+−×÷%'.includes(tk)) {
      const n = Number(tk)
      if (Number.isNaN(n)) return { value: 0, ok: false }
      st.push(n)
    } else {
      const b = st.pop()
      const a = st.pop() ?? 0
      let r
      if (tk === '+') r = a + b
      else if (tk === '−') r = a - b
      else if (tk === '×') r = a * b
      else if (tk === '÷') { if (b === 0) return { value: 0, ok: false, div0: true }; r = a / b }
      else if (tk === '%') r = a * b / 100
      else return { value: 0, ok: false }
      st.push(r)
    }
  }
  const v = st[0] ?? 0
  return { value: Math.round(v * 100) / 100, ok: true }
}

export default function FloatingCalculator({
  open,
  onClose,
  position,            // { x, y } in px from viewport top-left
  onPositionChange,   // (newPos) => void
  onTransfer,          // (value:number) => void  — write into active billing field
  transferLabel,       // label for the transfer button, e.g. "→ Amount Paid"
  canTransfer,         // bool — hide transfer button if no target field active
}) {
  const [display, setDisplay] = useState('')
  const [result, setResult] = useState(0)
  const [history, setHistory] = useState([])
  const [justComputed, setJustComputed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [transferred, setTransferred] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const dragOff = useRef({ x: 0, y: 0 })
  const calcRef = useRef(null)

  // Reset state whenever reopened.
  useEffect(() => {
    if (open) { setDisplay(''); setResult(0); setJustComputed(false); setError('') }
  }, [open])

  const pushDigit = useCallback((d) => {
    setError('')
    if (justComputed) { setDisplay(d); setJustComputed(false); return }
    setDisplay(prev => (prev === '0' ? d : prev + d))
  }, [justComputed])

  const pushDot = useCallback(() => {
    setError('')
    if (justComputed) { setDisplay('0.'); setJustComputed(false); return }
    setDisplay(prev => (prev.includes('.') ? prev : (prev || '0') + '.'))
  }, [justComputed])

  const pushOp = useCallback((op) => {
    setError('')
    if (justComputed) { setDisplay(String(result) + op); setJustComputed(false); return }
    setDisplay(prev => {
      if (!prev) return '0' + op
      if ('+−×÷'.includes(prev.slice(-1))) return prev.slice(0, -1) + op
      return prev + op
    })
  }, [justComputed, result])

  const compute = useCallback(() => {
    const { value, ok, div0 } = safeEval(display)
    if (!ok) {
      setError(div0 ? 'Cannot divide by zero' : 'Invalid expression')
      return
    }
    setHistory(h => [{ expr: display, value }, ...h].slice(0, 8))
    setResult(value)
    setDisplay(String(value))
    setJustComputed(true)
  }, [display])

  const clearAll = useCallback(() => {
    setDisplay(''); setResult(0); setJustComputed(false); setError('')
  }, [])

  const backspace = useCallback(() => {
    setError('')
    if (justComputed) { setDisplay(''); setJustComputed(false); return }
    setDisplay(prev => prev.slice(0, -1))
  }, [justComputed])

  const toggleSign = useCallback(() => {
    setDisplay(prev => {
      if (!prev) return '-'
      if (prev.startsWith('-')) return prev.slice(1)
      return '-' + prev
    })
  }, [])

  const applyPercent = useCallback(() => {
    // Treat % as: convert the current operand to its percentage of the
    // running total, mirroring how a physical calculator behaves.
    setError('')
    const { value, ok } = safeEval(display + '%')
    if (!ok) { setError('Invalid expression'); return }
    setResult(value); setDisplay(String(value)); setJustComputed(true)
  }, [display])

  const copyResult = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(String(result))
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea')
      ta.value = String(result); document.body.appendChild(ta)
      ta.select(); try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
      document.body.removeChild(ta)
    }
  }, [result])

  const transfer = useCallback(() => {
    if (!onTransfer) return
    if (result < 0) { setError('Cannot transfer a negative value'); return }
    onTransfer(result)
    setTransferred(true); setTimeout(() => setTransferred(false), 1500)
  }, [result, onTransfer])

  // Keyboard support — only when the calculator is open and no input
  // is focused (so we don't hijack cashier typing into billing fields).
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      const isInput = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable
      if (isInput) return  // let the cashier type into billing fields
      const k = e.key
      if (k >= '0' && k <= '9') { pushDigit(k); e.preventDefault() }
      else if (k === '.') { pushDot(); e.preventDefault() }
      else if (k === '+') { pushOp('+'); e.preventDefault() }
      else if (k === '-') { pushOp('−'); e.preventDefault() }
      else if (k === '*') { pushOp('×'); e.preventDefault() }
      else if (k === '/') { pushOp('÷'); e.preventDefault() }
      else if (k === '%') { applyPercent(); e.preventDefault() }
      else if (k === 'Enter') { compute(); e.preventDefault() }
      else if (k === '=') { compute(); e.preventDefault() }
      else if (k === 'Backspace') { backspace(); e.preventDefault() }
      else if (k === 'Escape') { onClose(); e.preventDefault() }
      else if (k === 'c' || k === 'C') { clearAll(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pushDigit, pushDot, pushOp, applyPercent, compute, backspace, clearAll, onClose])

  // ----- Dragging (pointer events; works for mouse + touch) -----
  const onPointerDownHeader = (e) => {
    if (e.button !== undefined && e.button !== 0) return
    setDragging(true)
    const rect = calcRef.current?.getBoundingClientRect()
    dragOff.current = { x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0) }
    e.preventDefault()
  }
  useEffect(() => {
    if (!dragging) return
    const onMove = (e) => {
      const vw = window.innerWidth, vh = window.innerHeight
      const w = calcRef.current?.offsetWidth || 300
      const h = calcRef.current?.offsetHeight || 420
      let x = e.clientX - dragOff.current.x
      let y = e.clientY - dragOff.current.y
      // Clamp so the calculator never leaves the viewport.
      x = Math.max(8, Math.min(x, vw - w - 8))
      y = Math.max(8, Math.min(y, vh - h - 8))
      onPositionChange?.({ x, y })
    }
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, onPositionChange])

  if (!open) return null

  const dispVal = display === '' ? '0' : display

  return (
    <div
      ref={calcRef}
      role="dialog"
      aria-label="Calculator"
      style={{
        position: 'fixed',
        left: position?.x ?? 40,
        top: position?.y ?? 80,
        width: 300,
        zIndex: 9000,  // below blocking modals (10000+) but above page content
        background: 'var(--bg-elevated, #fff)',
        border: '1px solid var(--border, #e2e2e2)',
        borderRadius: 14,
        boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Header (drag handle) */}
      <div
        onPointerDown={onPointerDownHeader}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', cursor: dragging ? 'grabbing' : 'grab',
          background: 'var(--bg-muted, #f7f7f7)',
          borderBottom: '1px solid var(--border, #e2e2e2)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted, #666)', letterSpacing: 0.3 }}>
          ⠿ CALCULATOR
        </span>
        <button
          onClick={onClose}
          aria-label="Close calculator"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--muted, #666)', lineHeight: 1 }}
        >✕</button>
      </div>

      {/* Display */}
      <div style={{ padding: '14px 14px 6px' }}>
        <div style={{
          fontSize: 12, color: 'var(--muted, #888)', minHeight: 16,
          fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all',
          textAlign: 'right', opacity: 0.85,
        }}>{dispVal}</div>
        <div style={{
          fontSize: 30, fontWeight: 700, textAlign: 'right',
          color: error ? '#c0392b' : 'var(--text, #1a1a1a)',
          fontFamily: 'var(--font-display, inherit)',
          lineHeight: 1.1, wordBreak: 'break-all',
        }}>
          {error ? error : formatNum(result)}
        </div>
      </div>

      {/* Transfer / copy row */}
      <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px' }}>
        <button
          onClick={copyResult}
          style={{ flex: 1, padding: '6px 0', fontSize: 11.5, fontWeight: 600, borderRadius: 8,
            border: '1px solid var(--border, #e2e2e2)', background: copied ? 'var(--teal, #0d9488)' : 'var(--bg-muted, #f1f1f1)',
            color: copied ? '#fff' : 'var(--text, #333)', cursor: 'pointer' }}
        >{copied ? '✓ Copied' : '⧉ Copy'}</button>
        {canTransfer && onTransfer && (
          <button
            onClick={transfer}
            style={{ flex: 1.6, padding: '6px 0', fontSize: 11.5, fontWeight: 700, borderRadius: 8,
              border: '1px solid transparent', background: transferred ? 'var(--gold, #c8a44a)' : 'var(--gold-soft, #f0e3c0)',
              color: transferred ? '#fff' : 'var(--text, #333)', cursor: 'pointer' }}
            title={transferLabel || 'Transfer result into the active billing field'}
          >{transferred ? '✓ Transferred' : (transferLabel || '→ Transfer')}</button>
        )}
      </div>

      {/* Keypad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, padding: 12 }}>
        <KeypadBtn label="AC" onClick={clearAll} style={BTN.fn} />
        <KeypadBtn label="±" onClick={toggleSign} style={BTN.fn} />
        <KeypadBtn label="%" onClick={applyPercent} style={BTN.fn} />
        <KeypadBtn label="÷" onClick={() => pushOp('÷')} style={BTN.op} />

        <KeypadBtn label="7" onClick={() => pushDigit('7')} />
        <KeypadBtn label="8" onClick={() => pushDigit('8')} />
        <KeypadBtn label="9" onClick={() => pushDigit('9')} />
        <KeypadBtn label="×" onClick={() => pushOp('×')} style={BTN.op} />

        <KeypadBtn label="4" onClick={() => pushDigit('4')} />
        <KeypadBtn label="5" onClick={() => pushDigit('5')} />
        <KeypadBtn label="6" onClick={() => pushDigit('6')} />
        <KeypadBtn label="−" onClick={() => pushOp('−')} style={BTN.op} />

        <KeypadBtn label="1" onClick={() => pushDigit('1')} />
        <KeypadBtn label="2" onClick={() => pushDigit('2')} />
        <KeypadBtn label="3" onClick={() => pushDigit('3')} />
        <KeypadBtn label="+" onClick={() => pushOp('+')} style={BTN.op} />

        <KeypadBtn label="0" onClick={() => pushDigit('0')} style={{ gridColumn: 'span 2' }} />
        <KeypadBtn label="." onClick={pushDot} />
        <KeypadBtn label="=" onClick={compute} style={BTN.eq} />
      </div>

      {/* Backspace + history */}
      <div style={{ padding: '0 12px 10px' }}>
        <button onClick={backspace} style={{ width: '100%', padding: '8px 0', fontSize: 13, fontWeight: 600,
          borderRadius: 8, border: '1px solid var(--border, #e2e2e2)', background: 'var(--bg-muted, #f1f1f1)',
          color: 'var(--muted, #555)', cursor: 'pointer' }}>⌫ Backspace</button>
        {history.length > 0 && (
          <div style={{ marginTop: 8, maxHeight: 92, overflowY: 'auto' }}>
            {history.map((h, i) => (
              <button key={i} onClick={() => { setDisplay(h.expr); setResult(h.value); setJustComputed(false) }}
                style={{ width: '100%', textAlign: 'right', padding: '4px 8px', fontSize: 11,
                  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted, #888)',
                  fontFamily: 'var(--font-mono, monospace)', borderBottom: '1px solid var(--border, #f0f0f0)' }}>
                <span style={{ opacity: 0.7 }}>{h.expr} =</span> <b style={{ color: 'var(--text, #333)' }}>{formatNum(h.value)}</b>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function KeypadBtn({ label, onClick, style }) {
  const [pressed, setPressed] = useState(false)
  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onClick={onClick}
      style={{ ...BTN.base, ...style, ...(pressed ? BTN.press : null) }}
    >{label}</button>
  )
}

function formatNum(n) {
  const v = Number(n || 0)
  if (Number.isInteger(v)) return String(v)
  return v.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}
