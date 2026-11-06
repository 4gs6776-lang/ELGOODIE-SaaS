// src/components/AccordionSection.jsx
//
// A collapsible accordion section that LAZY-mounts its children only
// when expanded. Solves the Settings page performance problem:
//
//   - Each section is collapsed by default
//   - Children mount only when the user clicks to expand
//   - When collapsed, children unmount → all their useOfflineTable
//     hooks stop fetching, free IndexedDB connections, clear timers
//
// USAGE:
//   <AccordionSection title="Bank Accounts" icon="bank" defaultOpen={false}>
//     <BankAccountsEditor />
//   </AccordionSection>
//
// Pass `defaultOpen={true}` for sections you want open on first visit
// (e.g. "Your Profile" which is cheap to render).

import React, { useState } from 'react';
import AppIcon from './icons';
import './AccordionSection.css';

export default function AccordionSection({
  title,
  subtitle,
  icon,
  defaultOpen = false,
  badge,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`acc-section ${open ? 'acc-open' : ''}`}>
      <button
        type="button"
        className="acc-header"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className="acc-header-left">
          {icon && (
            <span className="acc-icon">
              <AppIcon name={icon} size={18} />
            </span>
          )}
          <div className="acc-header-text">
            <div className="acc-title">{title}</div>
            {subtitle && <div className="acc-subtitle">{subtitle}</div>}
          </div>
          {badge && <span className="acc-badge">{badge}</span>}
        </div>
        <svg
          className={`acc-chevron ${open ? 'acc-chevron-rotated' : ''}`}
          width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="acc-body">
          {children}
        </div>
      )}
    </section>
  );
}
