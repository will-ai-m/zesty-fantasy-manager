import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import Waivers from './pages/Waivers'
import Games from './pages/Games'
import Streaming from './pages/Streaming'
import Plan from './pages/Plan'
import League from './pages/League'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/waivers" replace />} />
        <Route path="/waivers" element={<Waivers />} />
        <Route path="/games" element={<Games />} />
        <Route path="/streaming" element={<Streaming />} />
        <Route path="/plan" element={<Plan />} />
        <Route path="/league" element={<League />} />
        {/* Roster was folded into League and the Planner removed; old links land somewhere real. */}
        <Route path="/roster" element={<Navigate to="/league" replace />} />
        <Route path="*" element={<Navigate to="/waivers" replace />} />
      </Route>
    </Routes>
  )
}
