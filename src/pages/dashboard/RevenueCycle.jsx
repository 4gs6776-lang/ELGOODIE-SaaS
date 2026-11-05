// src/pages/dashboard/RevenueCycle.jsx
// COMPLETE drop-in page (no patching required).
//
// Adds a new "Revenue Cycle" tab to the dashboard with 4 sub-tabs:
//   1. Aging Dashboard (outstanding invoices grouped by age)
//   2. Payment Plans (create + track installments)
//   3. Write-offs (request + approve workflow)
//   4. HMO Claims (generate + submit insurance claims)
//
// USAGE:
//   1. Drop this file into src/pages/dashboard/
//   2. Add a menu item / route that points to <RevenueCycle />
//   3. Done. No existing files need to be modified.
//
// This is intentionally a separate page from the existing Billing.jsx
// so it doesn't disturb any of your existing invoice management UI.

import React, { useState } from 'react';
import AgingDashboard from '../../components/AgingDashboard';
import PaymentPlans from '../../components/PaymentPlans';
import WriteOffManager from '../../components/WriteOffManager';
import HMOClaimForm from '../../components/HMOClaimForm';
import '../../components/RevenueCycle.css';

const TABS = [
  { id: 'aging',     label: 'Aging Dashboard', Component: AgingDashboard },
  { id: 'plans',     label: 'Payment Plans',    Component: PaymentPlans },
  { id: 'writeoffs', label: 'Write-offs',       Component: WriteOffManager },
  { id: 'claims',    label: 'HMO Claims',       Component: HMOClaimForm },
];

export default function RevenueCycle() {
  const [activeTab, setActiveTab] = useState('aging');
  // Cross-tab prefill: aging dashboard "Write-off" action preloads WriteOffManager
  const [writeoffPrefill, setWriteoffPrefill] = useState(null);

  const ActiveComp = TABS.find(t => t.id === activeTab)?.Component || AgingDashboard;

  function handleWriteoff(payload) {
    setWriteoffPrefill(payload);
    setActiveTab('writeoffs');
  }

  function handlePaymentPlan(payload) {
    setActiveTab('plans');
    // Future: extend PaymentPlans to accept `prefill` prop.
  }

  return (
    <div>
      <div className="rc-tabs" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`rc-tab ${activeTab === t.id ? 'rc-tab-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ActiveComp
        onWriteoff={handleWriteoff}
        onPaymentPlan={handlePaymentPlan}
        prefill={activeTab === 'writeoffs' ? writeoffPrefill : null}
      />
    </div>
  );
}
