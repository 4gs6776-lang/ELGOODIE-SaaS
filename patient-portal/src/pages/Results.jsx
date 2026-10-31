import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchLabResults } from '../lib/patientDataService'
import { FileText, ChevronRight, RefreshCw, X, Clock, CheckCircle2, AlertCircle, Microscope } from 'lucide-react'

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function statusBadge(status) {
  const s = (status || '').toLowerCase()
  if (['completed', 'verified'].includes(s)) return { label: 'Completed', color: 'text-accent-600', bg: 'bg-accent-50', icon: CheckCircle2 }
  if (['awaiting_verification'].includes(s)) return { label: 'Awaiting Verification', color: 'text-amber-600', bg: 'bg-amber-50', icon: Clock }
  if (['processing', 'sample_collected'].includes(s)) return { label: 'In Progress', color: 'text-primary-600', bg: 'bg-primary-50', icon: Clock }
  if (['cancelled'].includes(s)) return { label: 'Cancelled', color: 'text-surface-400', bg: 'bg-surface-100', icon: X }
  return { label: status || 'Pending', color: 'text-surface-500', bg: 'bg-surface-50', icon: AlertCircle }
}

export default function Results() {
  const { patient } = useAuth()
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedResult, setSelectedResult] = useState(null)
  const [error, setError] = useState('')

  const loadData = useCallback(async (isRefresh = false) => {
    if (!patient?.id) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const { data, error } = await fetchLabResults(patient.id, patient.hospital_id)
      if (error) setError(error)
      else setResults(data || [])
    } catch (err) {
      setError(err.message || 'Could not load results')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [patient?.id, patient?.hospital_id])

  useEffect(() => { loadData() }, [loadData])

  // Skeleton
  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-7 w-40 bg-surface-100 rounded-lg animate-pulse" />
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-white rounded-2xl p-4 card-shadow">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-surface-100 animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-32 bg-surface-100 rounded animate-pulse" />
                <div className="h-3 w-20 bg-surface-50 rounded animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Detail view
  if (selectedResult) {
    const badge = statusBadge(selectedResult.status)
    const StatusIcon = badge.icon
    return (
      <div className="space-y-4">
        <button
          onClick={() => setSelectedResult(null)}
          className="flex items-center gap-2 text-sm text-primary-500 font-medium"
        >
          <ChevronRight size={16} className="rotate-180" /> Back to Results
        </button>

        <div className="bg-white rounded-2xl card-shadow overflow-hidden">
          <div className="p-4 border-b border-surface-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-primary-50 flex items-center justify-center">
                  <Microscope size={22} className="text-primary-500" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-surface-900">{selectedResult.test_name || 'Lab Test'}</h2>
                  <p className="text-xs text-surface-400">Ordered: {formatDate(selectedResult.created_at)}</p>
                </div>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1 ${badge.bg} ${badge.color}`}>
                <StatusIcon size={12} /> {badge.label}
              </span>
            </div>
          </div>

          <div className="p-4 space-y-3">
            {selectedResult.priority && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Priority</span>
                <span className="font-semibold capitalize text-surface-700">{selectedResult.priority}</span>
              </div>
            )}
            {selectedResult.result && (
              <div>
                <div className="text-xs text-surface-400 mb-1">Result</div>
                <div className="text-sm font-medium text-surface-700 bg-surface-50 rounded-lg p-3">{selectedResult.result}</div>
              </div>
            )}
            {selectedResult.result_notes && (
              <div>
                <div className="text-xs text-surface-400 mb-1">Notes</div>
                <div className="text-sm text-surface-700">{selectedResult.result_notes}</div>
              </div>
            )}
            {selectedResult.result_unit && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Unit</span>
                <span className="font-semibold text-surface-700">{selectedResult.result_unit}</span>
              </div>
            )}
            {selectedResult.reference_range && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Reference Range</span>
                <span className="font-semibold text-surface-700">{selectedResult.reference_range}</span>
              </div>
            )}
            {selectedResult.abnormal_flag && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Flag</span>
                <span className={`font-semibold capitalize ${selectedResult.abnormal_flag === 'critical' ? 'text-red-500' : 'text-amber-500'}`}>
                  {selectedResult.abnormal_flag}
                </span>
              </div>
            )}
            {selectedResult.resulted_at && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Result Date</span>
                <span className="font-semibold text-surface-700">{formatDate(selectedResult.resulted_at)}</span>
              </div>
            )}
            {selectedResult.verified_by && (
              <div className="flex justify-between text-sm">
                <span className="text-surface-400">Verified By</span>
                <span className="font-semibold text-surface-700">{selectedResult.verified_by}</span>
              </div>
            )}
            {selectedResult.notes && (
              <div>
                <div className="text-xs text-surface-400 mb-1">Clinical Notes</div>
                <div className="text-sm text-surface-700">{selectedResult.notes}</div>
              </div>
            )}
          </div>
        </div>

        {/* Download button (only for completed results) */}
        {['completed', 'verified'].includes((selectedResult.status || '').toLowerCase()) && (
          <button
            onClick={() => window.print()}
            className="w-full py-3.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-semibold text-sm transition-all-smooth"
          >
            Download PDF
          </button>
        )}
      </div>
    )
  }

  // List view
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-surface-900">Lab Results</h1>
        <button
          onClick={() => loadData(true)}
          disabled={refreshing}
          className="p-2 rounded-lg text-surface-400 hover:text-primary-500"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>
      )}

      {results.length === 0 && !error ? (
        <div className="bg-white rounded-2xl card-shadow p-8 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-surface-100 flex items-center justify-center mb-3">
            <FileText size={28} className="text-surface-300" />
          </div>
          <p className="text-sm font-semibold text-surface-700">No lab results yet</p>
          <p className="text-xs text-surface-400 mt-1 max-w-xs">
            Your lab test results will appear here once they are processed and verified by the laboratory.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {results.map((result) => {
            const badge = statusBadge(result.status)
            const StatusIcon = badge.icon
            const isCompleted = ['completed', 'verified'].includes((result.status || '').toLowerCase())
            return (
              <button
                key={result.id}
                onClick={() => setSelectedResult(result)}
                className="w-full bg-white rounded-2xl p-4 card-shadow text-left transition-all-smooth hover:card-shadow-lg active:scale-[0.98]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`w-10 h-10 rounded-xl ${badge.bg} flex items-center justify-center flex-shrink-0`}>
                      <StatusIcon size={18} className={badge.color} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-surface-900 truncate">{result.test_name || 'Lab Test'}</div>
                      <div className="text-xs text-surface-400 mt-0.5">
                        {formatDate(result.resulted_at || result.created_at)}
                        {result.priority === 'stat' && <span className="ml-2 text-red-500 font-bold">STAT</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.bg} ${badge.color}`}>
                      {badge.label}
                    </span>
                    <ChevronRight size={16} className="text-surface-300" />
                  </div>
                </div>
                {isCompleted && result.result && (
                  <div className="mt-2.5 pl-13 text-xs text-surface-500 truncate" style={{ paddingLeft: 52 }}>
                    Result: {result.result}
                    {result.result_unit && ` ${result.result_unit}`}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
