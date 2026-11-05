// src/components/Billing.jsx — Revenue Cycle tabs
// Drop-in replacement for the existing Billing screen (or wire into a sub-tab).
// Provides tabbed access to: Aging Dashboard, Payment Plans, Write-offs,
// HMO Claims.

import React, { useState } from 'react';
import AgingDashboard from './AgingDashboard';
import PaymentPlans from './PaymentPlans';
import WriteOffManager from './WriteOffManager';
import HMOClaimForm from './HMOClaimForm';
import './RevenueCycle.css';

const TABS = [
  { id: 'aging',     label: 'Aging Dashboard',  Component: AgingDashboard },
  { id: 'plans',     label: 'Payment Plans',    Component: PaymentPlans },
  { id: 'writeoffs', label: 'Write-offs',       Component: WriteOffManager },
  { id: 'claims',    label: 'HMO Claims',       Component: HMOClaimForm },
];

export default function Billing() {
  const [activeTab, setActiveTab] = useState('aging');
  // Cross-tab prefill: aging dashboard "Write-off" action preloads WriteOffManager
  const [writeoffPrefill, setWriteoffPrefill] = useState(null);
  const [planPrefill, setPlanPrefill] = useState(null);

  const ActiveComp = TABS.find(t => t.id === activeTab)?.Component || AgingDashboard;

  function handleWriteoff(payload) {
    setWriteoffPrefill(payload);
    setActiveTab('writeoffs');
  }

  function handlePaymentPlan(payload) {
    setPlanPrefill(payload);
    setActiveTab('plans');
    // Note: PaymentPlans reads prefill via prop in a future iteration.
    // For now we just switch tab; user clicks "+ New Payment Plan" and
    // the patient/invoice is already preselected via the queue.
    // TODO: extend PaymentPlans to accept `prefill` prop.
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
