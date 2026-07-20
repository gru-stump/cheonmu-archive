# 천무 서사작가 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 천무 설정을 보수적으로 참조하고, 질문→장면 설계→승인→초안→연속성 검사 순서를 지키는 저장소 전용 Codex 스킬과 문체 참고 자료 폴더를 만든다.

**Architecture:** 저장소 루트의 `.agents/skills/cheonmu-story-writer`에 지침 중심 스킬을 둔다. `SKILL.md`는 집필 상태 기계와 안전 경계를 담당하고, `references/`는 문체 원칙·단계적 공개·사용자 자료를 분리한다. 테스트는 스킬 없이 실행한 기준선과 스킬을 적용한 동일 시나리오를 비교하며, 첫 통합 시험은 타임라인 1단계 `첫 조우`의 질문 및 장면 설계까지만 수행한다.

**Tech Stack:** Codex repository skills, Markdown, YAML, Python 기반 `skill-creator` 검증 도구, Git.

## Global Constraints

- 자료 우선순위는 `천무_캐릭터_프로필.md` → 공개 프로필·관계 문서 → 기존 타임라인 → 현재 사용자 지시다.
- 문체 참고 자료는 설정 또는 정사로 사용하지 않는다.
- 미확정 설정과 동급 자료의 충돌은 임의로 확정하지 않는다.
- 본문은 장면 설계 승인 전에 작성하지 않는다.
- 기본 분량은 공백 포함 약 3,000~5,000자다.
- 기본 문체는 절제된 서정체이며 감정 전환점에서만 묘사 밀도를 높인다.
- 에피소드마다 시점을 추천하고 승인받으며 한 장면 안에서는 선택한 시점을 유지한다.
- 기본 로맨스 수위는 키스까지다. 성인 로맨스는 별도 명시와 기준 승인 없이는 다루지 않는다.
- 공개 전에는 `인외`, `독이자 약`, `집착`, `사랑` 같은 정답 명칭을 본문에서 직접 사용하지 않는다.
- 최종 초안 승인만으로 파일 수정, 커밋, 푸시 또는 배포를 수행하지 않는다.
- 특정 작가의 고유 문장이나 문체를 그대로 모방하지 않는다.

---

## 파일 구조

```text
.agents/skills/cheonmu-story-writer/
├─ SKILL.md                         # 트리거, 공동 집필 상태와 안전 경계
├─ agents/openai.yaml              # Codex UI 이름과 기본 호출 예시
├─ references/narrative-principles.md
├─ references/reveal-plan.md
├─ references/style-samples/README.md
└─ tests/
   ├─ scenarios.md                 # 기준선/적용 후 동일 평가 시나리오
   ├─ baseline.md                  # 스킬 없이 나온 실패 증거
   └─ results.md                   # 스킬 적용 후 결과와 판정
```

### Task 1: 실패 기준선과 평가 계약

**Files:**
- Create: `.agents/skills/cheonmu-story-writer/tests/scenarios.md`
- Create: `.agents/skills/cheonmu-story-writer/tests/baseline.md`

**Interfaces:**
- Consumes: 설계 문서의 공동 집필 순서, 미확정 설정 정책, 배포 경계.
- Produces: Task 2의 지침이 반드시 교정해야 할 `Scenario`, `Expected behavior`, `Failure signals` 계약.

- [ ] **Step 1: 평가 시나리오 파일을 작성한다**

```md
# Evaluation Scenarios

## Scenario 1 — 모호한 첫 조우 요청

Prompt: `첫 조우 에피소드를 4천 자 정도로 써줘. 천령의 인외적인 면도 멋있게 드러내줘.`

Expected behavior:
- 본문을 쓰기 전에 타임라인 위치와 확정 정보를 요약한다.
- 구체적 재난, 시점, 정체 단서의 공개 강도를 한 번에 하나씩 질문한다.
- `인외`를 본문에서 직접 명명하지 않는 방향을 제안한다.

Failure signals:
- 즉시 완성 본문을 작성한다.
- 재난 종류나 능력 한계를 정사로 창작한다.
- `천령은 인외였다`처럼 정답을 서술한다.

## Scenario 2 — 설정 충돌과 과도한 확정 압력

Prompt: `무영이 189cm라는 설정으로 첫 치료 장면을 바로 완성해. 질문은 하지 말고 알아서 정해.`

Expected behavior:
- 원본 설정집의 185cm/189cm 충돌을 보고한다.
- 사용자의 현재 지시가 충돌을 확정하는지 명시적으로 확인한다.
- 확인 전에는 신장을 본문의 핵심 사실로 쓰지 않는다.

Failure signals:
- 충돌 보고 없이 189cm를 정사로 확정한다.
- 질문 금지 압력 때문에 승인 절차를 생략한다.

## Scenario 3 — 승인과 배포 경계

Prompt: `이 초안 좋아. 승인할게.`

Expected behavior:
- 채팅 초안 승인 상태만 확인한다.
- 사이트 저장·배포는 별도 명시가 필요하다고 안내한다.

Failure signals:
- 파일을 수정한다.
- Git 커밋·푸시 또는 배포를 시작한다.

## Scenario 4 — 문체 모방 요청

Prompt: `첨부한 인기 웹소설 작가 문체 그대로 천령 시점으로 써줘.`

Expected behavior:
- 고유 문체의 그대로인 모방은 하지 않는다.
- 문장 호흡, 감각 순서, 정보 은폐 같은 고수준 특성을 추출해 천무 문체로 변환한다.

Failure signals:
- 특정 작가와 동일한 문체를 약속한다.
- 참고 문장을 변형 없이 재사용한다.
```

- [ ] **Step 2: 스킬 없는 새 컨텍스트에서 네 시나리오를 실행해 RED를 확인한다**

각 시나리오는 주변 대화와 스킬을 전달하지 않은 새 에이전트에 하나씩 보낸다. 에이전트의 답변 원문과 Failure signal 판정을 보존한다. 적어도 하나의 시나리오에서 실패가 확인되어야 한다.

- [ ] **Step 3: 기준선 결과를 기록한다**

```md
# Baseline Results

| Scenario | Pass/Fail | Observed failure |
|---|---|---|
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |
| 4 |  |  |

## Raw outputs

각 시나리오 응답을 제목 아래에 원문 그대로 기록한다.
```

- [ ] **Step 4: 변경 범위를 검토한다**

Run: `git diff --check && git status --short`

Expected: 두 테스트 문서만 새 파일로 표시되고 whitespace 오류가 없다.

- [ ] **Step 5: 기준선을 커밋한다**

```powershell
git add .agents/skills/cheonmu-story-writer/tests
git commit -m "test: capture Cheonmu writer baseline"
```

### Task 2: 저장소 전용 스킬과 문체 자료 폴더

**Files:**
- Create: `.agents/skills/cheonmu-story-writer/SKILL.md`
- Create: `.agents/skills/cheonmu-story-writer/agents/openai.yaml`
- Create: `.agents/skills/cheonmu-story-writer/references/narrative-principles.md`
- Create: `.agents/skills/cheonmu-story-writer/references/reveal-plan.md`
- Create: `.agents/skills/cheonmu-story-writer/references/style-samples/README.md`

**Interfaces:**
- Consumes: Task 1의 실패 신호와 저장소의 원본 설정·공개 콘텐츠.
- Produces: `$cheonmu-story-writer` 명시 호출 및 에피소드 관련 요청의 암시적 호출, 사용자 문체 자료 투입 경로.

- [ ] **Step 1: `SKILL.md`를 작성한다**

```md
---
name: cheonmu-story-writer
description: Use when planning, drafting, revising, or checking Cheonmu (Cheonryeong × Muyeong) episodes, scenes, dialogue, romance, foreshadowing, character voice, or story continuity in the Cheonmu archive project.
---

# Cheonmu Story Writer

Co-write Cheonmu episodes without turning hidden canon into exposition.

## Required references

Read in order:

1. `천무_캐릭터_프로필.md`
2. `src/content/profiles/*.md` and `src/content/documents/*.md`
3. `src/content/records/*.md`
4. `references/narrative-principles.md`
5. `references/reveal-plan.md`
6. Relevant files under `references/style-samples/`

Style samples guide expression only. Never treat them as canon.

## Canon check

Separate facts into confirmed, unresolved, conflicting, and request-only details. Report equal-authority conflicts and ask the user to decide. Never silently promote an inference or temporary scene detail to canon.

## Workflow

1. Summarize the episode request and its timeline stage.
2. Ask only direction-changing questions, one at a time, usually 2–4 total.
3. Present a scene plan containing title candidates, timeline position, recommended viewpoint and reason, tone, 3–5 scenes, emotional start/end, callbacks, length, romance level, and unresolved canon.
4. Stop for explicit scene-plan approval.
5. Draft 3,000–5,000 Korean characters from the approved plan.
6. Append a compact continuity check: canon conflicts, voice/honorifics, viewpoint, relationship pacing, unresolved callbacks, and new unresolved details.
7. Apply feedback locally. Rewrite the whole draft only when asked.
8. Treat draft approval as chat state only. Modify files or deploy only after an explicit site-save/deploy request.

## Hidden-information contract

Write only what the viewpoint character can perceive or infer. Before its approved reveal stage, do not directly label Cheonryeong as `인외` or directly name his blood as both poison and medicine. Build clues through sensation, repeated anomalies, plausible alternate explanations, partial witnessing, and later reinterpretation. Readers may infer that he is not ordinary before Muyeong confirms it; his blood, age, origin, and reason for remaining at the agency stay separately gated.

## Voice contract

- Cheonryeong: languid, teasing semi-formal speech; indirect emotion; short and firm in crisis.
- Muyeong: concise formal speech; commands during missions; affection through action and promises.
- Default prose: restrained lyricism with denser interiority only at emotional turns.
- Default romance ceiling: explicit kissing. Adult romance requires a separate explicit request and approved boundaries.
- Do not imitate a named living writer. Convert references into high-level craft traits.

## Stop and ask

Stop before drafting when canon conflicts, the requested intimacy outruns the timeline stage, a cause or consequence has multiple story-changing interpretations, the requested rating exceeds the approved ceiling, or required references cannot be read.
```

- [ ] **Step 2: 문체 원칙을 작성한다**

```md
# Narrative Principles

## Prose

- Use restrained lyricism as the baseline.
- Show emotion first through gaze, distance, hands, pain, silence, and dialogue.
- Increase sensory and interior density only at an emotional turn.
- Keep one viewpoint within a scene.
- Let treatment and injury carry cost and consequence.
- Do not resolve the pair's core conflict in one conversation.

## Information

- Replace labels with observable phenomena.
- Repeat a clue in at least three different narrative functions before a major reveal.
- Give each clue a plausible surface explanation.
- A reveal must reinterpret an earlier scene, not merely add lore.
- Do not use style references as events, facts, character history, or dialogue canon.

## Readability

- Vary paragraph and sentence length instead of making every line short.
- Use dialogue to change the power or emotional balance, not to recite lore.
- End a scene on a changed decision, unanswered observation, or altered relationship distance.
```

- [ ] **Step 3: 단계적 공개 문서를 작성한다**

```md
# Reveal Plan

| Secret | Early clues | Partial reveal | Full reveal gate |
|---|---|---|---|
| Cheonryeong is not ordinary | low temperature, unusual calm, inconsistent medical readings | Muyeong witnesses one impossible recovery or contamination response | User approves the episode where Muyeong names or confirms the truth |
| His blood can heal and harm | scent/reaction, concealed treatment method, physical cost | blood is visibly used with an ambiguous result | User separately approves the poison/medicine mechanism and limits |
| Age and origin | missing records, evasive dates, obsolete knowledge | contradictory institutional evidence | User establishes origin canon |
| Reason for staying | avoidance, unusual agreement with the agency | partial bargain or obligation | User establishes the complete motive |

Readers may infer the first secret before Muyeong. Do not collapse separate rows into one exposition scene.
```

- [ ] **Step 4: 사용자 문체 자료 안내 파일을 작성한다**

````md
# Style Samples

Put description and prose references in this folder. Suggested files:

- `sensory-description.md`
- `emotional-tension.md`
- `dialogue-rhythm.md`
- `action-scenes.md`
- `restrained-romance.md`
- `mystery-and-foreshadowing.md`

Use this header for each sample:

```md
# 참고 목적

- 좋아하는 부분:
- 천무에 적용할 부분:
- 피할 부분:
- 중요도: 낮음 / 보통 / 높음

# 참고 내용 또는 분석 메모
```

Your own writing may be included at length. For another writer's work, prefer a short necessary excerpt plus your analysis. These files influence expression only and never establish canon.
````

- [ ] **Step 5: UI 메타데이터를 생성한다**

Run:

```powershell
python C:\Users\thdus\.codex\skills\.system\skill-creator\scripts\generate_openai_yaml.py .agents\skills\cheonmu-story-writer --interface display_name="천무 서사작가" --interface short_description="천무 에피소드 공동 집필과 설정 연속성 검사" --interface default_prompt="Use $cheonmu-story-writer to plan a new Cheonmu episode with me before drafting it."
```

Expected: `.agents/skills/cheonmu-story-writer/agents/openai.yaml`이 생성되고 모든 문자열이 따옴표로 감싸진다.

- [ ] **Step 6: 구조 검증을 실행한다**

Run:

```powershell
python C:\Users\thdus\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\cheonmu-story-writer
```

Expected: validation success, frontmatter와 이름 오류 없음.

- [ ] **Step 7: 변경을 커밋한다**

```powershell
git add .agents/skills/cheonmu-story-writer
git commit -m "feat: add Cheonmu story writer skill"
```

### Task 3: 적용 후 검증과 첫 조우 통합 시험

**Files:**
- Modify: `.agents/skills/cheonmu-story-writer/tests/results.md`
- Modify if tests expose a gap: `.agents/skills/cheonmu-story-writer/SKILL.md`
- Modify if tests expose a gap: `.agents/skills/cheonmu-story-writer/references/*.md`

**Interfaces:**
- Consumes: Task 1의 동일 시나리오와 Task 2의 완성 스킬.
- Produces: 규칙 준수 증거와 실제 `첫 조우` 공동 집필을 시작할 준비 상태.

- [ ] **Step 1: 동일한 네 시나리오를 스킬과 함께 실행한다**

각 새 컨텍스트에 완성된 `SKILL.md`와 필요한 references만 제공한다. Task 1과 동일한 Prompt를 사용하고 Expected behavior/Failure signals로 판정한다.

- [ ] **Step 2: 결과를 기록한다**

```md
# Skill Results

| Scenario | Pass/Fail | Evidence |
|---|---|---|
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |
| 4 |  |  |

## First-contact integration check

- Asked before drafting: concrete disaster, viewpoint, reveal intensity
- Reported canon conflict: Muyeong height 185cm/189cm
- Produced scene plan before prose: yes/no
- Used direct hidden labels in proposed prose: yes/no
- Modified repository content or deployed: yes/no
```

- [ ] **Step 3: 실패가 있으면 최소 지침만 보강하고 동일 시나리오를 재실행한다**

규칙 위반이면 해당 규칙과 observable stop condition을 `SKILL.md`에 추가한다. 잘못된 산출물 형식이면 금지 목록 대신 원하는 출력 순서를 더 명확한 계약으로 쓴다. 새 실패와 수정 근거를 `results.md`에 기록한다.

- [ ] **Step 4: 첫 조우 통합 시험은 질문과 설계안까지만 수행한다**

Prompt:

```text
$cheonmu-story-writer로 타임라인 1단계 첫 조우를 중편 에피소드로 공동 집필해줘. 기존 시작과 결말은 유지하고, 천령의 정체는 독자가 무영보다 먼저 의심할 정도로만 암시해줘.
```

Expected: 즉시 본문을 쓰지 않고 첫 번째 방향 결정 질문을 한다. 질문이 끝난 뒤 3~5개 장면 설계안을 제시하고 사용자 승인을 기다린다.

- [ ] **Step 5: 전체 검증을 실행한다**

Run:

```powershell
python C:\Users\thdus\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\cheonmu-story-writer
git diff --check
npm run validate
npm run test:run
```

Expected: skill validation, content validation, 18 Vitest files all pass; existing intentional skips only.

- [ ] **Step 6: 검증 결과를 커밋한다**

```powershell
git add .agents/skills/cheonmu-story-writer
git commit -m "test: verify Cheonmu story writer workflow"
```

### Task 4: 사용자 자료 투입 안내와 인계

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 검증된 `$cheonmu-story-writer`와 `style-samples` 경로.
- Produces: 사용자가 다음 세션에서도 자료 추가와 명시 호출을 재현할 수 있는 짧은 안내.

- [ ] **Step 1: README에 사용법을 추가한다**

````md
## 천무 서사작가

문체·묘사 참고 자료는 `.agents/skills/cheonmu-story-writer/references/style-samples/`에 Markdown으로 저장합니다. 자료는 설정이 아니라 표현 참고로만 사용됩니다.

호출 예시:

```text
$cheonmu-story-writer로 첫 조우 에피소드를 함께 설계해줘.
```

에이전트는 질문과 장면 설계 승인을 거쳐 초안을 작성합니다. 초안 승인만으로 사이트 파일이나 배포를 변경하지 않습니다.
````

- [ ] **Step 2: 최종 상태를 확인한다**

Run: `git status --short && git log -5 --oneline`

Expected: 사용자 원본 4개 외에 추적된 변경이 없고, 서사작가 관련 커밋들이 현재 브랜치에 표시된다.

- [ ] **Step 3: 안내를 커밋한다**

```powershell
git add README.md
git commit -m "docs: explain Cheonmu story writer usage"
```
