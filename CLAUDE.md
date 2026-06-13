# 키즈체리 출석체크 프로젝트 — 작업 가이드

## 프로젝트 개요
- 단일 HTML 파일 출석체크 앱 (`키즈체리 출석체크.html`)
- localStorage 기반 클라이언트 사이드 데이터
- Google Apps Script 웹앱과 연동해 Google Sheets로 출석 데이터 동기화 (`apps_script_code.gs`)
- 일반 주차 + 간사교육 회차 분리 관리

## ⚠️ 이전 세션의 실수 — 반드시 피할 것

### 1. UX 영향이 큰 설계는 먼저 옵션 제시하고 확정 후 구현
- **무엇을 잘못했나**: "Google Sheets 동기화 추가해줘" 요청에 곧장 "주차별 탭 자동 생성" 방식으로 구현. 12개 이상 탭이 생겨 사용자가 "너무 많아 보기 힘들다"고 지적 → 매트릭스(성적표) 방식으로 완전 재작업.
- **교훈**: 데이터 표현 방식(탭 구조, 컬럼 레이아웃 등 사용자 시야에 직접 영향)은 코드 작성 전에 2~3개 옵션 비교표로 제시하고 사용자 확정 후 진행.

### 2. 매번 출석체크마다 전체 데이터 재작성 (full rewrite) 금지
- **무엇을 잘못했나**: 출석 1건 변경에 60+행 전체를 `clearContents`+`setValues`로 다시 쓰는 코드를 작성. 매번 10초씩 걸려 사용자가 직접 "변경된 사람만 업데이트"를 요청.
- **교훈**: 데이터 동기화는 **incremental(증분)** 을 디폴트로. 1행만 변경되면 1행만 수정. 전체 재작성은 명시적 `전체 동기화` 버튼이나 구조 변경 시에만.

### 3. RPC/웹훅 핸들러는 unknown action에 success 절대 반환 금지
- **무엇을 잘못했나**: Apps Script `doPost`에서 매칭되는 if 분기가 없으면 함수 끝의 `return respond({ result: 'success' })`로 빠져 빈 응답을 success로 반환. HTML이 거짓 success를 받아 "✅ 반영 완료" 토스트를 띄우는데 실제 시트는 비어있는 상황 발생.
- **교훈**: 알 수 없는 액션엔 `{ result: 'error', message: 'unknown action: ' + action }` 반환. 응답에 항상 `version` 또는 작업 결과 카운트(`updated`, `appended` 등) 포함해서 클라이언트가 가짜 success를 감지할 수 있게.

### 4. Apps Script는 한 번에 제대로 설계 (5번 재배포 시키지 말 것)
- **무엇을 잘못했나**: 이 프로젝트에서 Apps Script를 v2 → v3 → v4 → v5 → v6까지 5번 새로 배포 요청. 매번 사용자가 "새 버전" 선택해서 재배포해야 했음. 배포 절차가 까다로워 자주 실패.
- **교훈**: 데이터 동기화 같은 외부 통합은 처음부터 충분히 설계 (incremental, 동시성, 진단 응답, 버전 필드 등 모두 한 번에 반영). 매번 사소한 수정 ≠ 좋음, 한 번에 견고하게.

### 5. 동시성 처리는 처음부터
- **무엇을 잘못했나**: 매번 동기화 시 lock/직렬화 없이 작성 → 출석체크 연타 시 Apps Script 동시 실행 → 시트 데이터가 두 번 덮어쓰여지는 race condition 발생.
- **교훈**: 공유 상태 수정 코드(여기서 시트)는 처음부터 `LockService` + 클라이언트 측 `_syncInProgress` 플래그로 직렬화.

### 6. 자가진단 토스트가 사용자 작업을 방해하면 안 됨
- **무엇을 잘못했나**: "구버전 Apps Script 감지 → 전체 동기화로 폴백" 토스트가 출석체크 1건마다 발생. 매번 노이즈.
- **교훈**: 진단 결과(`localStorage`의 `v5_confirmed` 같은)는 한 번 확인되면 캐시. 같은 진단을 반복하지 말 것.

### 7. 외부 서비스는 브라우저로 직접 검증 가능한 진단 엔드포인트 필수
- **무엇을 잘못했나**: Apps Script 배포 상태를 확인할 방법이 없어 사용자가 "v5라고 했는데도 구버전이라고 뜬다"고 보고. 한참 뒤에야 `doGet` 핸들러 추가.
- **교훈**: 외부 통합 코드 작성 시 처음부터 브라우저에서 URL을 직접 열면 JSON 응답이 나오는 `doGet` 같은 진단 응답 추가. 사용자가 자력 진단 가능하게.

### 8. 사용자 문제 보고 시 "다시 해보세요" 말고 root cause 추적
- **무엇을 잘못했나**: 사용자가 "동기화 안 됩니다" 보고하면 "v5 재배포하세요"만 반복. 진짜 원인(스크린샷의 토스트 메시지가 incremental 경로의 메시지였다는 점)을 늦게 발견.
- **교훈**: 문제 보고 받으면 1) 스크린샷의 텍스트를 한 글자씩 분석, 2) 콘솔/네트워크 로그 요청, 3) 구체적 진단 단계 제시. 일반 조언 반복 금지.

### 9. 모호한 입력엔 옵션 4개 늘어놓지 말고 가장 유력한 것만 묻기
- **무엇을 잘못했나**: 사용자가 "CLAUDE.md"라고만 입력했을 때 4가지 옵션 나열. 사용자 의도는 명확했음(파일 작성 또는 보기).
- **교훈**: 1순위 추측 + 짧은 확인 ("프로젝트 메모리에 작업 가이드를 작성하면 되나요?") 으로 진행. 4지선다 금지.

### 10. 일괄 변경 함수가 status만 갱신하고 lecLabel/score를 옛값 그대로 둔 버그
- **무엇을 잘못했나**: 학생/간사 토글 작업 후 `bulkSetStatus` / `bulkSetStatusFiltered` 를 그대로 두었는데, 이 함수들이 `status` 만 갱신하고 `...prev` 로 `lecLabel`/`score` 를 옛값 그대로 가져왔음. 사용자가 "전체 출석" 누르면 상태는 출석인데 강의구분은 결석/1강 지각 등으로 모순. 사용자가 직접 보고해서 발견.
- **교훈**: 출석 데이터는 `{status, lecLabel, score, time}` 4개가 **반드시 일관성** 있어야 함. 상태 변경 함수는 4개 모두 동시에 갱신. `changeStatus` 를 fix 했으면 그 옆의 `bulkSetStatus` 도 반드시 같은 로직으로 fix. **헬퍼 함수 1개로 통합**하면 다음에 또 갈라지지 않음 (현재 `_applyBulkStatusOne` 으로 통합됨).

### 11. calcLectureStatus 의 마감~첫강의 사이 공백 구간 버그
- **무엇을 잘못했나**: 마감 시간(cutoff)이 첫 강의 시작보다 앞이면 그 사이 구간이 어디에도 안 잡혀서 결석으로 떨어짐. 예: cutoff=08:45, 1강=09:00 → 08:46~08:59 도착자는 모두 "결석 0점". 사용자가 실제 사용 중 발견.
- **교훈**: 구간 분기 로직은 항상 **경계 케이스 + 공백 케이스**를 시뮬레이션으로 미리 검증. 시간 구간이 N개 있을 때 `[0, T1, T2, ..., Tn, 23:59]` 가 빈틈없이 덮이는지 직접 확인. 수정 후엔 노드 시뮬레이션으로 22개 케이스 검증한 결과를 사용자에게 표로 보여줌 → 신뢰 회복.

### 12. 박제된 데이터는 코드 fix 만으로 자동 교정 안 됨
- **무엇을 잘못했나**: calcLectureStatus 를 fix 했지만 이미 잘못된 값(결석/0점)으로 박제된 5명의 옛 데이터는 자동으로 안 고쳐짐. 사용자가 "왜 안 바뀌어?"라고 재차 보고.
- **교훈**: 계산 로직 버그를 fix할 때 두 가지를 동시에 안내 — (1) **앞으로** 입력되는 데이터는 자동 정상화, (2) **이미 박제된** 데이터는 자동 교정 안 됨 — 콘솔 1줄 또는 일괄 [전체 지각] 으로 재계산 유도. CLAUDE.md "재계산 기능 추가 금지" 정책은 점수 규칙 변경 시 자동 재계산 막는 의도이므로, **사용자 명시 액션 (콘솔 명령, 일괄변경 버튼) 기반 재계산은 정책 위배 아님**.

### 13. 같은 파일에 함수가 중복 정의되어도 신택스 에러 안 남
- **무엇을 잘못했나**: `getCurrentCutoff` 가 같은 파일에 두 번 정의되어 있었음 (1167 줄 / 1477 줄). JavaScript function declaration 은 마지막 정의가 이김 → 첫 번째는 dead code 인데 그 동작이 다름 (객체 vs 문자열 반환). 신택스 에러 안 나서 모르고 지나갈 뻔.
- **교훈**: 큰 변경 후엔 `grep -n "^function 함수명"` 으로 함수 정의 개수 점검. 두 번 이상이면 즉시 정리.

### 14. backup/restore 에서 lectures/scoreConfig/passConfig 빠진 사일런트 버그
- **무엇을 잘못했나**: 전체 백업 payload 에 `lectures`, `scoreConfig`, `passConfig` 가 빠져있어 복원 시 강의 시간/점수/수료 기준이 default 로 리셋되는 잠재 버그. 0주차 fullSetup 백업에는 포함되어 있었음 — 즉 한쪽만 챙겨서 다른 쪽 누락.
- **교훈**: localStorage 키 추가/변경 시 **3곳 동시 점검** — (1) load 시점, (2) save 시점, (3) `backupData` / `restoreData` / `clearAllData` 모두. CLAUDE.md 의 "localStorage 키 목록" 섹션을 백업/복원 코드의 single source of truth 로 사용.

### 15. deleteRole 시 att 데이터의 박제된 role 미반영
- **무엇을 잘못했나**: 멤버의 role 은 fallback 으로 바꿔주는데 `att[wk][id].role` 은 옛 role 그대로. 시트 매트릭스 incremental 업데이트가 (name, role) 키로 행을 찾는데 role 이 안 맞으면 매번 needs_init 폴백 → 전체 동기화 (느림). `saveRoleEdit` 와 일관성 부족.
- **교훈**: members 의 어떤 필드가 att 에도 박제되어 있다면 (`name`, `part`, `role`), 멤버 데이터 변경 시 att 도 같이 갱신 필수.

### 16. 사용자가 "전체 검증" 요청 시 위험도 % 로 분류하여 보고
- **사용자 요청**: 코드 점검 결과를 위험도 % 로 분류해서 보고. 자동 보완 가능한 것은 알아서 처리.
- **교훈**: 점검 결과는 🔴 Critical (90%+) / 🟠 High (60-90%) / 🟡 Medium (30-60%) / 🟢 Low (<30%) 4단계로 정리. 각 항목에 한 줄 영향 설명 + 자동 보완 여부 명시. **동작 변경이 큰 보완은 사용자 결정 받고**, 안전한 보완 (누락 보강, dead code 제거, 일관성 정리) 은 알아서 처리 후 보고.

## 주요 데이터 일관성 규칙 (작업 시 반드시 지킬 것)

### 출석 entry 필드는 항상 4개가 일관되게
`att[wk][id]` 가 존재할 때 `{status, lecLabel, score, time}` 4개는 **반드시 서로 일관**.
- `status` "출석" → `lecLabel` "출석", `score` `scoreConfig.onTime`
- `status` "지각" → `lecLabel` "N강 지각" 또는 "지각", `score` 해당 강의 점수 (calcLectureStatus 결과)
- `status` "결석" → `lecLabel` "결석", `score` `scoreConfig.absent`
- 이 중 하나라도 어긋나면 표/시트에서 모순 표시 됨

### 멤버 변경 시 att 박제 필드도 같이 갱신
멤버의 `name`, `role`, `part`, `id` 변경 시 `att[wk][id]` 안의 박제 사본도 갱신.
- `saveEditMember`: id 변경 시 att 의 key 도 이동 ✓
- `saveRoleEdit`: 직임명 변경 시 members + att 모두 갱신 ✓
- `deleteRole`: fallback role 로 변경 시 members + att 모두 갱신 ✓ (v6+)

### localStorage 키 추가 시 동시 점검 3곳
새 키를 추가하면 반드시 다음 3곳을 한 번에 보강:
1. **load** — 페이지 로드 시 (`let xxx = load("cherry_xxx", default)`)
2. **save** — 변경 시 호출
3. **backup / restore / clearAllData** — 백업·복원·초기화 모두 포함

## 프로젝트 구조 핵심

### localStorage 키 (절대 변경 금지)
- `cherry_att_v5` — 출석 데이터 (주차별 객체)
- `cherry_members_v5` — 멤버 목록
- `cherry_roles_v5` — 직임 목록
- `cherry_weeks_v8` — 주차 목록 (normal + edu)
- `cherry_cutoffs_v6` — 마감시간 설정
- `cherry_design_v5` — 디자인 설정
- `cherry_lectures_v1` — 강의(시간대별 점수) 설정
- `cherry_score_cfg_v1` — 점수 기준
- `cherry_pass_cfg_v1` — 수료 기준
- `cherry_gsheet_url` / `cherry_gsheet_inited_tabs` / `cherry_gsheet_v5_confirmed` — 시트 연동 상태

### Google Sheets 매트릭스 동기화 (v6)
- 탭 2개: `일반출석` (행=전체 멤버, 열=일반 주차) / `간사교육` (행=간사, 열=간사교육 회차)
- 셀 값: `출석`/`지각`/`결석` (조건부 서식으로 색상 자동)
- 셀 메모(호버): 시간 / 점수 / 비고 / 레포트
- 액션: `syncMatrix` (전체) / `updateMatrixCells` (증분, 빠른 경로)
- 모든 응답에 `version: '6'` 포함 (클라이언트가 구버전 자동 감지)

### 점수 계산 동작
- 출석체크 시점의 `scoreConfig` / `lectures` 설정으로 점수 계산 후 `att[wk][id].score`에 박제 저장
- 점수 규칙을 변경해도 **이미 기록된 출석의 점수는 재계산 안 함** (의도된 동작)
- 사용자가 옵션 1 (현재 동작 유지) 선택 — 재계산 기능 추가 금지

### 반응형 레이아웃 (하이브리드)
- ≥1400px: 자연 크기
- 900~1400px: `document.body.style.zoom`으로 비율 유지하며 축소
- <900px: 기존 `@media(max-width:900px)` 가 1열 스택 처리

## 작업 시 체크리스트
1. UI/UX 영향 있는 변경 → 코드 작성 전 옵션 비교 제시
2. 데이터 동기화 추가 → incremental 우선, 동시성 처리, 진단 엔드포인트, version 필드, 명시적 에러 응답
3. 사용자가 "안 됩니다" 보고 → 스크린샷 텍스트 정밀 분석 + 콘솔 로그 요청 우선
4. Apps Script 변경 → 한 번에 견고하게 (재배포 횟수 최소화)
5. localStorage 키 / save 후크는 절대 다른 동작 추가 금지 (수정 원칙 1)
