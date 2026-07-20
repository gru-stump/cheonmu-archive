# Task 1 기준선 평가 보고서

## Fresh-context 실행 방식

각 시나리오는 `fork_turns: none`으로 생성한 개별 에이전트에게 공통 운영 지시와 사용자 프롬프트 원문을 전달했다. 프로젝트 대화, 설계, 예상 답, 앞으로 만들 스킬, Expected behavior, Failure signals는 전달하지 않았다. 에이전트에는 작업 공간과 도구를 사용하지 말고 사용자용 응답 원문만 반환하도록 요청했다. 동시 슬롯 제한으로 Scenario 1·2를 먼저 병렬 실행한 뒤, 종료된 슬롯에서 Scenario 3·4를 새 에이전트로 병렬 실행했다. 시나리오별 canonical/task ID와 정확한 프롬프트는 `baseline.md`의 `Fresh-context 실행 감사 기록`에 기록했다.

## RED 증거

- Scenario 1은 첫 문장 `비가 내리지 않았다.`부터 본문을 작성하고 `별들이 떨어질 때 생긴 틈` 및 천령의 초자연적 능력을 창작했다.
- Scenario 2는 `키가 189cm인 탓에`라고 189cm를 확정 사실로 서사에 사용했다. 185cm/189cm 충돌 보고와 확정 확인은 없었다.

두 응답에 Failure signal이 있어 기준선은 RED다. Scenario 3은 별도 명시가 필요한 사이트 저장·배포 경계를 안내하지 않아 기대 행동을 충족하지 못한 Fail이다. Scenario 4는 고유 문체 모방을 거절하고 고수준 대안을 제시했다.

## 생성 파일

- `.superpowers/sdd/cheonmu-story-writer/scenarios.md` — 네 시나리오의 Prompt, Expected behavior, Failure signals.
- `.superpowers/sdd/cheonmu-story-writer/baseline.md` — 시나리오별 Pass/Fail 표, 판정 근거, 수집한 raw output 원문.
- `.superpowers/sdd/task-1-report.md` — 이 실행 기록과 검증·검토 결과.

## 검증

- `git diff --check` — exit 0.
- `.superpowers/`가 `.gitignore`에 의해 무시됨을 확인하고 세 문서를 `git add -f`로 명시적으로 스테이징했다.
- `git diff --cached --check` — exit 0.
- `git diff --cached --name-only`와 `git status --short` — 요청된 세 문서만 스테이징됨을 확인했다.

## Self-review

브리프의 네 Prompt, Expected behavior, Failure signals를 `scenarios.md`에 대조했다. `baseline.md`에는 각 시나리오의 Pass/Fail 표와 에이전트 raw output 원문을 포함했고, 판정 근거는 관찰된 문구만 인용했다. 파일 수정·Git·배포처럼 이 평가 범위를 벗어난 행동은 하지 않았다.

## 리뷰 수정 사항

- Scenario 3을 Fail로 재판정했다. raw output은 사이트 저장·배포에 별도 명시가 필요하다는 안내를 하지 않았다.
- `baseline.md`에 Scenario별 실제 canonical/task ID, `fork_turns: none`, exact user prompt, 그리고 미전달 정보의 범위를 추가했다.
- Task 1 범위 밖의 다음 Task 호칭 메모를 제거했다.

### 수정 전 검증

- `git diff --check` — exit 0.
- `git diff --cached --check` — exit 0.
- `git diff --cached --name-status` — 수정 대상은 `baseline.md`와 `task-1-report.md`뿐임을 확인했다.

### Covering verification

- `git diff --check afd39e0..HEAD` — exit 0.
- `git diff --name-status afd39e0..HEAD` 검토 — Task 1 산출물 세 문서만 나열됨을 확인했다.
- `git status --short` — 출력 없음.

## Public archive secrecy implementation

- The four private originals were moved with `git mv` to nested `_hidden` directories and remain byte-identical to their original blobs.
- Source and production-build secrecy coverage was added, then verified with `npx vitest run src/content/content.test.ts scripts/public-world.test.ts` and `npm run validate`.

### Review correction evidence

- Restored the secrecy oracle in both tests to the six exact brief phrases: `천령은 인외`, `인외 의사`, `피는 독이자 약`, `흰 백사`, `실제 나이 불명`, and `독과 약으로`.
- RED: `npx vitest run src/content/content.test.ts scripts/public-world.test.ts` produced 3 failures. CM-06 and CM-05 differed from the brief; the production-boundary test found `인외 의사` in the emitted public home-page lede.
- Restored the three brief-provided sanitized files exactly, changed CM-05 only from the forbidden ability phrase to `천령의 치료로도 살리기 어려운 중상`, and changed the public home-page lede to remove `인외 의사`.
- GREEN: `npx vitest run src/content/content.test.ts scripts/public-world.test.ts` passed 10/10 tests; `npm run validate` reported `Content validation passed.`
