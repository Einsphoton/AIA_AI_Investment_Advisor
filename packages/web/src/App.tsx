/**
 * Application shell and routing. Owner: Lead.
 *
 * Page components live in ./pages/<Name>.tsx and are owned by the frontend
 * teammates; keep the route table stable.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/Dashboard';
import { AssetsPage } from './pages/Assets';
import { WatchlistPage } from './pages/Watchlist';
import { AdvicePage } from './pages/Advice';
import { ChatPage } from './pages/Chat';
import { ActivityPage } from './pages/Activity';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/advice" element={<AdvicePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
