import { Routes, Route } from 'react-router-dom';
import { RequireRole } from './auth/RequireRole';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { HomeRedirect } from './pages/HomeRedirect';
import { AdminDashboard } from './pages/dashboards/AdminDashboard';
import { DoctorDashboard } from './pages/dashboards/DoctorDashboard';
import { ReceptionDashboard } from './pages/dashboards/ReceptionDashboard';
import { PharmacyDashboard } from './pages/dashboards/PharmacyDashboard';
import { InsuranceDashboard } from './pages/dashboards/InsuranceDashboard';
import { SuperUserDashboard } from './pages/dashboards/SuperUserDashboard';
import { CentralStationPage } from './features/vigil/CentralStationPage';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/" element={<HomeRedirect />} />
      <Route
        path="/admin"
        element={
          <RequireRole allow={['admin']}>
            <AdminDashboard />
          </RequireRole>
        }
      />
      <Route
        path="/doctor"
        element={
          <RequireRole allow={['doctor']}>
            <DoctorDashboard />
          </RequireRole>
        }
      />
      <Route
        path="/reception"
        element={
          <RequireRole allow={['reception']}>
            <ReceptionDashboard />
          </RequireRole>
        }
      />
      <Route
        path="/pharmacy"
        element={
          <RequireRole allow={['pharmacy']}>
            <PharmacyDashboard />
          </RequireRole>
        }
      />
      <Route
        path="/insurance"
        element={
          <RequireRole allow={['insurance']}>
            <InsuranceDashboard />
          </RequireRole>
        }
      />
      <Route
        path="/central-station"
        element={
          <RequireRole allow={['doctor', 'admin', 'superuser']}>
            <CentralStationPage />
          </RequireRole>
        }
      />
      <Route
        path="/super"
        element={
          <RequireRole allow={['superuser']}>
            <SuperUserDashboard />
          </RequireRole>
        }
      />
    </Routes>
  );
}

export default App;
