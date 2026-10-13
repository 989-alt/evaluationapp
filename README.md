# AI 생기부 보조 생성기

초등 담임 교사가 학교 **평가 계획표(PDF)** 한 장으로 교과 평어 · 행동특성 및 종합의견 · 창의적 체험활동 특기사항을 만들고, 검사한 뒤 나이스에 넣을 수 있게 돕는 정적 웹앱입니다. 서버 없이 브라우저에서만 동작하며, 사용자의 API 키로 Google Gemini / Anthropic Claude / OpenAI GPT를 직접 호출합니다.

**모토: 사용자는 편하게, 성능은 확실하게.**

## 흐름

| 단계 | 화면 | 하는 일 |
|---|---|---|
| 0 | 설정 | API 키 붙여넣기 → 제공사 자동 인식 → 실제 사용 가능한 모델 목록에서 선택 (권장 / 빠름 / 최고 품질) |
| 1 | 평가계획 | PDF 업로드 → AI가 교과·성취기준·4수준 평가 기준·창체 표를 추출 → 표에서 검수·수정, 학기별 저장 |
| 2 | 평어 생성 | **방식 A** 성취기준별 수준별 예시 평어 / **방식 B** 학생별 성적(학생별 보기·성취기준별 보기) 입력 → 교과별 평어 문단 |
| 3 | 결과 | NEIS 규정 검사(명사형 종결·금지 문자·바이트·이름 패턴·학생 간 중복), 수정, 다시 생성, Excel, 나이스로 보내기 |
| 3.5 | 모아보기 | 교과·행발·창체 완성본 모아보기, 복사, Excel, 나이스로 보내기 |
| 4 | 행발 · 창체 | 특성 체크 → 행발(목표 바이트) / 예시 문장 → 변형 문장 |
| 5 | 나이스 입력 | 크롬 확장(`extension/`)이 읽어 갈 데이터 확인과 입력 순서 안내 |

## 개인정보

- 학생 **이름은 입력받지 않고 출석번호만** 사용합니다. API 키와 모든 데이터는 이 브라우저의 `localStorage`에만 저장되며, API 키는 선택한 AI 제공사로만 전송됩니다.
- **AI 제공사로 보내는 것**: 출석번호, 교과명·성취기준(코드·본문·평가 요소)·성취 수준, 수준별 평가 기준 문장, 행발 특성 항목(긍정/지도 필요), 창체 예시 문장, 평가계획 PDF(Google·Anthropic은 PDF 파일 그대로, OpenAI는 앱이 뽑은 글자). 평가계획 추출 프롬프트는 학교명을 추출하지 않도록 하고(`school`은 항상 빈 값), 앱도 학교명을 저장·표시하지 않습니다.
- **보내기 전 개인정보 검사**(`src/lib/pii.ts`, AI 없이 코드로): 이름(성씨 + 호칭·조사 모양), 전화번호, 주민번호, 생년월일(“생년월일·생일·출생” 뒤의 날짜만), 이메일, 학교명(○○초등학교·중학교·고등학교), 3단계 주소, 교사 이름(○○○ 선생님·교사·담임)을 찾아 생성 버튼 옆에 노란 **확인 필요** 카드로 보여 줍니다. “개인정보가 아니거나 보내도 괜찮은 내용입니다”를 체크해야 생성이 진행되며, 확인한 표현은 (종류 + 표현) 해시로 기억해 다시 묻지 않습니다(“다시 검사”로 초기화). 평가계획·행발·창체에 흔한 문장에서 오탐이 나지 않도록 조율했고, 설정의 “개인정보 검사기 자가 점검”(`src/lib/pii.selftest.ts`)으로 일반 문장 46개 오탐 0·개인정보 예시 19개 모두 검출을 확인할 수 있습니다.
- 나이스로 보내기 전 사람 이름 패턴·금지 문자·바이트 초과·중복 문장을 다시 검사합니다.
- 원칙: 경기도교육청 교사용 생성형 AI 활용 가이드라인처럼 **학생 정보는 익명화·가명화해서만** 생성형 AI에 입력하고, **학교명도 학교를 특정할 수 있는 보호 대상**으로 다룹니다.

### 제공사별 API 데이터 사용 (2026-10-13 확인)

| 제공사 | 학습·제품 개선 사용 | 보관 | 근거 |
|---|---|---|---|
| Google Gemini API | **무료(Unpaid) 서비스**: 제출한 내용과 생성된 응답을 Google 제품·서비스와 머신러닝 기술의 제공·개선·개발에 사용하며, 사람 검토자가 API 입력·출력을 읽고 주석을 달 수 있음. **유료(Paid) 서비스**(결제 계정이 활성화된 Cloud 프로젝트로 접근): 프롬프트·응답을 제품 개선에 쓰지 않음 | 유료: 남용 감지 목적으로만 제한된 기간 기록 | [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) (시행 2026-03-23, 페이지 갱신 2026-04-28). 2026-04-01부터 무료 등급에서 Pro 모델 제외 |
| Anthropic API | 상용 약관: “Anthropic may not train models on Customer Content from Services” | 입력·출력 기본 30일 안에 삭제. 무보관(ZDR) 계약, 사용 정책 위반(최대 2년), 법적 요구 시 예외. 2026년 도입된 “Covered Models” 규정으로 일부 최신 모델은 안전 목적 제한 보관·검토 대상(세부는 해당 페이지에 없음) | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (시행 2025-06-17), [How long do you store personal data?](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-personal-data) (갱신 2026-07-01) |
| OpenAI API | 2023-03-01부터 명시적으로 동의(opt-in)하지 않는 한 API 데이터로 모델을 학습·개선하지 않음 | 남용 감시 로그 최대 30일, 무보관(ZDR)은 승인 시 | [Your data](https://developers.openai.com/api/docs/guides/your-data) |

설정 화면은 감지한 제공사에 맞춰 위 내용을 보여 줍니다. Google 키는 “결제가 연결된 유료 키입니다”를 체크하기 전까지 생성 화면에 노란 안내가 한 줄 보입니다(생성은 막지 않음).

## 개발

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # dist/
```

Vite 6 · React 18 · TypeScript · Tailwind v4 · zustand · react-router (HashRouter) · SheetJS · pdf.js

### 구조

```
src/
  app/Shell.tsx        좌측 아이콘 레일, 첫 방문 안내
  pages/               설정 · 평가계획 · 평어(A/B) · 결과 · 행발 · 창체 · 모아보기 · 나이스 · 도움말
  llm/provider.ts      Google / Anthropic / OpenAI 호출, 모델 목록, 429 재시도
  llm/prompts.ts       추출·생성 프롬프트
  llm/generateModeB.ts 학생별 생성 엔진(중단·이어서 생성, 중복 회피)
  lib/validate.ts      NEIS 규정 검사기
  lib/pii.ts           AI로 보내기 전 개인정보 검사(코드 기반), pii.selftest.ts 자가 점검
  components/PIIGate   노란 "확인 필요" 확인 카드, Google 무료 키 안내
  lib/neis.ts          나이스 확장용 페이로드
  store/index.ts       zustand 저장소(브라우저 저장)
```

## 배포

> **먼저 할 일:** 저장소 Settings → Pages → Source를 **GitHub Actions**로 바꿔야 합니다. 예전 단일 파일 버전처럼 "Deploy from a branch"로 두면 루트 `index.html`(Vite 개발용 진입점)이 그대로 서비스되어 빈 화면이 나옵니다.

`main`에 푸시하면 GitHub Actions가 빌드해 GitHub Pages에 올립니다 (`.github/workflows/deploy.yml`). `npm ci`는 SheetJS 공식 배포처(`cdn.sheetjs.com`)에서 `xlsx`를 받습니다.

## 나이스 확장 연동

결과 화면의 "나이스로 보내기"는 입력 데이터를 `localStorage['saenggibu-neis']`에 `{ version: 1, payloads: NeisPayload[] }` 형태로 따로 저장합니다(`src/lib/types.ts`의 `NeisPayload`). 확장은 이 키만 읽습니다. 앱 본체 저장소 `saenggibu-v2`에는 API 키가 들어 있으므로 확장이 읽지 않습니다.

교과 평어는 분량 목표 없이 성취기준당 문장 수(1 또는 2)와 수준별 평가 기준만으로 씁니다. 행발은 상한이 아닌 **목표 바이트**(기본 700B, 설정에서 변경)로 다루며 목표 + 150B를 넘으면 참고 경고를 띄웁니다.

## 크롬 확장

`extension/` 폴더가 크롬 확장 "AI 생기부 보조 생성기 → 나이스"입니다(Manifest V3, 빌드 없음). 웹앱이 보낸 데이터를 나이스 교과평가·학기말종합의견·행동특성·창체 화면에 번호순으로 넣고, 성명 열은 읽지 않습니다. 설치(개발자 모드)·화면별 순서·구조 수집은 [`extension/README.md`](extension/README.md)를 보세요. 테스트: `npm run test:ext` (Playwright + xvfb).

## 2차 계획

- 도움말 페이지의 실제 화면 스크린샷: `src/assets/guide/step0.png` … `step5.png`를 넣으면 빌드에 포함되고, 없는 단계는 도식으로 보입니다.

이전 단일 파일 버전은 `legacy_index.html`에 남겨 두었습니다.
