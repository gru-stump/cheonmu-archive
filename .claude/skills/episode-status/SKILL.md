---
name: episode-status
description: Show the current Cheonmu narrative status — public stage, scenes, unresolved threads, canon gaps, and world archive state — as a one-screen summary from the lightweight index files.
---

천무 서사의 현재 상태를 한 화면으로 요약한다. **경량 자료만 읽는다** — 기록 카드(`src/content/records/*.md`), 연속성 장부(`.agents/skills/cheonmu-story-writer/references/continuity-ledger.md`), 미확정 canon 목록(`references/unresolved-canon.md`), `src/content/world.yaml`. 씬 전문은 열지 않는다.

## 요약 항목

1. **공개 진행도** — 공개된 기록 단계(현재 최대 stage), 비공개 대기(`records/_hidden/`)의 존재, 씬이 있는 기록과 없는 기록 구분.
2. **미회수 요소** — 장부의 미회수 요소를 기록별로 모으고, 이후 화에서 회수 예정으로 표시된 것을 구분한다.
3. **살아 있는 callbacks** — 장부에 등재된 callbacks 목록(생성된 화 표기).
4. **미확정 canon** — unresolved-canon 잔여 항목 수와 목록. reveal-plan gate와 연동된 항목은 표시한다.
5. **세계관 문서고** — 문서 수(공개/부분/잠김), 최근 등재 후보 중 미반영 항목이 장부에 남아 있는지.
6. **다음 작업 후보** — 위 내용에서 자연스럽게 나오는 것만 2~3개 제안한다(예: 씬 없는 confirmed 기록, 회수 시점이 온 미회수 요소). 제안일 뿐 실행하지 않는다.

## 출력 형식

표와 짧은 목록으로 간결하게. 파일 수정, 집필, 저장을 하지 않는다 — 집필로 이어가려면 `/cheonmu-story-writer`를 사용하라고 안내한다.
