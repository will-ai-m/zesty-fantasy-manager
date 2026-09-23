import { useQuery } from '@tanstack/react-query'
import { api, type PlanAdd, type PlanClaim, type PlanLeague, type RosterPlayer } from '../api'
import { ErrorBox, LeagueBar, PlatformBadge, PlayerCell, Pos, Spinner } from '../components/Badges'

const dot = <span className="text-stone-300">·</span>
const ROSTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const

/** What a planned move still asks of you, read off the rosters rather than stored — the same rule
 * the streaming board uses, so the two pages never disagree. */
function status(st: PlanAdd['standing']): { label: string; tone: string; tip: string } {
  if (st.status === 'mine') return { label: 'done', tone: 'bg-sky-600 text-white', tip: 'Already on your roster — nothing left to do.' }
  if (st.status === 'taken') return { label: 'gone', tone: 'bg-red-100 text-red-800', tip: `Rostered by ${st.owner} now — this one is off.` }
  if (st.status === 'waivers') return { label: 'claim', tone: 'border border-amber-300 bg-amber-50 text-amber-800', tip: 'On waivers — put a claim in.' }
  return { label: 'add', tone: 'border border-emerald-300 bg-emerald-50 text-emerald-800', tip: 'Free agent — add him.' }
}

function Panel({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 flex items-baseline gap-1.5 text-[10px] font-bold uppercase tracking-wide text-stone-400">
        {title}{count != null && <span className="font-medium text-stone-400">{count}</span>}
        {hint && <span className="font-medium normal-case tracking-normal text-stone-400">{hint}</span>}
      </h3>
      {children}
    </div>
  )
}

/** One planned move: the player, what it still takes, and what it costs or replaces. */
function Move({ row, note }: { row: PlanAdd | PlanClaim; note?: React.ReactNode }) {
  const s = status(row.standing)
  const gain = row.standing.status === 'free' || row.standing.status === 'waivers' ? row.standing.vs_mine : null
  return (
    <li className="flex flex-wrap items-center gap-1.5 py-0.5 text-[12px]">
      <span title={s.tip} className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none ${s.tone}`}>{s.label}</span>
      <PlayerCell p={row} showPos />
      {gain != null && (
        <span title="Places above the player of yours he would replace, on FantasyPros' rest-of-season ranking"
              className={`text-[11px] tabular-nums ${gain > 0 ? 'font-semibold text-emerald-700' : 'text-stone-400'}`}>{gain > 0 ? '+' : ''}{gain}</span>
      )}
      {note}
    </li>
  )
}

function LeagueCard({ lg, week }: { lg: PlanLeague; week: number }) {
  const active = lg.roster.filter((r) => r.slot !== 'IR' && r.slot !== 'TAXI')
  const groups = ROSTER_ORDER
    .map((pos) => [pos, active.filter((r) => r.position === pos).sort((a, b) => (a.fp_ros_ecr ?? 9999) - (b.fp_ros_ecr ?? 9999))] as const)
    .filter(([, rows]) => rows.length)
  const stashed = lg.roster.filter((r) => r.slot === 'IR' || r.slot === 'TAXI')
  const faab = lg.waiver.type_code === 2 ? lg.my_team?.faab_remaining ?? 0 : null
  const spent = lg.claims.reduce((n, c) => n + (c.bid ?? 0), 0)
  const todo = [...lg.adds, ...lg.claims].filter((m) => m.standing.status === 'free' || m.standing.status === 'waivers').length

  const Row = ({ r }: { r: RosterPlayer }) => (
    <li className="flex items-center gap-1.5 py-0.5 text-[12px]">
      <span className="w-10 shrink-0"><Pos pos={r.slot} /></span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"><PlayerCell p={r} /></span>
      <span className="w-9 shrink-0 text-right tabular-nums text-stone-500">{r.fp_ros_pos_rank ?? dot}</span>
    </li>
  )

  return (
    <section className="rounded-md border border-stone-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 py-2 pl-2 pr-3">
        <h2 className="flex items-stretch gap-2 self-stretch text-[13px] font-semibold">
          <LeagueBar leagueId={lg.league_id} />
          <span className="flex items-center gap-2"><PlatformBadge platform={lg.platform} />{lg.name}</span>
        </h2>
        {lg.my_team?.team_name && <span className="text-[11.5px] text-stone-500">{lg.my_team.team_name}</span>}
        <span className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <span className={`rounded px-1.5 py-0.5 ${todo ? 'bg-amber-100 font-semibold text-amber-900' : 'bg-stone-100 text-stone-500'}`}>
            {todo ? `${todo} move${todo === 1 ? '' : 's'} to make` : 'nothing to do'}
          </span>
          <span className={`rounded px-1.5 py-0.5 ${lg.spots.open ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-500'}`}>{lg.spots.open ? `${lg.spots.open} open` : 'roster full'}</span>
          {lg.spots.empty_starts.length > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 font-semibold text-red-800">{lg.spots.empty_starts.join(', ')} empty</span>}
          {faab != null && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">${faab} FAAB{spent ? ` · $${spent} planned` : ''}</span>}
        </span>
      </div>

      <div className="grid gap-x-5 gap-y-3 px-3 py-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Roster" hint={`week ${week} · ROS rank`}>
          <div className="space-y-1">
            {groups.map(([pos, rows]) => <ul key={pos}>{rows.map((r) => <Row key={r.player_id} r={r} />)}</ul>)}
            {stashed.length > 0 && <ul className="opacity-70">{stashed.map((r) => <Row key={r.player_id} r={r} />)}</ul>}
          </div>
        </Panel>

        <Panel title="Streaming adds" count={lg.adds.length} hint="D/ST and K picks that still need a move">
          {lg.adds.length === 0
            ? <p className="text-[11.5px] text-stone-400">Nothing to add — your picks are on the roster, or you have not made any.</p>
            : <ul>{lg.adds.map((a) => (
                <Move key={a.player_id} row={a}
                      note={a.replaces ? <span className="text-[11px] text-stone-400">over {a.replaces.name}</span>
                                       : <span className="text-[11px] text-stone-400">{lg.spots.empty_starts.includes(a.slot) ? `${a.slot} slot is empty` : `no ${a.slot} rostered`}</span>} />
              ))}</ul>}
        </Panel>

        <Panel title="Waiver plan" count={lg.claims.length} hint="planned on the waivers page">
          {lg.claims.length === 0
            ? <p className="text-[11.5px] text-stone-400">No claims planned. Click a league's FA or W cell on the Waivers page.</p>
            : <ul>{lg.claims.map((c) => (
                <Move key={c.player_id} row={c} note={
                  <span className="flex items-center gap-1.5 text-[11px] text-stone-400">
                    {c.bid != null && <span className="font-semibold text-emerald-800">${c.bid}</span>}
                    {c.drop ? <span>drop {c.drop.name}</span> : lg.spots.open > 0 ? <span>into an open spot</span> : <span className="text-amber-700">needs a drop</span>}
                  </span>
                } />
              ))}</ul>}
        </Panel>
      </div>
    </section>
  )
}

/** Everything you mean to do, league by league — the page you work through when you go and make
 * the moves. Each league shows the roster as it stands, the streaming picks that still need a
 * move (the ones already on the roster are done and left out), and the claims planned on the
 * waivers page with their bid and drop. Nothing here is submitted anywhere: every platform is
 * read-only to this app, so the moves are yours to make, and each row says whether it is still
 * outstanding, done, or gone to somebody else. */
export default function Plan() {
  const { data, isLoading, error } = useQuery({ queryKey: ['plan'], queryFn: () => api.plan(), staleTime: 60_000 })
  const todo = (data?.leagues ?? []).reduce((n, lg) => n + [...lg.adds, ...lg.claims].filter((m) => m.standing.status === 'free' || m.standing.status === 'waivers').length, 0)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-base font-semibold">Plan · all leagues</h1>
        {data && (
          <span className="ml-auto text-[12px] text-stone-500">
            Week {data.week} · {todo ? `${todo} move${todo === 1 ? '' : 's'} to make` : 'nothing outstanding'} — make them on the platform, and they tick themselves off
          </span>
        )}
      </div>
      {isLoading && <Spinner label="Gathering your rosters, picks and claims…" />}
      {error && <ErrorBox error={error} />}
      {data?.leagues.map((lg) => <LeagueCard key={lg.league_id} lg={lg} week={data.week} />)}
    </div>
  )
}
