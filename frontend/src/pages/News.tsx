import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type NewsItem } from '../api'
import { useApp } from '../components/AppContext'
import { Chip, ErrorBox, Spinner } from '../components/Badges'
import { NewsCard } from '../components/Weekly'

const FILTERS = [
  { key: 'action', label: 'Needs a move', hint: 'Unhandled news about your players, or an injury that opens up somebody you could claim' },
  { key: 'mine', label: 'My players', hint: 'Anything about a player on one of your rosters' },
  { key: 'all', label: 'Everything', hint: 'Every story fetched, including handled ones' },
] as const

export default function News() {
  const { openPlan } = useApp()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['news'], queryFn: () => api.news(), staleTime: 60_000 })
  const mark = useMutation({
    mutationFn: ({ key, seen }: { key: string; seen: boolean }) => api.markNews([key], seen),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['news'] }),
  })
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('action')

  const items = useMemo(() => {
    const all = data?.items ?? []
    if (filter === 'all') return all
    if (filter === 'mine') return all.filter((i) => i.mine)
    return all.filter((i: NewsItem) => !i.seen && (i.mine || i.beneficiaries.some((b) => b.leagues.some((l) => l.status === 'free'))))
  }, [data, filter])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-base font-semibold">Player news</h1>
        {data && <Chip tone={data.unseen ? 'red' : 'stone'}>{data.unseen} unhandled</Chip>}
        <div className="flex rounded-md border border-stone-200 bg-white p-0.5">
          {FILTERS.map((f) => (
            <button key={f.key} title={f.hint} onClick={() => setFilter(f.key)}
              className={`rounded px-2.5 py-1 text-[12px] ${filter === f.key ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-100'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-stone-500">
          {items.length} shown · RotoWire, FantasyPros and RotoBaller via Sleeper
        </span>
      </div>

      {data?.errors?.length ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">News feed trouble: {data.errors.join('; ')}</div>
      ) : null}

      {isLoading && <Spinner label="Fetching news for every player who matters to you…" />}
      {error && <ErrorBox error={error} />}
      {data && items.length === 0 && (
        <p className="rounded-md border border-stone-200 bg-white p-6 text-center text-[13px] text-stone-500">
          Nothing needing a decision. {filter === 'action' && data.items.length > 0 && 'Switch to “Everything” for the full feed.'}
        </p>
      )}
      <div className="space-y-2">
        {items.map((item) => (
          <NewsCard key={`${item.key}-${item.player_id}`} item={item}
            onSeen={(key, seen) => mark.mutate({ key, seen })}
            onPlan={(leagueId, add) => openPlan({ leagueId, add })} />
        ))}
      </div>
    </div>
  )
}
