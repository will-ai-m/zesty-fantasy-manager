import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import Waivers from './pages/Waivers'
import Trends from './pages/Trends'
import Games from './pages/Games'
import Roster from './pages/Roster'
import League from './pages/League'
import Planner from './pages/Planner'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/waivers" replace />} />
        <Route path="/waivers" element={<Waivers />} />
        <Route path="/trends" element={<Trends />} />
        <Route path="/games" element={<Games />} />
        <Route path="/roster" element={<Roster />} />
        <Route path="/league" element={<League />} />
        <Route path="/planner" element={<Planner />} />
      </Route>
    </Routes>
  )
}
