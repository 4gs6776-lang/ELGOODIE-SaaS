import { useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { useOfflineTable } from '../lib/useOfflineTable'
import { ShieldCheck, Clock, AlertTriangle, Award } from 'lucide-react'

// =====================================================================
// StaffPerformanceDashboard — summary view for admins/owners
// =====================================================================
// Shows:
//   - Credential compliance rate (% of staff with valid, unexpired creds)
//   - CME hours total (hospital-wide)
//   - Open incidents count
//   - Attendance rate (present vs scheduled)
// =====================================================================

export default function StaffPerformanceDashboard({ staffMembers }) {
  const { hospital } = useAuth()
  const { records: credentials } = useOfflineTable('staff_credentials', hospital?.id)
  const { records: cmeRecords } = useOfflineTable('staff_cme_records', hospital?.id)
  const { records: incidents } = useOfflineTable('staff_incidents', hospital?.id)
  const { records: attendance } = useOfflineTable('staff_shift_attendance', hospital?.id)

  const stats = useMemo(() => {
    const totalStaff = staffMembers?.length || 0
    const activeStaff = staffMembers?.filter(s => s.active !== false) || []

    // Credential compliance
    const staffWithCreds = new Set()
    let expiredCount = 0
    let expiringSoonCount = 0
    credentials?.forEach(c => {
      staffWithCreds.add(c.staff_id)
      const now = new Date()
      const expiry = new Date(c.expiry_date)
      const days = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24))
      if (days < 0) expiredCount++
      else if (days <= 60) expiringSoonCount++
    })
    const staffWithoutCreds = activeStaff.filter(s => !staffWithCreds.has(s.id))
    const complianceRate = activeStaff.length > 0 ? Math.round(((activeStaff.length - staffWithoutCreds.length - expiredCount) / activeStaff.length) * 100) : 0

    // CME hours
    const totalCmeHours = cmeRecords?.reduce((s, r) => s + (Number(r.cme_hours) || 0), 0) || 0

    // Incidents
    const openIncidents = incidents?.filter(i => !i.resolved) || []
    const resolvedIncidents = incidents?.filter(i => i.resolved) || []

    // Attendance (last 30 days)
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const recentAttendance = attendance?.filter(a => new Date(a.shift_date) >= thirtyDaysAgo) || []
    const presentCount = recentAttendance.filter(a => a.status === 'present' || a.status === 'late').length
    const absentCount = recentAttendance.filter(a => a.status === 'absent').length
    const attendanceRate = recentAttendance.length > 0 ? Math.round((presentCount / recentAttendance.length) * 100) : 0

    return {
      totalStaff: activeStaff.length,
      complianceRate,
      expiredCount,
      expiringSoonCount,
      staffWithoutCreds: staffWithoutCreds.length,
      totalCmeHours,
      openIncidents: openIncidents.length,
      resolvedIncidents: resolvedIncidents.length,
      attendanceRate,
      presentCount,
      absentCount,
    }
  }, [staffMembers, credentials, cmeRecords, incidents, attendance])

  const cards = [
    {
      label: 'Credential Compliance',
      value: `${stats.complianceRate}%`,
      icon: <ShieldCheck size={20} />,
      color: stats.complianceRate >= 80 ? 'var(--success)' : stats.complianceRate >= 50 ? 'var(--gold)' : 'var(--danger)',
      sub: `${stats.expiredCount} expired · ${stats.expiringSoonCount} expiring soon · ${stats.staffWithoutCreds} no credentials`,
    },
    {
      label: 'Total CME Hours',
      value: `${stats.totalCmeHours.toFixed(1)}h`,
      icon: <Award size={20} />,
      color: 'var(--teal)',
      sub: `Across ${stats.totalStaff} active staff members`,
    },
    {
      label: 'Open Incidents',
      value: stats.openIncidents,
      icon: <AlertTriangle size={20} />,
      color: stats.openIncidents > 0 ? 'var(--danger)' : 'var(--success)',
      sub: `${stats.resolvedIncidents} resolved total`,
    },
    {
      label: 'Attendance Rate',
      value: `${stats.attendanceRate}%`,
      icon: <Clock size={20} />,
      color: stats.attendanceRate >= 80 ? 'var(--success)' : 'var(--gold)',
      sub: `Last 30 days · ${stats.presentCount} present · ${stats.absentCount} absent`,
    },
  ]

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ivory)', marginBottom: 14 }}>Performance Overview</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        {cards.map((c, i) => (
          <div key={i} style={{
            padding: 16, borderRadius: 12, background: 'var(--bg-card)',
            border: '1px solid var(--line)', position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: `${c.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.color }}>
                {c.icon}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {c.label}
              </div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: c.color, marginBottom: 4 }}>
              {c.value}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {c.sub}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
