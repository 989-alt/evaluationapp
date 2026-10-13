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
| 4 | 행발 · 창체 | 특성 체크 → 행발(목표 바이트) / 예시 문장 → 변형 문장 |
| 5 | 나이스 입력 | 크롬 확장(`extension/`)이 읽어 갈 데이터 확인과 입력 순서 안내 |

## 개인정보

- 학생 **이름은 입력받지 않고 출석번호만** 사용합니다. API에는 번호와 성적·특성만 보냅니다.
- API 키와 모든 데이터는 이 브라우저의 `localStorage`에만 저장됩니다. API 키는 선택한 AI 제공사로만 전송됩니다.
- 나이스로 보내기 전 사람 이름 패턴·금지 문자·바이트 초과·중복 문장을 검사합니다.

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
  pages/               설정 · 평가계획 · 평어(A/B) · 결과 · 행발 · 창체 · 나이스 · 도움말
  llm/provider.ts      Google / Anthropic / OpenAI 호출, 모델 목록, 429 재시도
  llm/prompts.ts       추출·생성 프롬프트
  llm/generateModeB.ts 학생별 생성 엔진(중단·이어서 생성, 중복 회피)
  lib/validate.ts      NEIS 규정 검사기
  lib/neis.ts          나이스 확장용 페이로드
  store/index.ts       zustand 저장소(브라우저 저장)
```

## 배포

> **먼저 할 일:** 저장소 Settings → Pages → Source를 **GitHub Actions**로 바꿔야 합니다. 예전 단일 파일 버전처럼 "Deploy from a branch"로 두면 루트 `index.html`(Vite 개발용 진입점)이 그대로 서비스되어 빈 화면이 나옵니다.

`main`에 푸시하면 GitHub Actions가 빌드해 GitHub Pages에 올립니다 (`.github/workflows/deploy.yml`). `npm ci`는 SheetJS 공식 배포처(`cdn.sheetjs.com`)에서 `xlsx`를 받습니다.

## 나이스 확장 연동

결과 화면의 "나이스로 보내기"는 입력 데이터를 `localStorage['saenggibu-neis']`에 `{ version: 1, payloads: NeisPayload[] }` 형태로 따로 저장합니다(`src/lib/types.ts`의 `NeisPayload`). 확장은 이 키만 읽습니다. 앱 본체 저장소 `saenggibu-v2`에는 API 키가 들어 있으므로 확장이 읽지 않습니다.

분량은 상한이 아니라 **목표 바이트**로 다룹니다. 설정에서 교과 평어(교과당, 한 번 생성 기준)와 행발의 목표를 바꿀 수 있고 기본값은 둘 다 700B입니다(1·2학기 합치면 교과당 1500B 안팎). 행발만 목표 + 150B를 넘으면 참고 경고를 띄웁니다.

## 크롬 확장

`extension/` 폴더가 크롬 확장 "AI 생기부 보조 생성기 → 나이스"입니다(Manifest V3, 빌드 없음). 웹앱이 보낸 데이터를 나이스 교과평가·학기말종합의견·행동특성·창체 화면에 번호순으로 넣고, 성명 열은 읽지 않습니다. 설치(개발자 모드)·화면별 순서·구조 수집은 [`extension/README.md`](extension/README.md)를 보세요. 테스트: `npm run test:ext` (Playwright + xvfb).

## 2차 계획

- 도움말 페이지의 실제 화면 스크린샷: `src/assets/guide/step0.png` … `step5.png`를 넣으면 빌드에 포함되고, 없는 단계는 도식으로 보입니다.

이전 단일 파일 버전은 `legacy_index.html`에 남겨 두었습니다.
