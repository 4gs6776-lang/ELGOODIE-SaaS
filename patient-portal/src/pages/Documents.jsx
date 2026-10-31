import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { fetchDocuments } from '../lib/patientDataService'
import { FileText, ChevronRight, RefreshCw, Microscope, Stethoscope, Receipt, Download } from 'lucide-react'

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function typeIcon(type) {
  switch (type) {
    case 'lab_result': return { icon: Microscope, bg: 'bg-primary-50', color: 'text-primary-500', label: 'Lab Result' }
    case 'consultation': return { icon: Stethoscope, bg: 'bg-accent-50', color: 'text-accent-500', label: 'Medical Report' }
    case 'receipt': return { icon: Receipt, bg: 'bg-amber-50', color: 'text-amber-500', label: 'Receipt' }
    default: return { icon: FileText, bg: 'bg-surface-50', color: 'text-surface-400', label: 'Document' }
  }
}

export default function Documents() {
  const { patient } = useAuth()
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadData = useCallback(async (isRefresh = false) => {
    if (!patient?.id) return
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const { data, error } = await fetchDocuments(patient.id, patient.hospital_id)
      if (error) setError(error)
      else setDocuments(data || [])
    } catch (err) {
      setError(err.message || 'Could not load documents')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [patient?.id, patient?.hospital_id])

  useEffect(() => { loadData() }, [loadData])

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-7 w-40 bg-surface-100 rounded-lg animate-pulse" />
        {[1, 2, 3].map(i => <div key={i} className="bg-white rounded-2xl p-4 card-shadow h-16 animate-pulse" />)}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-surface-900">Documents</h1>
        <button onClick={() => loadData(true)} disabled={refreshing} className="p-2 rounded-lg text-surface-400 hover:text-primary-500">
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-600">{error}</div>}

      {documents.length === 0 && !error ? (
        <div className="bg-white rounded-2xl card-shadow p-8 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-surface-100 flex items-center justify-center mb-3">
            <FileText size={28} className="text-surface-300" />
          </div>
          <p className="text-sm font-semibold text-surface-700">No documents yet</p>
          <p className="text-xs text-surface-400 mt-1 max-w-xs">
            Your lab results, medical reports, and receipts will appear here once they are available.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map(doc => {
            const { icon: Icon, bg, color, label } = typeIcon(doc.type)
            return (
              <button
                key={doc.id}
                onClick={() => window.print()}
                className="w-full bg-white rounded-2xl p-4 card-shadow text-left transition-all-smooth hover:card-shadow-lg active:scale-[0.98]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center flex-shrink-0`}>
                      <Icon size={18} className={color} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-surface-900 truncate">{doc.title}</div>
                      <div className="text-xs text-surface-400 mt-0.5">
                        {label} · {formatDate(doc.date)}
                      </div>
                    </div>
                  </div>
                  <Download size={18} className="text-surface-300 flex-shrink-0" />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
