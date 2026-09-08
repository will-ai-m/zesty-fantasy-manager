import { useEffect, useState } from 'react'
import type { FpRanks, LineupSlot, NewsItem, Player, Target, WaiverClock } from '../api'
import { countdown, dayTime, fmt, NEWS_TONE, timeAgo } from '../lib/format'
import { Chip, Injury, PlayerCell, Pos } from './Badges'

/** FantasyPros position rank + tier, the way the site writes it. */
export function FpRank({ fp, kind = 'week' }: { fp: FpRanks | null | undefined; kind?: 'week' | 'ros' }) {
  if (!fp) return <span className="text-stone-300">—</span>
  const rank = kind === 'ros' ? fp.ros_pos_rank_label : fp.pos_rank
  const tier = kind === 'ros' ? fp.ros_tier : fp.tier
  const delta = kind === 'ros' ? fp.ros_ecr_delta : fp.ecr_delta
  if (!rank) return <span className="text-stone-300">—</span>
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="font-medium">{rank}</span>
      {tier != null && <span className="text-[10px] text-stone-400" title={`Tier ${tier}`}>T{tier}</span>}
      {delta != null && delta !== 0 && (
        <span className={`text-[10px] ${delta < 0 ? 'text-emerald-600' : 'text-red-600'}`} title="Change in expert consensus rank">
          {delta < 0 ? '▲' : '▼'}{Math.abs(delta)}
        </span>
      )}
    </span>
  )
}

/** 0–100 claim priority with its reasoning behind the hover. */
export function PriorityBadge({ target }: { target: Target }) {
  const score = target.priority.score
  const tone = score >= 70 ? 'bg-emerald-600' : score >= 45 ? 'bg-amber-500' : 'bg-stone-400'
  return (
    <span className="inline-flex items-center gap-1.5" title={target.priority.why.join(' · ')}>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-stone-200">
        <span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, score)}%` }} />
      </span>
      <span className="num text-[11px] font-semibold text-stone-700">{score}</span>
    </span>
  )
}

export function Bid({ target }: { target: Target }) {
  if (!target.faab) return <span className="text-stone-300">—</span>
  const { low, mid, high, basis, comparables } = target.faab
  const comps = comparables.length ? ` · like ${comparables.map((c) => `${c.name} $${c.bid}`).join(', ')}` : ''
  return (
    <span title={`${basis}${comps}`} className="whitespace-nowrap">
      <span className="font-semibold">${mid}</span>
      <span className="ml-1 text-[10px] text-stone-500">${low}–{high}</span>
    </span>
  )
}

/** Re-renders on a timer so a countdown actually counts down. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function ClockBar({ clock, faab }: { clock: WaiverClock; faab?: { budget: number; remaining: number; pace: number } }) {
  const now = useNow()
  const soon = clock.next_run != null && clock.next_run - now < 6 * 3600_000
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <Chip tone={soon ? 'red' : 'amber'} title={`Waivers run ${clock.label} (${clock.timezone})`}>
        Waivers in <span className="font-semibold">{countdown(clock.next_run)}</span>
        <span className="text-stone-500">· {dayTime(clock.next_run, clock.timezone)}</span>
      </Chip>
      <span className="text-stone-500">{clock.label}</span>
      {faab && faab.budget > 0 && (
        <Chip title={`Bid pace ×${faab.pace}: how much of your budget is left against how much of the season is`}>
          ${faab.remaining} of ${faab.budget} FAAB{faab.pace !== 1 ? ` · pace ×${faab.pace}` : ''}
        </Chip>
      )}
    </div>
  )
}

export function LineupMove({ move }: { move: LineupSlot }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1">
      <Pos pos={move.slot} />
      {move.current ? <PlayerCell p={move.current} /> : <span className="text-red-600">Empty</span>}
      <span className="text-stone-400">→</span>
      {move.suggested ? <PlayerCell p={move.suggested} /> : <span className="text-stone-400">nobody</span>}
      {move.reason && <span className="text-[11px] text-stone-500">{move.reason}</span>}
      {move.locked && <Chip tone="stone">locked</Chip>}
    </li>
  )
}

export function Availability({ leagues }: { leagues: NewsItem['leagues'] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {leagues.map((l) => (
        <Chip key={l.league_id} tone={l.status === 'free' ? 'green' : l.status === 'mine' ? 'blue' : 'stone'}
          title={l.status === 'owned' ? `Rostered by ${l.owner}` : l.status === 'mine' ? 'On your roster' : 'Available'}>
          {l.league_name}: {l.status === 'free' ? 'free' : l.status === 'mine' ? 'yours' : l.owner}
        </Chip>
      ))}
    </span>
  )
}

export function NewsCard({ item, onPlan, onSeen }: { item: NewsItem; onPlan?: (leagueId: string, add: Player) => void; onSeen?: (key: string, seen: boolean) => void }) {
  return (
    <article className={`rounded-md border p-3 ${item.seen ? 'border-stone-200 bg-stone-50/60' : 'border-stone-200 bg-white'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={NEWS_TONE[item.category] ?? 'stone'}>{item.category}</Chip>
        <PlayerCell p={item.player} showPos />
        {item.mine && <Chip tone="blue">yours</Chip>}
        <span className="ml-auto text-[11px] text-stone-500">{item.source} · {timeAgo(item.published)}</span>
        {onSeen && (
          <button onClick={() => onSeen(item.key, !item.seen)} title={item.seen ? 'Mark as new again' : 'Mark as handled'}
            className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-600 hover:bg-stone-50">
            {item.seen ? 'Unread' : 'Done'}
          </button>
        )}
      </div>
      <h3 className="mt-1.5 font-medium text-stone-900">{item.title}</h3>
      {item.description && <p className="mt-0.5 text-[12px] text-stone-700">{item.description}</p>}
      {item.analysis && <p className="mt-1 text-[12px] text-stone-500">{item.analysis}</p>}
      <div className="mt-1.5"><Availability leagues={item.leagues} /></div>

      {item.beneficiaries.length > 0 && (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50/60 p-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">Next in line</div>
          <ul className="mt-1 space-y-1">
            {item.beneficiaries.map((b) => {
              const free = b.leagues.filter((l) => l.status === 'free')
              return (
                <li key={b.player_id} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <PlayerCell p={b.player} showPos />
                  <span className="text-stone-500">{b.reason}</span>
                  <span className="text-stone-500">ROS {fmt(b.player.proj_ros, 0)}</span>
                  <FpRank fp={b.player.fp} kind="ros" />
                  <Availability leagues={b.leagues} />
                  {onPlan && free.map((l) => (
                    <button key={l.league_id} onClick={() => onPlan(l.league_id, b.player)}
                      className="rounded border border-stone-300 px-2 py-0.5 text-[11px] hover:border-amber-400 hover:bg-amber-50">
                      Plan in {l.league_name}
                    </button>
                  ))}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {item.player.injury_status && (
        <div className="mt-1.5 text-[11px] text-stone-500">
          Status <Injury status={item.player.injury_status} title={item.player.injury_body_part} /> {item.player.injury_body_part}
        </div>
      )}
    </article>
  )
}
