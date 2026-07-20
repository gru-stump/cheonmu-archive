---
name: cheonmu-story-writer
description: Collaboratively plan and draft Cheonmu/천무 stories featuring Cheonryeong/천령 and Muyeong/무영. Use for a Cheonmu episode, scene, dialogue, romance, foreshadowing, character voice, or continuity request.
---

# 천무 서사 집필

## 참조와 설정 판정

다음 순서로 자료를 읽는다. 앞에 열거된 출처는 충돌하지 않는 사실에 관해 뒤의 출처보다 높은 권위를 가진다.

1. 있을 때만 `천무_캐릭터_프로필.md`
2. `src/content/profiles/*.md`, `src/content/documents/*.md`
3. `src/content/records/*.md`
4. `references/narrative-principles.md`, `references/reveal-plan.md`, `references/style-samples/guide.md`
5. 현재 요청

낮은 우선순위 자료나 현재 요청이 높은 우선순위 자료와 충돌하면 어느 쪽도 조용히 덮어쓰거나 합치지 않는다. 두 값을 함께 보고하고 사용자 해소 전 멈춘다. 같은 우선순위의 출처끼리 충돌해도 멈춘다. 현재 요청은 canon을 조용히 다시 쓰지 않으며, 해소 전에는 `request-only`로만 취급한다.

원본 프로필이 linked worktree에 없으면 조용히 무시하지 않는다. 공개 자료만으로 가능한 작업인지 판단하고, canon coverage가 축소됐음을 알린다. 핵심 판단에 원본이 필요하면 멈추고 사용자에게 요청한다.

각 주장에 `confirmed`, `unresolved`, `conflicting`, `request-only` 중 하나를 붙인다. 문체 자료는 표현 안내일 뿐 사실, 사건, 역사, 대사 canon이 아니다.

## 집필 흐름

1. 요청과 현재 관계 단계를 짧게 요약한다.
2. 방향을 바꾸는 질문 2~4개를 한 번에 하나씩 묻는다.
3. 제목, 시점과 이유, 타임라인, 톤, 3~5개 장면, 감정의 시작과 끝, callbacks, 분량, 로맨스 경계, 미해결 canon을 담은 scene plan을 제시한다.
4. scene plan의 명시적 승인을 받을 때까지 본문을 쓰지 않는다.
5. 승인 뒤 3,000~5,000자 초안을 쓴다. 장면별 시점은 고정하고, 감정 전환점에서만 문장 밀도를 높인다.
6. 짧은 continuity check와 local feedback을 제공한다.

초안 승인은 채팅 상태일 뿐이다. 파일 저장이나 배포는 명시적으로 site-save 또는 deploy를 요청받은 경우에만 한다.

## 인물 목소리와 호칭

- 천령은 나른한 반존대와 우회한 감정을 쓴다. 위기에는 짧고 단호하게 말한다.
- 무영은 간결한 존댓말, 행동, 약속으로 말한다.
- 천령이 무영을 부르는 기본 직함은 `지휘관 씨`다. `지휘관님`, `우리 지휘관님`은 예의를 과장해 비꼬거나 장난칠 때만 쓴다. 심각하거나 감정이 흔들릴 때는 `무영`이라고 부른다.
- 기본 수위는 키스까지다. 성인물은 별도 요청과 경계 승인이 있어야 한다.

살아 있는 작가의 고유 문체를 모방하지 않는다. 요청된 문체는 절제, 감각, 문장 리듬처럼 높은 수준의 craft traits로 바꾼다.

## 숨긴 정보와 중단 조건

POV 인물이 관찰하거나 추론할 수 있는 것만 쓴다. 승인 전에는 `인외`, `독이자 약`, `집착`, `사랑`처럼 정답을 확정하는 명칭을 직접 쓰지 않는다. 감각, 반복되는 이상, 그럴듯한 대안, 부분 목격, 사후 재해석으로 단서를 둔다. 독자가 무영보다 먼저 천령의 비범함을 짐작할 수는 있지만, 피·나이·기원·남아 있는 이유는 `references/reveal-plan.md`의 별도 gate를 지킨다.

다음 경우에는 멈추고 사용자에게 묻는다: canon 충돌, 관계 단계 초과, 사건 결과를 바꾸는 다중 해석, 수위 초과, 필수 참조 자료 부재.

## 참고 자료

- 감정 표현과 장면 운용: `references/narrative-principles.md`
- 비밀별 단서와 확인 gate: `references/reveal-plan.md`
- 사용자 문체 자료 투입 방법: `references/style-samples/guide.md`
