import { useMemo, useState, type ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  sort?: (row: T) => number | string | null | undefined
  align?: 'left' | 'right' | 'center'
  title?: string
  /** first click sorts descending (numbers) */
  desc?: boolean
  className?: string
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  rowClass?: (row: T) => string
  empty?: ReactNode
  maxHeight?: string
}

function cmp(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === ''
  const bn = b === null || b === undefined || b === ''
  if (an && bn) return 0
  if (an) return 1
  if (bn) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

export function DataTable<T>({ rows, columns, rowKey, initialSort, rowClass, empty = 'Nothing to show.', maxHeight = 'calc(100vh - 220px)' }: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sort) return rows
    const withIdx = rows.map((r, i) => ({ r, i, v: col.sort!(r) }))
    withIdx.sort((x, y) => {
      // nulls always last regardless of direction
      const xn = x.v === null || x.v === undefined || x.v === ''
      const yn = y.v === null || y.v === undefined || y.v === ''
      if (xn && yn) return x.i - y.i
      if (xn) return 1
      if (yn) return -1
      const c = cmp(x.v, y.v)
      return (sort.dir === 'asc' ? c : -c) || x.i - y.i
    })
    return withIdx.map((x) => x.r)
  }, [rows, sort, columns])

  const toggle = (col: Column<T>) => {
    if (!col.sort) return
    setSort((s) => {
      if (s?.key === col.key) return { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      return { key: col.key, dir: col.desc ? 'desc' : 'asc' }
    })
  }

  return (
    <div className="overflow-auto rounded-md border border-stone-200 bg-white" style={{ maxHeight }}>
      <table className="data w-full border-collapse">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.title}
                onClick={() => toggle(c)}
                className={`${c.sort ? 'cursor-pointer hover:bg-stone-200' : ''} ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'} ${c.className ?? ''}`}
              >
                <span className="inline-flex items-center gap-1">
                  {c.header}
                  {sort?.key === c.key && <span className="text-stone-400">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="p-6 text-center text-stone-500">{empty}</td>
            </tr>
          )}
          {sorted.map((row) => (
            <tr key={rowKey(row)} className={rowClass?.(row)}>
              {columns.map((c) => (
                <td key={c.key} className={`${c.align === 'right' ? 'text-right num' : c.align === 'center' ? 'text-center' : ''} ${c.className ?? ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
