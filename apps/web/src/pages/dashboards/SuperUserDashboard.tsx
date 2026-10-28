import { useState } from 'react';
import { ReceptionDashboard } from './ReceptionDashboard';
import { DoctorDashboard } from './DoctorDashboard';
import { PharmacyDashboard } from './PharmacyDashboard';
import { InsuranceDashboard } from './InsuranceDashboard';
import { AdminDashboard } from './AdminDashboard';

type Tab = 'reception' | 'doctor' | 'pharmacy' | 'insurance' | 'admin';

/** Same order as the login screen's quick sign-in: the order a patient meets them. */
const TAB_LABEL: Record<Tab, string> = {
  reception: '🏥 Reception',
  insurance: '🛡️ Insurance',
  pharmacy: '💊 Pharmacy',
  doctor: '👨‍⚕️ Doctor',
  admin: '⚙️ Admin',
};

/**
 * Full access to every other role's work, from one login — confirmed as a
 * distinct role, not an admin extension (admin manages the system;
 * superuser covers everyone's day-to-day clinical/financial work). Reuses
 * each role's existing dashboard component as-is rather than rebuilding
 * anything — every action taken here still logs this account's own real
 * loginId in the audit trail, never anonymized as "reception did this."
 *
 * No outer AppShell here: each dashboard below already renders its own
 * full AppShell (header, logout, footer) — wrapping a second one around it
 * would just double the chrome. Instead this renders a thin superuser tab
 * strip pinned above whichever dashboard is active.
 */
export function SuperUserDashboard() {
  const [tab, setTab] = useState<Tab>('reception');

  return (
    <div>
      <div className="tabs" style={{ padding: '8px 16px', background: '#1a2332' }}>
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button key={t} type="button" className={`tab-button${tab === t ? ' tab-button--active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'reception' && <ReceptionDashboard />}
      {tab === 'doctor' && <DoctorDashboard />}
      {tab === 'pharmacy' && <PharmacyDashboard />}
      {tab === 'insurance' && <InsuranceDashboard />}
      {tab === 'admin' && <AdminDashboard />}
    </div>
  );
}
