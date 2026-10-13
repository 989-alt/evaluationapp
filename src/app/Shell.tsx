import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Modal, Toast } from '@/components/ui'
import { useStore } from '@/store'
import { Link } from 'react-router-dom'

const Icon = {
  settings: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  plan: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>,
  pen: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" /></svg>,
  person: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
  layers: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>,
  send: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12h12M12 6l6 6-6 6" /><path d="M20 4v16" /></svg>,
  help: <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14M12 17h.01" /></svg>,
}

const NAV = [
  { to: '/settings', label: '설정', icon: Icon.settings },
  { to: '/plan', label: '평가계획', icon: Icon.plan },
  { to: '/comments', label: '평어 생성', icon: Icon.pen, match: ['/comments', '/grades', '/results'] },
  { to: '/behavior', label: '행발', icon: Icon.person },
  { to: '/creative', label: '창체', icon: Icon.layers },
  { to: '/neis', label: '나이스 입력', icon: Icon.send },
]

export default function Shell() {
  const loc = useLocation()
  const guideSeen = useStore((s) => s.settings.guideSeen)
  const setSettings = useStore((s) => s.setSettings)
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    if (!guideSeen && loc.pathname !== '/guide') setWelcome(true)
  }, [guideSeen, loc.pathname])
  const closeWelcome = () => {
    setSettings({ guideSeen: true })
    setWelcome(false)
  }

  return (
    <div className="min-h-full flex">
      <aside className="w-[84px] shrink-0 bg-rail flex flex-col items-center gap-2 py-5 sticky top-0 h-screen">
        <Link to="/" aria-label="홈" className="w-11 h-11 rounded-[14px] bg-ink text-white flex items-center justify-center font-bold text-[15px] mb-4">生</Link>
        {NAV.map((n) => {
          const active = (n.match ?? [n.to]).some((m) => loc.pathname.startsWith(m))
          return (
            <NavLink key={n.to} to={n.to} aria-label={n.label} title={n.label} className={`w-12 h-12 rounded-2xl flex items-center justify-center transition ${active ? 'bg-ink text-white' : 'bg-surface text-ink hover:bg-white'}`}>
              {n.icon}
            </NavLink>
          )
        })}
        <span className="flex-1" />
        <NavLink to="/guide" aria-label="도움말" title="도움말" className={`w-12 h-12 rounded-2xl flex items-center justify-center transition ${loc.pathname === '/guide' ? 'bg-ink text-white' : 'bg-surface text-ink hover:bg-white'}`}>
          {Icon.help}
        </NavLink>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="max-w-[1196px] mx-auto px-6 md:px-12 py-10 flex flex-col gap-7">
          <Outlet />
        </div>
      </main>
      <Toast />
      <Modal open={welcome} onClose={closeWelcome}>
        <div className="eyebrow mb-2">처음 오셨나요?</div>
        <h2 className="h1 !text-[28px] mb-3">평가계획 한 장이면<br />한 학기 평어가 나이스까지 갑니다</h2>
        <p className="text-muted mb-5">설정(API 키) → 평가계획 PDF 업로드 → 성적 입력 → 평어 생성 → 나이스 입력 순서입니다. 각 단계의 화면 설명이 도움말에 있습니다.</p>
        <div className="flex gap-2 justify-end">
          <button className="btn" onClick={closeWelcome}>바로 시작</button>
          <Link to="/guide" className="btn-primary" onClick={closeWelcome}>사용 설명서 보기</Link>
        </div>
      </Modal>
    </div>
  )
}
