/**
 * Application shell and routing. Owner: Lead.
 *
 * Page components live in ./pages/<Name>.tsx and are owned by the frontend
 * teammates; keep the route table stable.
 *
 * `AgentActivityProvider` + `AgentActivityDock` wrap the router: the agent
 * stream is owned globally, so the reasoning dock (bottom-right) survives page
 * switches instead of being unmounted with the page that started the run.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { AgentActivityProvider } from './api/agentActivity';
import { AgentActivityDock } from './components/AgentActivityDock';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/Dashboard';
import { AssetsPage } from './pages/Assets';
import { WatchlistPage } from './pages/Watchlist';
import { IpoPage } from './pages/Ipo';
import { OptionsPage } from './pages/Options';
import { FinancialComparePage } from './pages/FinancialCompare';
import { AdvicePage } from './pages/Advice';
import { ChatPage } from './pages/Chat';
import { ActivityPage } from './pages/Activity';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <AgentActivityProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/ipo" element={<IpoPage />} />
          <Route path="/options" element={<OptionsPage />} />
          <Route path="/compare" element={<FinancialComparePage />} />
          <Route path="/advice" element={<AdvicePage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      {/* Outside <Routes> on purpose: the panel must not unmount on navigation. */}
      <AgentActivityDock />
    </AgentActivityProvider>
  );
}
