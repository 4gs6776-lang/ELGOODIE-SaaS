import { useState } from 'react'
import { Ring, AnimatedNumber, Skeleton, nf, money } from './widgets'

// Top board of the hospital overview: bed cards, activity bars, revenue
// line, completion gauge, weekly visits and activity by role. Every card
// reads data already loaded by useHospitalDashboard and only shows when
// the user's role has access to that data.

const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : 0
  const v = Number(x?.v ?? x?.value ?? x?.count ?? x?.n ?? x?.total ?? 0)
  return Number.isFinite(v) ? v : 0
}
const tail = (series, n) => (Array.isArray(series) ? series : []).slice(-n).map(num)
const sum = (a) => a.reduce((s, v) => s + v, 0)
const daysBack = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 864e5))
const weekday = (dt) => dt.toLocaleDateString(undefined, { weekday: 'short' })
const monthDay = (dt) => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function Icon({ name }) {
  const p = {
    bed: 'M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 15h18M7 9V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2',
    users: 'M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1a3 3 0 0 0-2.5-3M15.5 5.2a3 3 0 0 1 0 5.6',
  }[name]
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={p} />
    </svg>
  )
}

function Card({ index, className = '', children }) {
  return (
    <section className={`hd-card pb-card hd-in ${className}`} style={{ '--i': index }}>
      {children}
    </section>
  )
}

function Head({ title, sub, right }) {
  return (
    <header className="pb-head">
      <div><h3 className="pb-title">{title}</h3>{sub ? <p className="pb-sub">{sub}</p> : null}</div>
      {right}
    </header>
  )
}

/* ---- beds hero (or registered patients when the role has no beds) ---- */
function BedsHero({ d, ready }) {
  const total = d.bedsTotal || 0
  const occ = Math.min(d.bedsOccupied || 0, total)
  const cells = Math.min(total, 24)
  const filled = total ? Math.round((occ / total) * cells) : 0
  let foot = 'No beds set up yet'
  if (total > 0) foot = `${d.bedsAvailable} free${d.bedsCleaning ? ` · ${d.bedsCleaning} cleaning` : ''}`
  return (
    <Card index={1} className="pb-hero">
      <header className="pb-head">
        <span className="pb-label">Number of beds</span>
        <span className="pb-badge"><Icon name="bed" /></span>
      </header>
      <div className="pb-hero-body">
        <div>
          <span className="pb-sub">Total capacity</span>
          <strong className="pb-big">{ready ? <AnimatedNumber value={total} ready={ready} /> : <Skeleton w={90} h={36} />}</strong>
        </div>
        <div className="pb-bedgrid" aria-hidden="true">
          {Array.from({ length: cells }, (_, i) => <i key={i} className={i < filled ? 'on' : ''} />)}
        </div>
      </div>
      <p className="pb-foot">{ready ? foot : <Skeleton w="60%" h={10} />}</p>
    </Card>
  )
}

function PatientsHero({ d, ready }) {
  return (
    <Card index={1} className="pb-hero">
      <header className="pb-head">
        <span className="pb-label">Registered patients</span>
        <span className="pb-badge"><Icon name="users" /></span>
      </header>
      <div className="pb-hero-body">
        <div>
          <span className="pb-sub">All time</span>
          <strong className="pb-big">{ready ? <AnimatedNumber value={d.totalPatients || 0} ready={ready} /> : <Skeleton w={90} h={36} />}</strong>
        </div>
      </div>
      <p className="pb-foot">{ready ? `${d.registeredToday || 0} registered today` : <Skeleton w="60%" h={10} />}</p>
    </Card>
  )
}

/* ---- bed occupancy ---- */
function Occupancy({ d, c, ready }) {
  const pct = ready && Number.isFinite(d.occupancyPct) ? d.occupancyPct : null
  return (
    <Card index={2}>
      <Head title="Bed occupancy" />
      <div className="pb-occ">
        <Ring pct={pct} colorA={c.cyan} colorB={c.purple}>
          <b>{pct === null ? '—' : `${pct}%`}</b>
          <span>occupied</span>
        </Ring>
        <div className="pb-vbar" role="img" aria-label={pct === null ? 'No beds' : `${pct} percent of beds occupied`}>
          <i style={{ height: `${pct || 0}%` }} />
        </div>
      </div>
      <p className="pb-foot">
        {!ready ? <Skeleton w="70%" h={10} /> : d.bedsTotal > 0 ? `${d.bedsOccupied} of ${d.bedsTotal} beds in use` : 'No beds set up yet'}
      </p>
    </Card>
  )
}

/* ---- registered patients with a 28-day dot grid ---- */
function Patients({ d, ready }) {
  const raw = tail(d.registrationSeries, 28)
  const cells = [...Array(Math.max(0, 28 - raw.length)).fill(0), ...raw]
  const max = Math.max(1, ...cells)
  return (
    <Card index={3}>
      <Head title="Registered patients" />
      <div className="pb-patients">
        <div>
          <span className="pb-sub">Total registered</span>
          <strong className="pb-mid">{ready ? <AnimatedNumber value={d.totalPatients || 0} ready={ready} /> : <Skeleton w={70} h={28} />}</strong>
        </div>
        <div className="pb-dots" aria-hidden="true">
          {cells.map((v, i) => <i key={i} style={{ '--o': v ? 0.28 + 0.72 * (v / max) : 0.1 }} />)}
        </div>
      </div>
      <p className="pb-foot">{ready ? `${sum(raw)} new in the last ${raw.length || 28} days · ${d.registeredToday || 0} today` : <Skeleton w="60%" h={10} />}</p>
    </Card>
  )
}

/* ---- weekly activity bars ---- */
function Activity({ d, access, ready }) {
  const options = [
    access.patients && { key: 'patients', label: 'Patients', data: d.registrationSeries },
    access.appointments && { key: 'appointments', label: 'Appointments', data: d.apptSeries },
    access.triage && { key: 'triage', label: 'Triage', data: d.triageSeries },
  ].filter(Boolean)
  const [pick, setPick] = useState(options[0]?.key)
  const active = options.find((o) => o.key === pick) || options[0]
  const values = tail(active.data, 7)
  const days = daysBack(values.length || 7)
  const max = Math.max(1, ...values)
  const top = values.indexOf(Math.max(...values))
  return (
    <Card index={4}>
      <Head
        title="Patient activity"
        sub={`Last ${values.length || 7} days`}
        right={options.length > 1 ? (
          <div className="hd-seg" role="group" aria-label="Activity measure">
            {options.map((o) => <button key={o.key} type="button" className={o.key === active.key ? 'on' : ''} onClick={() => setPick(o.key)}>{o.label}</button>)}
          </div>
        ) : null}
      />
      {!ready ? <Skeleton h={190} /> : (
        <div className="pb-bars" role="img" aria-label={`${active.label} per day, last ${values.length} days`}>
          {values.map((v, i) => {
            const show = i === top || i === values.length - 1
            return (
              <div key={i} className={`pb-bar ${i === top && v > 0 ? 'max' : ''}`}>
                <em style={{ visibility: show && v > 0 ? 'visible' : 'hidden' }}>{nf.format(v)}</em>
                <div className="pb-track"><i style={{ height: `${Math.max(4, (v / max) * 100)}%` }} /></div>
                <span>{weekday(days[i])}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

/* ---- smooth line chart ---- */
function smooth(pts) {
  if (pts.length < 2) return ''
  let out = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2
    const t = 0.18
    out += ` C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`
  }
  return out
}

function Trend({ d, access, ready }) {
  const money$ = !!access.finance
  const values = tail(money$ ? d.revenueSeries : d.apptSeries, 14)
  const days = daysBack(values.length || 14)
  const W = 480, H = 320, pl = 10, pr = 10, pt = 38, pb = 24
  const max = Math.max(1, ...values) * 1.1
  const n = values.length
  const pts = values.map((v, i) => [pl + (n < 2 ? 0 : (i * (W - pl - pr)) / (n - 1)), pt + (1 - v / max) * (H - pt - pb)])
  const line = smooth(pts)
  const peak = n ? values.indexOf(Math.max(...values)) : -1
  const fmt = (v) => (money$ ? money(v) : nf.format(v))
  const tipW = 92
  const tipX = peak >= 0 ? Math.min(W - tipW / 2 - 4, Math.max(tipW / 2 + 4, pts[peak][0])) : 0
  return (
    <Card index={5}>
      <Head title={money$ ? 'Revenue' : 'Appointments'} sub={`${money$ ? 'Collected' : 'Booked'}, last ${n || 14} days`} />
      {!ready ? <Skeleton h={260} /> : n < 2 ? <p className="hd-empty">Not enough data yet.</p> : (
        <div className="pb-trend">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${money$ ? 'Revenue' : 'Appointments'} trend, last ${n} days`}>
            <defs>
              <linearGradient id="pb-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: 'var(--hd-cyan)', stopOpacity: 0.32 }} />
                <stop offset="1" style={{ stopColor: 'var(--hd-cyan)', stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            {[0, 1, 2, 3].map((g) => {
              const y = pt + (g / 3) * (H - pt - pb)
              return <line key={g} x1={pl} x2={W - pr} y1={y} y2={y} className="pb-grid" />
            })}
            <path d={`${line} L${pts[n - 1][0]},${H - pb} L${pts[0][0]},${H - pb} Z`} fill="url(#pb-trend-fill)" />
            <path d={line} className="pb-line" />
            {peak >= 0 && (
              <g>
                <line x1={pts[peak][0]} x2={pts[peak][0]} y1={pts[peak][1]} y2={H - pb} className="pb-peakline" />
                <circle cx={pts[peak][0]} cy={pts[peak][1]} r="5" className="pb-dot" />
                <rect x={tipX - tipW / 2} y={Math.max(2, pts[peak][1] - 34)} width={tipW} height="24" rx="12" className="pb-tip" />
                <text x={tipX} y={Math.max(2, pts[peak][1] - 34) + 16} textAnchor="middle" className="pb-tiptext">{fmt(values[peak])}</text>
              </g>
            )}
            {[0, Math.floor((n - 1) / 2), n - 1].map((i, k) => (
              <text key={k} x={pts[i][0]} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} className="pb-axis">{monthDay(days[i])}</text>
            ))}
          </svg>
          <p className="pb-total"><strong>{fmt(sum(values))}</strong><span>{money$ ? 'total collected' : 'total booked'}</span></p>
        </div>
      )}
    </Card>
  )
}

/* ---- appointment completion gauge ---- */
function Gauge({ d, ready }) {
  const done = d.apptCompletedToday || 0
  const total = done + (d.apptScheduledToday || 0) + (d.apptCancelledToday || 0)
  const pct = total ? Math.round((done / total) * 100) : null
  const th = Math.PI * (1 - (pct || 0) / 100)
  const kx = 100 + 80 * Math.cos(th), ky = 100 - 80 * Math.sin(th)
  return (
    <Card index={6}>
      <Head title="Appointment completion" sub="Today" />
      {!ready ? <Skeleton h={120} /> : (
        <div className="pb-gauge">
          <svg viewBox="0 0 200 116" role="img" aria-label={pct === null ? 'No appointments today' : `${pct} percent of today's appointments completed`}>
            <defs>
              <linearGradient id="pb-gauge-fill" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" style={{ stopColor: 'var(--hd-cyan)' }} />
                <stop offset="1" style={{ stopColor: 'var(--hd-purple)' }} />
              </linearGradient>
            </defs>
            <path d="M20,100 A80,80 0 0 1 180,100" pathLength="100" className="pb-gauge-track" />
            {pct !== null && pct > 0 && <path d="M20,100 A80,80 0 0 1 180,100" pathLength="100" strokeDasharray={`${pct} 100`} className="pb-gauge-val" />}
            {pct !== null && <circle cx={kx} cy={ky} r="9" className="pb-gauge-knob" />}
            <text x="100" y="92" textAnchor="middle" className="pb-gauge-num">{pct === null ? '—' : `${pct}%`}</text>
          </svg>
          <p className="pb-foot">{total ? `${done} of ${total} appointments completed` : 'No appointments today'}</p>
        </div>
      )}
    </Card>
  )
}

/* ---- weekly visits (one ring per day) ---- */
function Week({ d, access, ready }) {
  const appts = !!access.appointments
  const values = tail(appts ? d.apptSeries : d.registrationSeries, 7)
  const days = daysBack(values.length || 7)
  const max = Math.max(1, ...values)
  const R = 15, C = 2 * Math.PI * R
  return (
    <Card index={7}>
      <Head title="Weekly visits" sub={appts ? 'Appointments per day' : 'New patients per day'} />
      {!ready ? <Skeleton h={70} /> : (
        <div className="pb-week">
          {values.map((v, i) => (
            <div key={i} className={`pb-day ${i === values.length - 1 ? 'today' : ''}`}>
              <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
                <circle cx="20" cy="20" r={R} className="pb-day-track" />
                <circle cx="20" cy="20" r={R} className="pb-day-val" strokeDasharray={`${(v / max) * C} ${C}`} transform="rotate(-90 20 20)" />
                <text x="20" y="24" textAnchor="middle" className="pb-day-num">{v}</text>
              </svg>
              <span>{weekday(days[i])}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ---- activity by role ---- */
const TONES = ['cyan', 'purple', 'green', 'pink']
function Roles({ d, ready }) {
  const by = {}
  ;(d.activity || []).forEach((a) => { const r = a.actor_role || 'other'; by[r] = (by[r] || 0) + 1 })
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4)
  const total = sum(rows.map((r) => r[1]))
  return (
    <Card index={8}>
      <Head title="Activity by role" sub="From the recent audit trail" />
      {!ready ? <Skeleton h={120} /> : rows.length === 0 ? <p className="hd-empty">No audited activity yet.</p> : (
        <div className="pb-roles">
          {rows.map(([role, n], i) => (
            <div key={role} className="pb-role" data-tone={TONES[i % TONES.length]}>
              <strong>{Math.round((n / total) * 100)}%</strong>
              <span>{role}</span>
              <small>{n} action{n === 1 ? '' : 's'}</small>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export default function PerformanceBoard({ d, access, ready, c }) {
  const hasBeds = !!access.beds
  const hasPatients = !!access.patients
  const hasApp = !!access.appointments
  const showActivity = hasPatients || hasApp || !!access.triage
  const showTrend = !!access.finance || hasApp
  const left = hasBeds || hasPatients || showActivity || showTrend
  const right = hasApp || hasPatients || !!access.activity
  if (!left && !right) return null
  return (
    <div className="pb-board">
      {left && (
        <div className="pb-left">
          {(hasBeds || hasPatients) && (
            <div className="pb-kpis">
              {hasBeds ? <BedsHero d={d} ready={ready} /> : <PatientsHero d={d} ready={ready} />}
              {hasBeds && <Occupancy d={d} c={c} ready={ready} />}
              {hasBeds && hasPatients && <Patients d={d} ready={ready} />}
            </div>
          )}
          {(showActivity || showTrend) && (
            <div className="pb-charts">
              {showActivity && <Activity d={d} access={access} ready={ready} />}
              {showTrend && <Trend d={d} access={access} ready={ready} />}
            </div>
          )}
        </div>
      )}
      {right && (
        <div className="pb-right">
          {hasApp && <Gauge d={d} ready={ready} />}
          {(hasApp || hasPatients) && <Week d={d} access={access} ready={ready} />}
          {access.activity && <Roles d={d} ready={ready} />}
        </div>
      )}
    </div>
  )
}
