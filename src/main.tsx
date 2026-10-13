import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'
import Shell from './app/Shell'
import SettingsPage from './pages/SettingsPage'
import PlanPage from './pages/PlanPage'
import CommentsPage from './pages/CommentsPage'
import GradesPage from './pages/GradesPage'
import ResultsPage from './pages/ResultsPage'
import BehaviorPage from './pages/BehaviorPage'
import CreativePage from './pages/CreativePage'
import NeisPage from './pages/NeisPage'
import GuidePage from './pages/GuidePage'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/plan" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/comments" element={<CommentsPage />} />
          <Route path="/grades" element={<GradesPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/behavior" element={<BehaviorPage />} />
          <Route path="/creative" element={<CreativePage />} />
          <Route path="/neis" element={<NeisPage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="*" element={<Navigate to="/plan" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
)
