import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card, PageHeader } from '@/components/ui'

const Bar = ({ w = 'w-full', h = 'h-2.5', dark = false }: { w?: string; h?: string; dark?: boolean }) => (
  <div className={`${w} ${h} rounded-full ${dark ? 'bg-ink/80' : 'bg-line'}`} />
)
const Call = ({ n }: { n: number }) => (
  <span className="absolute -top-2 -left-2 w-6 h-6 rounded-full bg-accent text-white text-[12px] font-bold flex items-center justify-center shadow">{n}</span>
)
const Block = ({ n, children, className = '' }: { n?: number; children?: ReactNode; className?: string }) => (
  <div className={`relative rounded-[12px] bg-surface-2 border border-line p-3 ${className}`}>
    {n && <Call n={n} />}
    {children}
  </div>
)

/** 스크린샷이 없을 때 보이는 도식 */
function Schematic({ step }: { step: number }) {
  const rows = (
    <div className="flex flex-col gap-2">
      <Bar w="w-2/3" /><Bar /><Bar w="w-5/6" />
    </div>
  )
  return (
    <div className="flex flex-col gap-3 p-4 bg-ground rounded-[14px] min-h-[220px]">
      <Bar w="w-1/3" h="h-4" dark />
      {step === 0 && (
        <>
          <Block n={1}><div className="flex gap-2"><Bar w="flex-1" h="h-8" /><div className="w-16 h-8 rounded-full bg-ink/80" /></div></Block>
          <Block n={2}><div className="flex gap-2"><div className="w-20 h-7 rounded-full bg-line" /><div className="w-20 h-7 rounded-full bg-ink/80" /></div></Block>
          <Block n={3}>{rows}</Block>
        </>
      )}
      {step === 1 && (
        <>
          <Block n={1}><div className="h-12 rounded-[10px] border-2 border-dashed border-line flex items-center justify-center"><Bar w="w-1/3" /></div></Block>
          <Block n={2}>{rows}</Block>
          <Block n={3}><div className="flex gap-2"><Bar w="w-1/4" h="h-5" /><Bar w="w-1/4" h="h-5" /><Bar w="w-1/4" h="h-5" /></div></Block>
        </>
      )}
      {step === 2 && (
        <div className="grid grid-cols-[1fr_2fr] gap-3">
          <Block n={1}>{rows}</Block>
          <div className="flex flex-col gap-3">
            <Block n={2}><Bar w="w-1/2" /></Block>
            <Block n={3}>
              <div className="grid grid-cols-4 gap-1.5">
                {['lv-0', 'lv-1', 'lv-2', 'lv-3'].map((c) => <div key={c} className={`h-6 rounded-md ${c}`} />)}
              </div>
            </Block>
          </div>
        </div>
      )}
      {step === 3 && (
        <>
          <Block n={1}><Bar w="w-full" h="h-4" /></Block>
          <Block n={2}>{rows}</Block>
          <Block n={3}><div className="flex gap-2"><div className="w-16 h-6 rounded-full lv-0" /><div className="w-16 h-6 rounded-full lv-2" /></div></Block>
        </>
      )}
      {step === 4 && (
        <>
          <Block n={1}><div className="flex flex-wrap gap-1.5">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className={`w-14 h-6 rounded-full ${i < 2 ? 'lv-1' : i === 2 ? 'lv-2' : 'bg-line'}`} />)}</div></Block>
          <Block n={2}>{rows}</Block>
          <Block n={3}><div className="w-24 h-7 rounded-full bg-accent/80" /></Block>
        </>
      )}
      {step === 5 && (
        <>
          <Block n={1}><div className="flex gap-2"><Bar w="w-1/3" h="h-5" /><Bar w="w-1/3" h="h-5" /></div></Block>
          <Block n={2}>{rows}</Block>
          <Block n={3}><div className="flex justify-end gap-2"><div className="w-20 h-7 rounded-full bg-ink/80" /></div></Block>
        </>
      )}
    </div>
  )
}

// src/assets/guide/step{n}.png 를 넣으면 빌드에 포함됩니다. 없는 파일은 요청하지 않으므로 404가 나지 않습니다.
const SHOTS = import.meta.glob('/src/assets/guide/step*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const shotUrl = (n: number): string | undefined => SHOTS[`/src/assets/guide/step${n}.png`]

/** 스크린샷이 있으면 사진을, 없으면 도식을 보여줍니다 */
function Shot({ step }: { step: number }) {
  const url = shotUrl(step)
  return (
    <figure className="m-0">
      {url ? (
        <img src={url} alt={`단계 ${step} 화면`} className="w-full rounded-[14px] border border-line" />
      ) : (
        <>
          <Schematic step={step} />
          <figcaption className="mt-2 text-[12px] text-muted">실제 화면 스크린샷이 들어갈 자리</figcaption>
        </>
      )}
    </figure>
  )
}

const SECTIONS = [
  {
    id: 's0', short: '설정', title: '설정', to: '/settings',
    steps: [
      '설정에서 AI 제공자의 API 키를 붙여 넣고 "모델 불러오기"를 누릅니다. 키는 이 브라우저에만 저장됩니다',
      '목록에서 모델을 고릅니다. 처음이라면 "권장" 표시가 있는 모델이 무난합니다',
      '문장 종결("함" / "하였음")과 행동특성 목표 바이트를 정합니다',
    ],
  },
  {
    id: 's1', short: '평가계획', title: '평가계획 올리기', to: '/plan',
    steps: [
      '학교 평가계획 PDF를 올리면 성취기준과 평가 기준(매우잘함~노력요함)을 자동으로 뽑아 줍니다',
      '비어 있거나 틀린 칸이 있으면 표에서 직접 고칩니다. 교과·성취기준 코드가 맞는지만 확인하세요',
      '여러 개를 올렸다면 지금 쓸 평가계획을 하나 선택합니다',
    ],
  },
  {
    id: 's2', short: '성적 입력', title: '성적 입력 (방식 B)', to: '/grades',
    steps: [
      '평어 생성 → 방식 B → 성취기준별 보기. 학생 수만 적으면 됩니다(이름은 쓰지 않습니다)',
      '왼쪽에서 성취기준을 고르고, 학생마다 1·2·3·4 키(매우잘함~노력요함)를 누릅니다. Enter로 다음 학생',
      '대부분이 같은 수준이면 전체 선택 후 수준 버튼 한 번으로 채우고 예외만 고칩니다',
    ],
  },
  {
    id: 's3', short: '평어 생성', title: '평어 생성 · 검사', to: '/results',
    steps: [
      '아래 "입력된 N명 평어 생성"을 누르면 학생마다 교과별 문단이 만들어집니다. 번호와 수준만 전송됩니다',
      '결과 카드에서 문장을 클릭하면 복사됩니다. 마음에 안 들면 수정하거나 "다시 생성"을 누릅니다',
      '이름 의심·허용 외 문자·바이트·중복 문장은 자동 검사됩니다. 검사 통과한 문장만 나이스로 보내세요',
    ],
  },
  {
    id: 's4', short: '행발 · 창체', title: '행발 · 창체', to: '/behavior',
    steps: [
      '행발: 학생마다 특성 칩을 한 번 누르면 긍정(파랑), 두 번 누르면 지도 필요(살구)로 표시됩니다',
      '"생성"을 누르면 목표 바이트(기본 700)에 맞춰 종합의견이 만들어집니다. 바이트와 검사 결과를 확인하고 필요하면 수정합니다',
      '창체: 우리 반 활동 문장을 적으면 비슷한 문장을 여러 개 만들어 줍니다. 학생에게 배정은 직접 합니다',
    ],
  },
  {
    id: 's5', short: '나이스 입력', title: '나이스 입력', to: '/neis',
    steps: [
      '모아보기(또는 결과·행발·창체 화면)에서 "나이스로 보내기"를 누르면 이 화면의 "보낼 데이터"에 쌓입니다',
      '검사 요약에 경고(주황)가 없는지 확인합니다. 필요하면 JSON으로 내려받아 둡니다',
      '나이스에 로그인해 해당 화면을 조회한 뒤 크롬 확장 아이콘 → 데이터 확인 → 자동 입력을 누릅니다',
    ],
  },
]

const FAQ = [
  { q: '"모델을 사용할 수 없습니다"가 떠요', a: '선택한 모델이 API 키로 쓸 수 없거나 사용량 한도를 넘은 경우입니다. 설정에서 "모델 불러오기"를 다시 눌러 목록을 새로 받고, 다른 모델(예: 빠른 모델)을 골라 보세요. 429 오류는 잠시 후 자동으로 다시 시도합니다.' },
  { q: '평가계획 추출이 일부 비어 있어요', a: '스캔본이거나 표 구조가 복잡한 PDF는 일부 칸이 비어 나올 수 있습니다. 평가계획 화면의 표에서 비어 있는 성취기준·평가 기준을 직접 채우면 이후 단계에 그대로 반영됩니다. PDF를 지원하는 모델을 쓰면 정확도가 올라갑니다.' },
  { q: '확장이 나이스 화면을 못 알아봐요', a: '나이스에 로그인한 뒤 입력할 화면(교과평가, 학생부자료기록 등)을 먼저 조회해 두어야 합니다. 그래도 안 되면 화면을 새로고침하고 확장 아이콘을 다시 눌러 보세요. 나이스 화면이 개편되면 확장 업데이트가 필요할 수 있습니다.' },
  { q: '결과 페이지를 나갔더니 평어를 다시 만들어야 하나요', a: '아니요. 만든 평어는 이 브라우저에 남아 있습니다. 왼쪽 레일의 "모아보기"에서 교과 평어·행발·창체 완성본을 한곳에서 보고, 복사하거나 Excel로 받고, 다시 나이스로 보낼 수 있습니다. 수정·다시 생성은 평어 생성 화면 위쪽의 "결과" 탭에서 합니다. 설정에서 "생성 결과를 이 브라우저에 저장"을 끄면 새로고침할 때 지워집니다.' },
  { q: '생성 버튼 위에 노란 "확인 필요"가 떠요', a: 'AI로 보내기 전에 앱이 직접(AI 없이) 평가계획·성취기준·특성·예시 문장을 검사해 학생 이름, 전화번호, 주민번호, 생년월일, 이메일, 학교명, 주소, 교사 이름으로 보이는 표현을 노란 형광으로 보여 주는 것입니다. 실제 개인정보라면 해당 칸에서 지우거나 번호·일반 표현으로 바꾸세요. 개인정보가 아니라면 "개인정보가 아니거나 보내도 괜찮은 내용입니다"를 체크하면 바로 생성할 수 있고, 같은 표현은 다음부터 묻지 않습니다. 다시 묻게 하려면 "다시 검사"를 누르세요. 피로하지 않도록 이름은 성씨로 시작하는 세 글자 + 조사·호칭처럼 이름일 가능성이 높은 모양만 잡습니다.' },
  { q: '학생 이름은 어디에도 안 들어가나요', a: '네. 이 앱은 학생을 출석번호로만 구분하며 이름을 입력받지 않습니다. AI에는 번호와 성취수준만 전송되고, 확장도 나이스의 성명 열을 읽지 않습니다. 생성된 문장에 이름 같은 표현이 있으면 검사에서 "이름 의심"으로 알려 줍니다.' },
]

export default function GuidePage() {
  return (
    <>
      <PageHeader eyebrow="도움말 · 처음 오셨나요?" title={<>평가계획 한 장이면<br />한 학기 평어가 나이스까지 갑니다</>} />

      <nav className="rounded-[20px] bg-ink text-white px-6 py-5 flex flex-wrap gap-x-6 gap-y-3" aria-label="단계 바로가기">
        {SECTIONS.map((s, i) => (
          <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }} className="flex items-center gap-2 text-white/90 hover:text-white no-underline">
            <span className="w-6 h-6 rounded-full bg-accent text-white text-[12px] font-bold flex items-center justify-center">{i}</span>
            <span>{s.short}</span>
          </a>
        ))}
      </nav>

      {SECTIONS.map((s, i) => (
        <Card key={s.id} id={s.id} className="p-6 scroll-mt-4">
          <div className="eyebrow mb-1">STEP {i}</div>
          <h2 className="m-0 mb-5 text-[22px] font-light tracking-[-0.01em]">{s.title}</h2>
          <div className="grid gap-6 md:grid-cols-2 items-start">
            <div>
              <ol className="m-0 p-0 list-none flex flex-col gap-3.5">
                {s.steps.map((t, k) => (
                  <li key={k} className="flex gap-3 items-start">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-accent text-white text-[12px] font-bold flex items-center justify-center mt-0.5">{k + 1}</span>
                    <span className="text-ink-2 leading-[1.65]">{t}</span>
                  </li>
                ))}
              </ol>
              <Link to={s.to} className="btn btn-sm mt-5">이 화면으로 가기 →</Link>
            </div>
            <Shot step={i} />
          </div>
        </Card>
      ))}

      <Card className="p-6">
        <div className="eyebrow mb-1">FAQ</div>
        <h2 className="m-0 mb-4 text-[22px] font-light tracking-[-0.01em]">자주 묻는 질문</h2>
        <div className="flex flex-col gap-2">
          {FAQ.map((f) => (
            <details key={f.q} className="rounded-[14px] bg-surface-2 px-5 py-3">
              <summary className="cursor-pointer font-bold">{f.q}</summary>
              <p className="m-0 mt-2 text-ink-2 leading-[1.7]">{f.a}</p>
            </details>
          ))}
        </div>
      </Card>
    </>
  )
}
