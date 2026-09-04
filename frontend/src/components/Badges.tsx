import type { ReactNode } from 'react'
import { injuryClass, injuryShort, platformClass, platformLabel, posClass } from '../lib/format'
import type { Player } from '../api'
import { useApp } from './AppContext'

export function Pos({ pos, className = '' }: { pos: string; className?: string }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold leading-none ${posClass[pos] ?? 'bg-stone-100 text-stone-600'} ${className}`}>
      {pos.replace('_FLEX', 'FLX').replace('SUPER', 'S')}
    </span>
  )
}

export function Injury({ status, title }: { status: string | null | undefined; title?: string | null }) {
  if (!status) return null
  return (
    <span title={title ?? status} className={`inline-block rounded px-1 py-0.5 text-[10px] font-semibold leading-none ${injuryClass(status)}`}>
      {injuryShort(status)}
    </span>
  )
}

export function Chip({ children, tone = 'stone', title }: { children: ReactNode; tone?: 'stone' | 'green' | 'red' | 'amber' | 'blue' | 'violet'; title?: string }) {
  const tones = {
    stone: 'bg-stone-100 text-stone-700 border-stone-200',
    green: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    red: 'bg-red-50 text-red-800 border-red-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    blue: 'bg-sky-50 text-sky-800 border-sky-200',
    violet: 'bg-violet-50 text-violet-800 border-violet-200',
  }
  return <span title={title} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-none ${tones[tone]}`}>{children}</span>
}

/** Player name cell: clickable name, team, injury badge, bye marker. */
export function PlayerCell({ p, showPos = false }: { p: Pick<Player, 'player_id' | 'name' | 'team' | 'position' | 'injury_status' | 'injury_body_part' | 'on_bye'>; showPos?: boolean }) {
  const { openPlayer } = useApp()
  return (
    <span className="inline-flex items-center gap-1.5">
      {showPos && <Pos pos={p.position} />}
      <button type="button" onClick={() => openPlayer(p.player_id)} className="font-medium text-stone-900 hover:text-amber-700 hover:underline text-left">
        {p.name}
      </button>
      <span className="text-stone-500 text-[11px]">{p.team ?? 'FA'}</span>
      <Injury status={p.injury_status} title={p.injury_body_part} />
      {p.on_bye && <span className="rounded bg-stone-800 px-1 py-0.5 text-[10px] font-semibold leading-none text-white">BYE</span>}
    </span>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-stone-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-700" />
      {label}
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="m-4 rounded border border-red-200 bg-red-50 p-3 text-red-800">{(error as Error)?.message ?? String(error)}</div>
}

export function PlatformBadge({ platform, className = '' }: { platform: string | undefined; className?: string }) {
  if (!platform) return null
  return <span className={`inline-block rounded px-1 py-0.5 text-[9.5px] font-bold uppercase leading-none tracking-wide ${platformClass[platform] ?? 'bg-stone-100 text-stone-600'} ${className}`}>{platformLabel[platform] ?? platform}</span>
}
