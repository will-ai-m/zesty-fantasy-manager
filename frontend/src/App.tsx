import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import Week from './pages/Week'
import Board from './pages/Board'
import Lineup from './pages/Lineup'
import News from './pages/News'
import Waivers from './pages/Waivers'
import Trends from './pages/Trends'
import Roster from './pages/Roster'
import League from './pages/League'
import Planner from './pages/Planner'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/week" replace />} />
        <Route path="/week" element={<Week />} />
        <Route path="/board" element={<Board />} />
        <Route path="/lineup" element={<Lineup />} />
        <Route path="/news" element={<News />} />
        <Route path="/waivers" element={<Waivers />} />
        <Route path="/trends" element={<Trends />} />
        <Route path="/roster" element={<Roster />} />
        <Route path="/league" element={<League />} />
        <Route path="/planner" element={<Planner />} />
      </Route>
    </Routes>
  )
}
