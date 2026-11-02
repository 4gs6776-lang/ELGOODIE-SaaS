import { useState, useMemo, useEffect } from 'react'
import AppIcon from './icons'
import { formatMoney, resolvePriceForPatient, computeHmoSplit, findContractForPatient } from '../lib/billingService'

// =====================================================================
// LabTestPicker — modal that lets a doctor select MULTIPLE laboratory
// tests from the hospital's service_catalog (category='lab').
//
// Replaces the old hardcoded LAB_TEST_CATEGORIES constant in
// DoctorWorkbench.jsx. Reads the same service_catalog table that
// admins manage via Settings → Service Catalog, so prices + sample
// types + active status are all driven by the database.
//
// Props:
//   catalog          service_catalog rows (from useBillingCatalog)
//   priceLists       price_lists rows
//   priceListItems   price_list_items rows
//   contracts        hmo_contracts rows
//   patient          the patient being consulted (for HMO price list lookup)
//   initialSelected  array of test catalog IDs already selected (for re-open)
//   onConfirm        (selectedTests[]) => void  — called with the full
//                    resolved test objects when the doctor clicks Confirm
//   onClose          () => void
//
// Each item in selectedTests[] has:
//   { id, code, name, category, sample_type, price, hmoAmount,
//     patientAmount, coveragePercent, requiresPreAuth, contractId }
// =====================================================================

export default function LabTestPicker({ catalog, priceLists, priceListItems, contracts, patient, initialSelected = [], onConfirm, onClose }) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [selectedIds, setSelectedIds] = useState(new Set(initialSelected))
  const [priority, setPriority] = useState('routine')
  const [clinicalNotes, setClinicalNotes] = useState('')

  // Filter to lab tests only (category = 'lab')
  const labTests = useMemo(() => {
    return (catalog || []).filter(s => s.is_active !== false && s.category === 'lab')
  }, [catalog])

  // Defensive warning — helps diagnose "no lab tests loading" silently.
  // If catalog is empty, it's almost always because migration 066 didn't
  // run, OR the service_catalog table is missing, OR RLS is blocking reads.
  // The console.warn makes this visible without breaking the UI.
  useEffect(() => {
    if (!catalog || catalog.length === 0) {
      console.warn(
        '[LabTestPicker] service_catalog is empty — possible causes:\n' +
        '  1. Migration 066_reconstruct_phase1_master_data.sql was not applied\n' +
        '  2. The service_catalog table is missing entirely\n' +
        '  3. RLS policy "service_catalog_select" is blocking reads\n' +
        '  4. No lab tests have been added to Settings → Service Catalog yet\n' +
        'Run this in Supabase SQL editor to verify:\n' +
        "  select count(*) from public.service_catalog where category = 'lab';"
      )
    }
  }, [catalog])

  const categories = useMemo(() => {
    const set = new Set(labTests.map(t => t.sub_category || t.category || 'lab').filter(Boolean))
    return ['all', ...Array.from(set).sort()]
  }, [labTests])

  const filtered = useMemo(() => {
    let arr = [...labTests]
    if (categoryFilter !== 'all') {
      arr = arr.filter(s => (s.sub_category || s.category || 'lab') === categoryFilter)
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(s =>
        (s.code || '').toLowerCase().includes(q) ||
        (s.name || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
      )
    }
    return arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''))
  }, [labTests, search, categoryFilter])

  // Resolve price + HMO split for each filtered test
  const resolvedTests = useMemo(() => {
    return filtered.map(t => {
      const resolved = resolvePriceForPatient({
        service: t,
        catalog,
        priceLists,
        priceListItems,
        contracts,
        patient,
        quantity: 1,
      })
      const split = computeHmoSplit({
        total: resolved.price,
        coveragePercent: resolved.coveragePercent,
      })
      return {
        ...t,
        price: resolved.price,
        priceListId: resolved.priceListId,
        contractId: resolved.contractId,
        coveragePercent: resolved.coveragePercent,
        hmoAmount: split.hmoAmount,
        patientAmount: split.patientAmount,
        requiresPreAuth: resolved.requiresPreAuth,
      }
    })
  }, [filtered, catalog, priceLists, priceListItems, contracts, patient])

  const selectedTests = useMemo(() => {
    return resolvedTests.filter(t => selectedIds.has(t.id))
  }, [resolvedTests, selectedIds])

  const totalPatientCost = selectedTests.reduce((s, t) => s + Number(t.patientAmount || 0), 0)
  const totalHmoAmount = selectedTests.reduce((s, t) => s + Number(t.hmoAmount || 0), 0)
  const totalGross = selectedTests.reduce((s, t) => s + Number(t.price || 0), 0)

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleConfirm() {
    onConfirm({
      tests: selectedTests,
      priority,
      clinicalNotes: clinicalNotes.trim(),
    })
  }

  return (
    <div className="dash-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card dash-modal" style={{ maxWidth: 820, maxHeight: 'calc(100vh - 40px)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 14, flexShrink: 0 }}>
          <div>
            <div className="dash-modal-title" style={{ paddingBottom: 0 }}>Select Laboratory Tests</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              Search the hospital's lab catalogue. Multi-select supported.
              {patient?.hmo_provider && (
                <span style={{ marginLeft: 8, color: 'var(--violet)' }}>
                  · HMO: {patient.hmo_provider} ({patient.hmo_coverage_percent || 0}% covered)
                </span>
              )}
            </div>
          </div>
          <button className="dash-icon-btn" onClick={onClose} aria-label="Close"><AppIcon name="close" size={18} /></button>
        </div>

        <div className="dash-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search + category filter */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="dash-search" style={{ flex: 1, minWidth: 220 }}>
              <AppIcon name="search" size={15} />
              <input
                placeholder="Search test name, code, or description…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}
            >
              {categories.map(c => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}
            </select>
          </div>

          {/* Test list */}
          {resolvedTests.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
              {labTests.length === 0
                ? 'No lab tests in the service catalog. An admin must add lab tests via Settings → Service Catalog (category = lab) before doctors can order them.'
                : 'No tests match your search.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
              {resolvedTests.map(t => {
                const isSelected = selectedIds.has(t.id)
                return (
                  <div
                    key={t.id}
                    onClick={() => toggleSelect(t.id)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px',
                      borderRadius: 10, cursor: 'pointer',
                      background: isSelected ? 'rgba(0,199,199,0.08)' : 'var(--bg-elevated)',
                      border: `1px solid ${isSelected ? 'var(--teal-border)' : 'var(--line-soft)'}`,
                      transition: 'all .15s ease',
                    }}
                  >
                    <div style={{
                      width: 18, height: 18, borderRadius: 5, flexShrink: 0, marginTop: 2,
                      border: `2px solid ${isSelected ? 'var(--teal)' : 'var(--muted-dim)'}`,
                      background: isSelected ? 'var(--teal)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isSelected && <AppIcon name="check" size={12} strokeWidth={3} style={{ color: '#03201D' }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ivory)' }}>
                          {t.name}
                          {t.code && <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{t.code}</span>}
                        </div>
                        <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--teal)' }}>
                          {formatMoney(t.price)}
                        </div>
                      </div>
                      {t.description && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{t.description}</div>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', fontSize: 10.5 }}>
                        {t.sample_type && (
                          <span style={{ padding: '2px 7px', borderRadius: 8, background: 'rgba(232,184,46,0.10)', color: 'var(--gold)', fontWeight: 600 }}>
                            Specimen: {t.sample_type}
                          </span>
                        )}
                        {t.requires_pre_auth && (
                          <span style={{ padding: '2px 7px', borderRadius: 8, background: 'rgba(118,87,232,0.10)', color: 'var(--violet)', fontWeight: 600 }}>
                            Pre-auth required
                          </span>
                        )}
                        {t.coveragePercent > 0 && (
                          <span style={{ padding: '2px 7px', borderRadius: 8, background: 'rgba(0,199,199,0.10)', color: 'var(--teal)', fontWeight: 600 }}>
                            HMO {t.coveragePercent}% · patient pays {formatMoney(t.patientAmount)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Priority + clinical notes */}
          {selectedTests.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div className="field" style={{ flex: 1, minWidth: 140 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Priority</label>
                  <select
                    value={priority}
                    onChange={e => setPriority(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}
                  >
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                    <option value="stat">STAT (critical)</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 2, minWidth: 220 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Clinical notes (optional)</label>
                  <input
                    type="text"
                    value={clinicalNotes}
                    onChange={e => setClinicalNotes(e.target.value)}
                    placeholder="e.g. fever 3 days, rule out malaria"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elevated)', color: 'var(--ivory)', fontSize: 12.5 }}
                  />
                </div>
              </div>

              {/* Selected tests review */}
              <div style={{ padding: 12, borderRadius: 8, background: 'rgba(0,199,199,0.05)', border: '1px solid var(--teal-border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Selected tests ({selectedTests.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
                  {selectedTests.map(t => (
                    <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                      <span style={{ fontWeight: 600, color: 'var(--ivory)' }}>{t.name}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{formatMoney(t.patientAmount)}{t.hmoAmount > 0 ? ` + HMO ${formatMoney(t.hmoAmount)}` : ''}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--line-soft)', display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 }}>
                  <span style={{ color: 'var(--muted)' }}>Total</span>
                  <span style={{ color: 'var(--teal)', fontFamily: 'var(--font-mono)' }}>
                    {formatMoney(totalGross)}
                    {totalHmoAmount > 0 && <span style={{ color: 'var(--muted)', fontWeight: 500, marginLeft: 8 }}>(patient {formatMoney(totalPatientCost)} + HMO {formatMoney(totalHmoAmount)})</span>}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="dash-modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={selectedTests.length === 0}
            style={{ opacity: selectedTests.length === 0 ? 0.5 : 1 }}
          >
            Add {selectedTests.length > 0 ? `${selectedTests.length} ` : ''}Lab Test{selectedTests.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
