import { Link } from 'react-router-dom'
import { Card, PageHeader, toast } from '@/components/ui'
import { useStore } from '@/store'
import { validateComment } from '@/lib/validate'
import { neisByteLimit } from '@/lib/neis'
import { copyText } from '@/lib/text'
import type { NeisPayload } from '@/lib/types'

const KIND_LABEL: Record<NeisPayload['kind'], string> = { subject: '교과 평어', behavior: '행동특성', creative: '창체' }

function preflight(p: NeisPayload, behaviorBytes: number) {
  const c = { empty: 0, name: 0, chars: 0, bytes: 0, duplicate: 0 }
  const limit = neisByteLimit(p.kind, behaviorBytes)
  p.rows.forEach((row, i) => {
    const others = p.rows.filter((_, j) => j !== i).map((r) => r.text)
    const codes = new Set(validateComment(row.text, { others, ...limit }).map((x) => x.code))
    if (codes.has('empty')) c.empty++
    if (codes.has('name')) c.name++
    if (codes.has('chars')) c.chars++
    if (codes.has('bytes')) c.bytes++
    if (codes.has('duplicate')) c.duplicate++
  })
  return c
}

function Check({ label, n }: { label: string; n: number }) {
  return n === 0 ? (
    <span className="pill lv-0">✓ {label}</span>
  ) : (
    <span className="pill lv-2">{label} {n}</span>
  )
}

function fileDate(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function download(p: NeisPayload) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `neis_${p.kind}_${(p.subject ?? 'all').replace(/[\\/:*?"<>|\s]+/g, '_')}_${fileDate(p.createdAt)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const ORDERS = [
  { tag: '교과', title: '교과 평어', steps: ['교과평가 단계 + 평가결과 자동 입력', '저장', '학기말종합의견 · 교과별 평어 일괄 입력', '저장'] },
  { tag: '행발', title: '행동특성 및 종합의견', steps: ['학생부자료기록 · 번호순 입력', '저장'] },
  { tag: '창체 · 담임', title: '자율·자치 / 진로', steps: ['자율·자치활동 입력', '저장', '학생부자료기록 · "동아리특기사항가져오기"', '진로활동 입력', '저장'] },
  { tag: '창체 · 동아리담임', title: '동아리활동', steps: ['동아리활동관리', '학생부자료기록', '부서 선택 (날짜 선택 없음)', '학생별 특기사항 입력', '저장'] },
]

const BOUNDARIES = [
  { n: '경계 1', when: '생성할 때', body: '번호와 성취수준만 AI에 보냅니다. 학생 이름은 이 앱에 입력하지 않으며 어디로도 전송되지 않습니다.' },
  { n: '경계 2', when: '입력하기 전', body: '확장이 문장을 넣기 전에 이 앱이 이름 의심·허용 외 문자·바이트·중복을 먼저 검사합니다. 위 상태 카드에서 확인하세요.' },
  { n: '경계 3', when: '나이스에서', body: '확장은 성명 열을 읽지 않고 번호만으로 칸을 찾습니다. 서버로 어떤 것도 보내지 않으며 저장 버튼은 단계마다 누릅니다.' },
]

export default function NeisPage() {
  const payloads = useStore((s) => s.neisPayloads)
  const setPayloads = useStore((s) => s.setNeisPayloads)
  const behaviorBytes = useStore((s) => s.settings.behaviorBytes)

  return (
    <>
      <PageHeader eyebrow="STEP 4 · 나이스 자동 입력" title={<>크롬 확장이 나이스 순서대로<br />입력하고 저장까지 누릅니다</>} />
      <p className="m-0 max-w-[720px] text-ink-2 leading-[1.7]">
        확장 프로그램은 이 앱에 저장된 결과를 나이스 화면의 입력칸에 넣고 단계마다 <b>저장</b>을 눌러 줍니다. 성명 열은 읽지 않고 번호로만 학생을 찾으며, 어떤 서버와도 통신하지 않습니다.
      </p>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {ORDERS.map((o) => (
          <Card key={o.tag} className="p-5">
            <div className="eyebrow mb-1">{o.tag}</div>
            <h3 className="m-0 mb-3 text-[16px] font-bold">{o.title}</h3>
            <ol className="m-0 p-0 list-none flex flex-col gap-2">
              {o.steps.map((s, i) => (
                <li key={i} className="flex gap-2.5 items-start text-[13px] text-ink-2">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-ink text-white text-[11px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </Card>
        ))}
      </div>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="m-0 text-[18px] font-bold">보낼 데이터 <span className="text-muted font-normal text-[14px]">{payloads.length}건</span></h2>
        </div>
        {payloads.length === 0 ? (
          <div className="rounded-[14px] bg-surface-2 px-5 py-8 text-center">
            <p className="m-0 mb-3 text-ink-2">아직 보낼 데이터가 없습니다 — 결과 페이지에서 '나이스로 보내기'를 누르면 여기 쌓입니다</p>
            <div className="flex justify-center gap-2">
              <Link to="/results" className="btn btn-sm">교과 결과로</Link>
              <Link to="/behavior" className="btn btn-sm">행동특성으로</Link>
            </div>
          </div>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-3">
            {payloads.map((p, idx) => {
              const c = preflight(p, behaviorBytes)
              const limit = neisByteLimit(p.kind, behaviorBytes).maxBytes
              return (
                <li key={`${p.kind}-${p.subject ?? ''}-${idx}`} className="rounded-[14px] bg-surface-2 px-5 py-4 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <div className="min-w-[200px] flex-1">
                    <div className="flex items-center gap-2">
                      <span className="pill bg-ink text-white">{KIND_LABEL[p.kind]}</span>
                      <b className="text-[15px]">{p.subject ?? '전체'}</b>
                    </div>
                    <div className="text-[12px] text-muted mt-1">{p.rows.length}행 · {new Date(p.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.empty > 0 && <Check label="빈 문장" n={c.empty} />}
                    <Check label="이름 의심" n={c.name} />
                    <Check label="허용 외 문자" n={c.chars} />
                    {limit !== undefined && <Check label={`바이트 초과(${limit}B 참고)`} n={c.bytes} />}
                    <Check label="중복 문장" n={c.duplicate} />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-sm" onClick={async () => toast((await copyText(JSON.stringify(p, null, 2))) ? 'JSON을 복사했습니다' : '복사하지 못했습니다. "JSON 내려받기"를 쓰세요.')}>JSON 복사</button>
                    <button type="button" className="btn btn-sm" onClick={() => download(p)}>JSON 내려받기</button>
                    <button type="button" className="btn btn-sm" onClick={() => setPayloads(payloads.filter((_, j) => j !== idx))}>삭제</button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <div className="eyebrow mb-1">INSTALL</div>
        <h2 className="m-0 mb-4 text-[18px] font-bold">크롬 확장 설치 (준비 중)</h2>
        <ol className="m-0 p-0 list-none flex flex-col gap-3">
          <li className="flex gap-3 items-start">
            <span className="shrink-0 w-6 h-6 rounded-full bg-accent text-white text-[12px] font-bold flex items-center justify-center">1</span>
            <div className="flex flex-wrap items-center gap-3">
              <span>크롬 웹스토어에서 "AI 생기부 보조 생성기 → 나이스" 설치</span>
              <button type="button" className="btn btn-sm" disabled>웹스토어 열기 (출시 전)</button>
            </div>
          </li>
          <li className="flex gap-3 items-start"><span className="shrink-0 w-6 h-6 rounded-full bg-accent text-white text-[12px] font-bold flex items-center justify-center">2</span><span>나이스 로그인 후 해당 화면 조회</span></li>
          <li className="flex gap-3 items-start"><span className="shrink-0 w-6 h-6 rounded-full bg-accent text-white text-[12px] font-bold flex items-center justify-center">3</span><span>확장 아이콘 → 데이터 확인 → 자동 입력</span></li>
        </ol>
        <p className="m-0 mt-4 text-[13px] text-muted">확장은 이 앱이 브라우저(localStorage)에 저장한 데이터를 읽기만 하며, 서버와 통신하지 않습니다.</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {BOUNDARIES.map((b) => (
          <Card key={b.n} className="p-5">
            <div className="eyebrow mb-1">{b.n}</div>
            <h3 className="m-0 mb-2 text-[16px] font-bold">{b.when}</h3>
            <p className="m-0 text-[13px] text-ink-2 leading-[1.65]">{b.body}</p>
          </Card>
        ))}
      </div>
    </>
  )
}
