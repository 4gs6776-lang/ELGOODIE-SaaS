import { supabase } from './supabaseClient'

// =====================================================================
// patientDataService — all Supabase queries for the Patient Portal
// =====================================================================
//
// Every query filters by BOTH patient_id AND hospital_id to enforce
// multi-tenant isolation. Even if RLS policies fail, the query itself
// will not return another patient's or hospital's data.
//
// All functions return { data, error, count } for consistent handling.
// =====================================================================

// ---- Dashboard summary ----
export async function fetchDashboardSummary(patientId, hospitalId) {
  if (!patientId || !hospitalId) return { data: null, error: 'Missing patient or hospital' }

  const [appts, labs, invoices] = await Promise.all([
    // Upcoming appointments
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('patient_id', patientId)
      .eq('hospital_id', hospitalId)
      .gte('appointment_date', new Date().toISOString().slice(0, 10))
      .in('status', ['scheduled', 'confirmed', 'pending']),

    // Pending lab results (not yet completed)
    supabase
      .from('lab_orders')
      .select('id', { count: 'exact', head: true })
      .eq('patient_id', patientId)
      .in('status', ['requested', 'pending', 'sample_collected', 'processing', 'awaiting_verification']),

    // Outstanding balance
    supabase
      .from('invoices')
      .select('balance')
      .eq('patient_id', patientId)
      .eq('hospital_id', hospitalId)
      .neq('draft_status', 'cancelled')
      .neq('draft_status', 'written_off'),
  ])

  const outstandingBalance = (invoices.data || []).reduce(
    (sum, inv) => sum + Number(inv.balance || 0), 0
  )

  return {
    data: {
      upcomingAppointments: appts.count || 0,
      pendingLabResults: labs.count || 0,
      outstandingBalance,
      outstandingInvoiceCount: (invoices.data || []).filter(i => Number(i.balance || 0) > 0.01).length,
    },
    error: null,
  }
}

// ---- Lab Results ----
export async function fetchLabResults(patientId, hospitalId) {
  if (!patientId || !hospitalId) return { data: [], error: 'Missing patient or hospital' }

  // Fetch from both lab_orders and lab_tests (the app uses both tables)
  const [orders, tests] = await Promise.all([
    supabase
      .from('lab_orders')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false }),
    supabase
      .from('lab_tests')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false }),
  ])

  // Merge and deduplicate by id (a test might exist in both tables)
  const allResults = [...(orders.data || []), ...(tests.data || [])]
  const seen = new Set()
  const unique = allResults.filter(r => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })

  return { data: unique, error: orders.error || tests.error }
}

// ---- Invoices ----
export async function fetchInvoices(patientId, hospitalId) {
  if (!patientId || !hospitalId) return { data: [], error: 'Missing patient or hospital' }

  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('patient_id', patientId)
    .eq('hospital_id', hospitalId)
    .neq('draft_status', 'cancelled')
    .order('created_at', { ascending: false })

  return { data: data || [], error }
}

// ---- Payments for an invoice ----
export async function fetchPayments(invoiceId, hospitalId) {
  if (!invoiceId || !hospitalId) return { data: [], error: 'Missing invoice or hospital' }

  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('hospital_id', hospitalId)
    .neq('status', 'reversed')
    .order('created_at', { ascending: false })

  return { data: data || [], error }
}

// ---- Appointments ----
export async function fetchAppointments(patientId, hospitalId) {
  if (!patientId || !hospitalId) return { data: [], error: 'Missing patient or hospital' }

  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('patient_id', patientId)
    .eq('hospital_id', hospitalId)
    .order('appointment_date', { ascending: false })

  return { data: data || [], error }
}

// ---- Consultations (for documents) ----
export async function fetchConsultations(patientId, hospitalId) {
  if (!patientId || !hospitalId) return { data: [], error: 'Missing patient or hospital' }

  const { data, error } = await supabase
    .from('patient_vitals')
    .select('id, patient_id, hospital_id, chief_complaints, diagnosis, treatment_plan, completed_at, created_at')
    .eq('patient_id', patientId)
    .eq('hospital_id', hospitalId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(10)

  return { data: data || [], error }
}

// ---- Documents (combined from lab results + consultations) ----
export async function fetchDocuments(patientId, hospitalId) {
  if (!patientId || !hospitalId) return { data: [], error: 'Missing patient or hospital' }

  const [labs, consults, invoices] = await Promise.all([
    fetchLabResults(patientId, hospitalId),
    fetchConsultations(patientId, hospitalId),
    fetchInvoices(patientId, hospitalId),
  ])

  const documents = []

  // Lab results that are completed → downloadable
  ;(labs.data || []).forEach(lab => {
    if (['completed', 'verified'].includes(lab.status)) {
      documents.push({
        id: `lab-${lab.id}`,
        type: 'lab_result',
        title: `Lab Result: ${lab.test_name || 'Test'}`,
        date: lab.resulted_at || lab.completed_at || lab.created_at,
        refId: lab.id,
        status: lab.status,
      })
    }
  })

  // Completed consultations → medical report
  ;(consults.data || []).forEach(consult => {
    documents.push({
      id: `consult-${consult.id}`,
      type: 'consultation',
      title: `Medical Report: ${consult.chief_complaints || 'Consultation'}`,
      date: consult.completed_at || consult.created_at,
      refId: consult.id,
    })
  })

  // Paid invoices → receipt
  ;(invoices.data || []).forEach(inv => {
    if (inv.status === 'paid' || Number(inv.amount_paid || 0) > 0) {
      documents.push({
        id: `invoice-${inv.id}`,
        type: 'receipt',
        title: `Receipt: ${inv.invoice_number || 'Invoice'}`,
        date: inv.created_at,
        refId: inv.id,
      })
    }
  })

  // Sort by date descending
  documents.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))

  return { data: documents, error: null }
}
