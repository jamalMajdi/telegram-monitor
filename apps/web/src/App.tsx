import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAdmin, RequireAuth } from './components/guards';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import DashboardPage from './pages/DashboardPage';
import AccountPage from './pages/AccountPage';
import SessionsPage from './pages/SessionsPage';
import TelegramAccountsPage from './pages/TelegramAccountsPage';
import TelegramSourcesPage from './pages/TelegramSourcesPage';
import TelegramIngestPage from './pages/TelegramIngestPage';
import TelegramResultsPage from './pages/TelegramResultsPage';
import TelegramFiltersPage from './pages/TelegramFiltersPage';
import TelegramClassificationsPage from './pages/TelegramClassificationsPage';
import TelegramResultDetailPage from './pages/TelegramResultDetailPage';
import TelegramPublishPage from './pages/TelegramPublishPage';
import AdminOverviewPage from './pages/AdminOverviewPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import AdminSystemPage from './pages/AdminSystemPage';
import AdminLogsPage from './pages/AdminLogsPage';
import LogsPage from './pages/LogsPage';
import SettingsPage from './pages/SettingsPage';
import AdminAuditPage from './pages/AdminAuditPage';
import NotFoundPage from './pages/NotFoundPage';
import NotificationsPage from './pages/NotificationsPage';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  return (
    // حاجز أعلى: أي خطأ خارج الصفحات المسجّلة (أو في التنقّل نفسه) لا يُبيّض الشاشة.
    <ErrorBoundary title="تعذّر تحميل التطبيق" hideHome>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/telegram" element={<TelegramAccountsPage />} />
            <Route path="/telegram/sources" element={<TelegramSourcesPage />} />
            <Route path="/telegram/ingest" element={<TelegramIngestPage />} />
            <Route path="/telegram/filters" element={<TelegramFiltersPage />} />
            <Route path="/telegram/classifications" element={<TelegramClassificationsPage />} />
            <Route path="/telegram/results" element={<TelegramResultsPage />} />
            <Route path="/telegram/results/:identityId" element={<TelegramResultDetailPage />} />
            <Route path="/telegram/publish" element={<TelegramPublishPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="/admin" element={<AdminOverviewPage />} />
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/admin/system" element={<AdminSystemPage />} />
              <Route path="/admin/logs" element={<AdminLogsPage />} />
              <Route path="/admin/settings" element={<AdminSettingsPage />} />
              <Route path="/admin/audit" element={<AdminAuditPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="/404" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
