import { useEffect, useState, type ReactNode } from 'react'
import { LEVEL_NAMES, LEVEL_SHORT, type Level } from '@/lib/types'
import { copyText } from '@/lib/text'
import type { Issue } from '@/lib/validate'
import { useStore } from '@/store'

export function PageHeader({ eyebrow, title, aside }: { eyebrow: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="eyebrow mb-2">{eyebrow}</div>
        <h1 className="h1">{title}</h1>
      </div>
      {aside}
    </div>
  )
}

export function Card({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`card ${className}`}>{children}</section>
}

export function LevelPill({ level, long = false }: { level: Level; long?: boolean }) {
  return <span className={`pill lv-${level}`}>{long ? LEVEL_NAMES[level] : LEVEL_SHORT[level]}</span>
}

export function Alert({ kind = 'warn', children }: { kind?: 'warn' | 'error' | 'ok' | 'info'; children: ReactNode }) {
  const cls = kind === 'error' ? 'lv-3' : kind === 'ok' ? 'lv-0' : kind === 'info' ? 'lv-1' : 'lv-2'
  return <div className={`rounded-[12px] px-3.5 py-3 text-[13px] ${cls}`}>{children}</div>
}

export function Progress({ value, label }: { value: number; label?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="flex-1 h-1.5 rounded-full bg-ground overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      {label && <span className="text-[13px] text-ink-2 whitespace-nowrap">{label}</span>}
    </div>
  )
}

let toastTimer: number | undefined
export function Toast() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    const h = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail)
      window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => setMsg(null), 1800)
    }
    window.addEventListener('app-toast', h)
    return () => window.removeEventListener('app-toast', h)
  }, [])
  return <div className={`toast ${msg ? 'show' : ''}`}>{msg}</div>
}
export const toast = (msg: string) => window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }))

/** Click-to-copy text block; turns red once copied */
export function CopyText({ id, text, className = '', as = 'button' }: { id: string; text: string; className?: string; as?: 'button' | 'div' }) {
  const copied = useStore((s) => !!s.copied[id])
  const mark = useStore((s) => s.markCopied)
  const onClick = async () => {
    if (!(await copyText(text))) return toast('복사하지 못했습니다. 문장을 직접 선택해 복사해 주세요.')
    mark(id)
    toast('복사되었습니다')
  }
  const cls = `text-left w-full rounded-[14px] px-4 py-3 bg-surface-2 cursor-pointer leading-[1.65] hover:bg-ground transition ${copied ? 'text-copied font-medium' : 'text-ink'} ${className}`
  if (as === 'div') return <div onClick={onClick} className={cls}>{text}</div>
  return (
    <button type="button" onClick={onClick} className={cls} title="클릭하면 복사됩니다">
      {text}
      {copied && <span className="ml-2 text-[11px] font-bold">복사됨</span>}
    </button>
  )
}

export function Spinner({ dark = false }: { dark?: boolean }) {
  return <span className={`spinner ${dark ? 'dark' : ''}`} />
}

export function Modal({ open, onClose, children, wide = false }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className={`card w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} max-h-[90vh] overflow-auto p-6`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

/** 검사 결과 목록. 문제가 없으면 "검사 통과" */
export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <span className="font-bold text-lv0-ink">검사 통과</span>
  return (
    <>
      {issues.map((it, i) => (
        <span key={i} className={`font-bold ${it.level === 'error' ? 'text-lv3-ink' : 'text-lv2-ink'}`}>{it.message}</span>
      ))}
    </>
  )
}

/** 머리말 오른쪽의 큰 숫자 */
export function Stat({ label, value, of, cls = '' }: { label: string; value: number; of?: number; cls?: string }) {
  return (
    <div className="flex flex-col min-w-[64px]">
      <div className={`text-[30px] font-light leading-none tracking-[-0.02em] ${cls}`}>
        {value}
        {of !== undefined && <span className="text-[16px] text-muted-2"> / {of}</span>}
      </div>
      <div className="text-[12px] text-muted mt-1.5">{label}</div>
    </div>
  )
}
