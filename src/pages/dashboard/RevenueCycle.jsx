// src/pages/dashboard/RevenueCycle.jsx (Option B)
//
// A NEW page (does not touch your existing Billing.jsx) that exposes the
// 4 revenue cycle tabs. Add a new menu item for it in your Dashboard.jsx.
//
// This is the recommended approach if you want to KEEP your existing
// Billing page (with invoices, payments, cashier workspace, etc.).

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
  const [writeoffPrefill, setWriteoffPrefill] = useState(null);

  const ActiveComp = TABS.find(t => t.id === activeTab)?.Component || AgingDashboard;

  function handleWriteoff(payload) {
    setWriteoffPrefill(payload);
    setActiveTab('writeoffs');
  }

  function handlePaymentPlan(payload) {
    setActiveTab('plans');
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
