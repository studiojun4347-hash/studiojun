# STUDIOJUN v5 프로젝트 메모리

> Claude Code 역할 기준: `CLAUDE_CODE_ROLE.md`를 우선 읽을 것.
> 현재 협업 구조는 Claude Code = 기획/프롬프트/Obsidian 지식화, Codex = 코드/배포/QA 자동화.

## 프로젝트 정보
- **이름**: STUDIOJUN v5 — 3D 애니메이션 프로덕션 관리 시스템
- **URL**: https://studiojun.co.kr
- **스택**: Cloudflare Workers (ES Module) + D1 + R2 + Claude API + BytePlus + OpenAI
- **소유자**: JUN (콘텐츠 제작자, studiojun4347@gmail.com)

## Cloudflare 인프라
- Account ID: 11672bfed94bba41cc2b50f8d8b62e10
- Worker: studiojun
- D1 DB ID: ad5676f4-c5a6-48c6-8263-f988fbc68330 (바인딩: DB)
- R2 Bucket: studiojun-assets (바인딩: ASSETS)
- Secrets: ANTHROPIC_API_KEY, JWT_SECRET

## 핵심 파일
- `worker.js` — 백엔드 전체 (2363줄). 메인 라우터 + AI + R2 + CRUD + Guide API + Seedance API
- `STUDIOJUN_v5.html` — 프론트엔드 SPA (~680KB). D1 static_pages key `/`에 저장
- `CHANGELOG.md` — 버전별 변경 이력
- `deploy_frontend.html` — 프론트엔드 배포 도구 (gzip+base64 → D1 chunk 업로드)

## 팀 구조 (5부서)
Design(콘셉트) / Asset(모델링) / Animation(Maya) / RenderComp(렌더합성) / FX(이펙트)

## API 라우트 맵
- `/admin/*` — HTML 업로드, 청크, 마이그레이션
- `/ai/*` — Claude AI (번역/요약/분석/채팅)
- `/r2/*` — R2 스토리지
- `/api/guide/*` — 가이드 비디오 파이프라인 (14개 엔드포인트) ✅ 배포됨
- `/api/seedance/*` — Seedance 2.0 AI 렌더링 (10개 엔드포인트) ✅ 배포됨
- `/api/gpt-image/*` — GPT Image 2 (6개 엔드포인트) ✅ 배포됨 (config/jobs/auto-prompt/generate)
- `/api/*` — RESTful CRUD (shots/todos/members/assets/reviews 등)

## 현재 버전: v5.14 (2026-04-26)
→ 전체 변경 이력: CHANGELOG.md 참고

### v5.14 주요 변경사항 (2026-04-26) — SPA 모듈 분리
1. ✅ JWT 쿠키 인증: GET / → JWT 쿠키 확인 → 없으면 302 /login 리디렉트
2. ✅ 모듈 로더 시스템: SJ_MODULES + loadModule() + MODULE_VIEWS 맵
3. ✅ 5개 R2 모듈 생성 (modules/): ai-studio, storyboard, guide-qa, settings, extra-views
4. ✅ Worker /modules/* R2 서빙 라우트 추가
5. ✅ showView 분기: 모듈 뷰는 기존 함수 → fallback R2 로드
6. ✅ showGuideDeliveryStatus 잘림 버그 복원
7. ⚠️ Worker + 프론트엔드 + 모듈 R2 업로드 배포 대기 중

### v5.13 주요 변경사항 (2026-04-25)
1. ✅ 로그인 페이지 분리 (login.html 8KB, D1 key: /login)
2. ✅ showLogin()/doLogout() → /login 리디렉트
3. ✅ Worker PAGE_ROUTES에 /login 추가

### v5.12.1 주요 변경사항 (2026-04-25)
1. ✅ 구글시트 6개 시트 D1 동기화 완성 (150+ 탭)
2. ✅ 프론트엔드 구글시트 뷰 전면 개편 (현황 카드 + 데이터 뷰어)
3. ✅ NAS 연결 확인 (NAVYMINTGREY, 파일 리스팅은 터널 갱신 필요)
4. ✅ 옵시디언 지식 적재 (integrations 3개 문서)

### v5.12 주요 변경사항 (2026-04-25)
1. ✅ AI 스튜디오 페이지 (Higgsfield.ai 스타일 UI 전면 재설계)
2. ✅ GPT Image 2 통합 (gpt-image-1, 부서별 워크플로우)
3. ✅ AI 렌더 + AI 이미지 서브탭, 통합 API 키 설정
4. ✅ 모바일 반응형 (900px, 600px)

### v5.11 주요 변경사항 (2026-04-23)
1. ✅ Seedance API: PiAPI → BytePlus ModelArk 전환
2. ✅ Google Sheets 6개 시트 연동
3. ✅ 더미 데이터 정리
8. ✅ AI 기능 admin/pd 전용 제한
9. ✅ 네비 탭 20→13개 정리, i18n 업데이트
10. ✅ 프론트엔드 D1 배포 (key: `/`)

### 미완료
1. ✅ worker.js Seedance API 배포 완료 (BytePlus 연동)
2. ✅ 구글시트 연동 완성 (6개 시트 D1 동기화 + 프론트엔드 뷰어)
3. ⚠️ NAS 파일 리스팅: 터널 URL 갱신 필요 (연결은 성공)
4. ❌ worker.js 자동화 패치 재배포 필요 (auto-prompt/batch-render/shots-list 추가)
5. ❌ 프론트엔드 자동화 UI 배포 필요

## Seedance 2.0 워크플로우
Maya Playblast(.mp4) → R2 업로드(/api/seedance/upload-playblast) → omni_reference 모드로 PiAPI 전송(/api/seedance/render) → 폴링(/api/seedance/status/:id) → 완료 시 R2에 결과 저장

## 배포 핵심 주의사항
- metadata를 `new Blob([JSON.stringify(md)], {type:'application/json'})` 형태로 첨부해야 ES module 인식됨
- `keep_bindings: ["secret_text"]` 필수 (기존 시크릿 보존)
- D1/R2는 bindings에 명시: `{type:"d1",name:"DB",id:"ad5676f4-..."}`, `{type:"r2_bucket",name:"ASSETS",bucket_name:"studiojun-assets"}`

## 프론트엔드 배포 방법
1. D1 MCP로 직접 패치: `UPDATE static_pages SET content = replace(content, 'old', 'new') WHERE key = '/'`
2. deploy_frontend.html: 브라우저에서 열고 "Deploy Now" (gzip 압축 → `/admin/chunk` API로 전송)
3. 주의: Worker가 루트 URL을 key `'/'`에서 서빙 (`'index'`가 아님)
4. CDN 캐시: max-age=300, s-maxage=600 (캐시 우회: `?_=timestamp`)

## 코딩 원칙 (Karpathy 4원칙)

모든 코드 수정 시 반드시 따를 것:

1. **코딩 전 사고** — 코드를 쓰기 전에 현재 상태를 파악하고, 변경의 영향 범위를 먼저 생각한다. "왜 이 변경이 필요한가?"를 명확히 한 후에만 코드를 작성한다.
2. **단순성 우선** — 가장 단순한 해결책을 먼저 시도한다. 과도한 추상화, 불필요한 라이브러리 도입, 복잡한 패턴을 피한다. 동작하는 가장 짧은 코드가 최선이다.
3. **외과적 변경** — 수정은 필요한 부분만 정확히 한다. 관련 없는 리팩토링, 스타일 변경, "개선"을 동시에 하지 않는다. 한 번에 하나의 목적만 달성한다.
4. **목표 중심 실행** — 사용자의 요청을 정확히 달성하는 데 집중한다. 요청하지 않은 기능 추가, 과도한 에러 처리, 불필요한 최적화를 하지 않는다.

## 상세 인수인계
→ HANDOFF_20260407.md 참고 (배포 스크립트, API 스펙, 트러블슈팅 포함)
→ CURRENT_STATE.md 참고 (엔드포인트 상세, PiAPI 스펙)
→ CHANGELOG.md 참고 (버전별 변경 이력)
