---
name: canon-check
description: Audit the Cheonmu archive for canon consistency — ledger vs scene originals, unresolved canon vs profile, world.yaml integrity, and forbidden public phrases. Read-only report; never edits content.
argument-hint: "[전체 | 특정 기록 id]"
---

천무 아카이브의 정합을 감사하고 보고서만 낸다. **이 명령은 읽기 전용이다 — 어떤 파일도 수정하지 않고, 발견 사항의 수정은 사용자가 별도로 요청할 때만 한다.**

인자(`$ARGUMENTS`)로 특정 기록 id가 주어지면 그 기록과 연결 자료만, 없으면 전체를 감사한다.

## 감사 항목

1. **장부 ↔ 원문** — `.agents/skills/cheonmu-story-writer/references/continuity-ledger.md`의 각 행을 원문과 대조한다: 장부가 가리키는 씬 파일 존재 여부, 장부에 행이 없는 씬, 장부의 단서·미회수 요소·callbacks가 씬 원문에 실제로 있는지 스팟체크. 어긋나면 원문이 정본이다.
2. **미확정 canon ↔ 프로필** — `references/unresolved-canon.md`와 `천무_캐릭터_프로필.md` 8장을 대조한다: 이미 확정된 항목이 미확정 목록에 남아 있는지, 프로필에 새로 생긴 미확정 항목이 목록에 빠졌는지.
3. **세계관 문서 무결성** — `src/content/world.yaml`: relatedRecords가 공개 기록만 가리키는지, 문서당 카테고리 1개 규칙, documentNumber 중복, `WORLD_PUBLIC_STAGE`(`src/content/schema.ts`) 초과 revealStage 문단의 존재.
4. **금지 문구 유출** — 공개 경로(`src/content/records/*.md`(`_hidden` 제외), `scenes/`, `documents/*.md`(`_hidden` 제외), `profiles/`, `world.yaml`, `gallery.yaml`)에서 다음을 grep한다: `천령은 인외`, `인외 의사`, `피는 독이자 약`, `흰 백사`, `실제 나이 불명`, `독과 약으로`, `CM-07`, `promise-to-return`, `귀환의 약속`.
5. **호칭 규칙** — 공개 씬에서 단계별 호칭 규칙 위반 여부: 천령→무영 `지휘관 씨`(위기 시 `무영`), 무영→천령 초반(1~3단계) `의료관님` / 4단계 이후 `천령 선생`(감정이 흔들릴 때 `천령`).
6. **자동 검증** — `npm run validate`를 실행해 결과를 첨부한다.

## 보고 형식

심각도별로 나눈 표 하나로 보고한다.

- **오류**: 비밀 유출, 존재하지 않는 참조, 장부와 원문의 사실 충돌
- **경고**: 장부 누락·미갱신, 미확정 목록의 어긋남, 호칭 위반 의심
- **정보**: 회수 가능한 미회수 요소, 세계관 등재 후보 잔여

발견이 없으면 "정합 이상 없음"과 검사 범위를 한 줄로 보고한다.
