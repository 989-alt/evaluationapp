import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Card, PageHeader, Spinner, toast } from '@/components/ui'
import { useStore, modelsByTier } from '@/store'
import { detectProvider, listModels, PROVIDER_LABEL, PROVIDER_PDF } from '@/llm/provider'
import type { ModelInfo, Provider } from '@/lib/types'

const TIER_LABEL: Record<NonNullable<ModelInfo['tier']>, string> = { recommended: '권장', fast: '빠름 · 저렴', best: '최고 품질 · 느림', other: '나머지' }
const TIER_PILL: Record<NonNullable<ModelInfo['tier']>, string> = { recommended: 'bg-ink text-white', fast: 'lv-0', best: 'lv-2', other: 'bg-ground text-muted' }

export default function SettingsPage() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const resetAll = useStore((s) => s.resetAll)
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState<Provider | null>(null)

  const provider = settings.provider

  const onKey = (v: string) => {
    const p = detectProvider(v)
    setSettings({ apiKey: v.trim(), provider: p ?? manual, models: p === settings.provider ? settings.models : [], model: p === settings.provider ? settings.model : '' })
    setError('')
  }

  const refresh = async (p = provider) => {
    if (!settings.apiKey || !p) return
    setLoading(true)
    setError('')
    try {
      const models = await listModels(p, settings.apiKey)
      const rec = models.find((m) => m.tier === 'recommended') ?? models[0]
      const keep = models.find((m) => m.id === settings.model)
      setSettings({ provider: p, models, model: keep?.id ?? rec?.id ?? '' })
      toast(`${PROVIDER_LABEL[p]} · 모델 ${models.length}개 확인`)
    } catch (e: any) {
      setError(e.message ?? String(e))
      setSettings({ models: [] })
    } finally {
      setLoading(false)
    }
  }

  const tiers = modelsByTier(settings.models)
  const Group = ({ k }: { k: keyof typeof tiers }) =>
    tiers[k].length ? (
      <>
        <div className="px-4 pt-3 pb-1 text-[12px] font-bold text-muted">{TIER_LABEL[k]}</div>
        {tiers[k].map((m) => (
          <label key={m.id} className={`grid grid-cols-[20px_1fr_auto] gap-3.5 items-center px-4 py-3 rounded-[14px] cursor-pointer ${settings.model === m.id ? 'bg-ground border-[1.5px] border-ink' : 'border-[1.5px] border-transparent hover:bg-ground'}`}>
            <input type="radio" name="model" checked={settings.model === m.id} onChange={() => setSettings({ model: m.id })} className="w-4 h-4 accent-ink" />
            <span className="min-w-0">
              <span className="font-bold break-all">{m.id}</span>
              {m.note && <span className="block text-[12px] text-muted">{m.note}</span>}
            </span>
            <span className={`pill ${TIER_PILL[m.tier ?? 'other']}`}>{TIER_LABEL[m.tier ?? 'other']}</span>
          </label>
        ))}
      </>
    ) : null

  return (
    <>
      <PageHeader
        eyebrow="STEP 0 · 설정"
        title={<>처음 한 번만 설정하면<br />다음부터는 바로 시작합니다</>}
        aside={<p className="m-0 max-w-[360px] text-muted">API 키는 이 브라우저에만 저장되고 어떤 서버로도 가지 않습니다. 키를 붙여넣으면 제공사를 알아보고 쓸 수 있는 모델을 보여줍니다.</p>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 flex flex-col gap-5">
          <Card className="p-6 flex flex-col gap-3.5">
            <Step n={1} title="API 키" />
            <label className="flex flex-col gap-2">
              <span className="text-[13px] text-muted">키 붙여넣기</span>
              <span className="flex gap-2">
                <input type={show ? 'text' : 'password'} value={settings.apiKey} onChange={(e) => onKey(e.target.value)} placeholder="AIza… / sk-ant-… / sk-…" className="field font-mono" autoComplete="off" spellCheck={false} />
                <button type="button" className="btn" onClick={() => setShow((v) => !v)}>{show ? '숨기기' : '보기'}</button>
              </span>
            </label>
            {settings.apiKey && provider && (
              <div className="flex flex-wrap items-center gap-3">
                <Alert kind={settings.models.length ? 'ok' : 'info'}>
                  <strong>{PROVIDER_LABEL[provider]}</strong> 키로 인식{settings.models.length ? ` · 연결 확인 · 사용 가능한 모델 ${settings.models.length}개` : ' · 아래에서 모델 목록을 불러오세요'}
                </Alert>
                <button type="button" className="btn-primary" onClick={() => refresh()} disabled={loading}>
                  {loading ? <Spinner /> : null}
                  {settings.models.length ? '목록 새로고침' : '연결 확인하고 모델 불러오기'}
                </button>
              </div>
            )}
            {settings.apiKey && !provider && (
              <div className="flex flex-wrap items-center gap-2">
                <Alert kind="warn">키 형식으로 제공사를 알 수 없습니다. 직접 선택해 주세요.</Alert>
                {(['google', 'anthropic', 'openai'] as Provider[]).map((p) => (
                  <button key={p} type="button" className="btn btn-sm" onClick={() => { setManual(p); setSettings({ provider: p }); refresh(p) }}>{PROVIDER_LABEL[p]}</button>
                ))}
              </div>
            )}
            {error && <Alert kind="error">{error}</Alert>}
            <div className="flex flex-wrap gap-1.5 text-[12px] text-muted">
              <span className="rounded-full bg-ground px-2.5 py-1">AIza… → Google</span>
              <span className="rounded-full bg-ground px-2.5 py-1">sk-ant-… → Anthropic (Claude)</span>
              <span className="rounded-full bg-ground px-2.5 py-1">sk-… → OpenAI (GPT)</span>
            </div>
            <details className="text-[13px] text-muted">
              <summary className="cursor-pointer text-ink font-medium">키는 어디서 받나요?</summary>
              <div className="pt-2 flex flex-col gap-1">
                <span><a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a> → API 키 만들기 (무료 할당량)</span>
                <span><a className="underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console</a> → API Keys</span>
                <span><a className="underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI Platform</a> → API keys</span>
              </div>
            </details>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-6 pt-5 pb-3 flex flex-wrap items-center gap-2.5">
              <Step n={2} title="모델 선택" />
              <span className="flex-1" />
              {provider && <span className="text-[12px] text-muted">{PROVIDER_PDF[provider] ? 'PDF 직접 입력 가능' : 'PDF는 앱이 텍스트로 변환해 전송'}</span>}
            </div>
            <div className="px-3 pb-3 flex flex-col gap-1">
              {settings.models.length ? (
                <>
                  <Group k="recommended" />
                  <Group k="fast" />
                  <Group k="best" />
                  {tiers.other.length > 0 && (
                    <details>
                      <summary className="px-4 py-2.5 cursor-pointer text-[13px] text-muted">나머지 모델 {tiers.other.length}개 보기</summary>
                      <Group k="other" />
                    </details>
                  )}
                </>
              ) : (
                <div className="px-4 py-6 text-[13px] text-muted">API 키를 넣고 "연결 확인"을 누르면 실제로 쓸 수 있는 모델만 보여줍니다. 모델 이름은 저장하지 않고 매번 API에서 받아옵니다.</div>
              )}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card className="p-6 flex flex-col gap-3">
            <div className="eyebrow">제공사 비교</div>
            <div className="flex flex-col gap-2 text-[13px]">
              <div className={`rounded-[14px] bg-ground p-3.5 ${provider === 'google' ? 'border-[1.5px] border-ink' : ''}`}><div className="font-bold">Google Gemini</div><div className="text-muted">무료 할당량 · PDF 직접 입력</div></div>
              <div className={`rounded-[14px] bg-ground p-3.5 ${provider === 'anthropic' ? 'border-[1.5px] border-ink' : ''}`}><div className="font-bold">Anthropic Claude</div><div className="text-muted">한국어 문장 품질 우수 · PDF 직접 입력 · 유료</div></div>
              <div className={`rounded-[14px] bg-ground p-3.5 ${provider === 'openai' ? 'border-[1.5px] border-ink' : ''}`}><div className="font-bold">OpenAI GPT</div><div className="text-muted">유료 · PDF는 앱이 텍스트로 변환해 전송</div></div>
            </div>
          </Card>

          <Card className="p-6 flex flex-col gap-3">
            <Step n={3} title="개인정보" />
            <label className="flex gap-2.5 items-start text-[13px]"><input type="checkbox" checked disabled className="mt-0.5 w-4 h-4 accent-ink" /><span><strong>학생 이름 대신 출석번호만 전송</strong><span className="block text-muted">평어 · 행발 · 창체 모두. 끌 수 없습니다.</span></span></label>
            <label className="flex gap-2.5 items-start text-[13px]"><input type="checkbox" checked={settings.persistResults} onChange={(e) => setSettings({ persistResults: e.target.checked })} className="mt-0.5 w-4 h-4 accent-ink" /><span>생성 결과를 이 브라우저에 저장 (새로고침해도 유지)</span></label>
            <button type="button" className="btn btn-sm self-start text-lv3-ink" onClick={() => { if (confirm('평가계획, 성적, 결과, API 키를 모두 지웁니다. 계속할까요?')) resetAll() }}>이 브라우저의 모든 데이터 지우기</button>
          </Card>

          <Card className="p-6 flex flex-col gap-3">
            <Step n={4} title="문장 규칙" />
            <div className="flex flex-col gap-2.5 text-[13px]">
              <label className="flex justify-between items-center gap-2"><span>종결 어미</span>
                <select value={settings.ending} onChange={(e) => setSettings({ ending: e.target.value as any })} className="field !w-auto !py-1.5"><option value="함">-함. / -임.</option><option value="하였음">-하였음. / -이었음.</option></select></label>
              <label className="flex justify-between items-center gap-2"><span>교과·창체 성취기준당</span>
                <select value={settings.sentencesPerStandard} onChange={(e) => setSettings({ sentencesPerStandard: Number(e.target.value) as 1 | 2 })} className="field !w-auto !py-1.5"><option value={1}>1문장 (기본)</option><option value={2}>2문장</option></select></label>
              <label className="flex justify-between items-center gap-2"><span>행발 목표 분량</span>
                <span className="inline-flex items-center gap-1.5"><input type="number" value={settings.behaviorBytes} min={200} max={1500} step={50} onChange={(e) => setSettings({ behaviorBytes: Number(e.target.value) || 700 })} className="field !w-[80px] text-right !py-1.5" />Bytes 내외</span></label>
            </div>
          </Card>
        </div>
      </div>

      <div className="flex justify-end">
        <Link to="/plan" className="btn-primary">저장하고 평가계획으로 →</Link>
      </div>
    </>
  )
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-7 h-7 rounded-[9px] bg-ground inline-flex items-center justify-center text-[12px] font-bold">{n}</span>
      <h2 className="m-0 text-[17px] font-bold">{title}</h2>
    </div>
  )
}
