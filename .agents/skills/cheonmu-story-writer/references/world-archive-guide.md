# 세계관 문서(world.yaml) 연동 안내

공개 세계관은 `src/content/world.yaml` 하나로 관리되며 사이트의 `/#/world` 세계관 기록실에 표시된다. 이 문서의 사실은 공개 canon이다. 에피소드가 세계관 문서와 충돌하면 canon 충돌로 처리한다.

## 읽기

에피소드를 기획하거나 기록철 문서를 쓰기 전에 관련 카테고리의 문서를 읽는다. 특히 자주 걸리는 문서: WF-04(격리·철수 절차), WF-05(오염과 치료), WF-07(의료 지원 배속), OB 계열(관측 기록).

## 문서 형식 (스키마: `src/content/schema.ts`의 `worldDocumentSchema`)

| 필드 | 규칙 |
| --- | --- |
| `id` | kebab-case, 전체 콘텐츠에서 유일 |
| `documentNumber` | `WF-NN`(제도·기관), `OB-NN`(관측 기록), `CL-NN`(제한·기밀). 중복 금지 |
| `categories` | enum: `organization`, `field-response`, `medical`, `anomaly`, `observation`, `classified`. **정확히 1개만** — 2개 이상이면 색인에 중복 표시되어 테스트가 깨진다 |
| `status` / `clearance` | `public`/공개 열람, `partial`/부분 공개, `locked`/제한 열람 |
| `basisStage` | 문서의 가장 깊은 사실이 근거하는 기록 stage |
| `explanation` | 화면에서 "쉽게 말하면 — " 뒤에 붙는 한 문장 |
| `sections[].revealStage` | 해당 사실이 드러난 기록의 stage와 맞춘다. `WORLD_PUBLIC_STAGE`(현재 6, `schema.ts`) 초과 문단은 화면에 표시되지 않는다 |
| `relatedRecords` | 공개 기록(id)만. `_hidden` 기록 참조 시 validate가 실패한다 |
| `lockLabel` | `locked` 문서에만 |

## 비밀 유지 (공개 빌드 검사와 연동)

`scripts/public-world.test.ts`와 `src/content/content.test.ts`가 공개 산출물에서 다음 문구를 검사한다. 세계관 문단·기록·씬 어디에도 쓰지 않는다.

- `천령은 인외`, `인외 의사`, `피는 독이자 약`, `흰 백사`, `실제 나이 불명`, `독과 약으로`
- 미공개 기록 마커: `CM-07`, `promise-to-return`, `귀환의 약속`

비밀에 닿는 사실은 **관측된 현상 + 그럴듯한 표면 설명 병기** 원칙으로만 쓴다(예: 경보 무반응 → 응급 경력의 둔감화). 정답을 확정하는 서술은 `reveal-plan.md`의 gate를 통과한 뒤에만 가능하다.

## 고정 문구 (테스트가 참조 — 수정 금지, 문단 추가로만 심화)

- WF-01 제목 `특수재난관리청`
- CL-01 문단 `신원 기록 일부 불일치.`, `특정 오염 상황에서 비정상 반응 관측.`, lockLabel `추가 기록 확인 후 해금`
- 기존 문단은 지우거나 고치지 말고, 새 문단이나 새 section을 추가하는 방식으로 확장한다.

## 갱신 흐름

1. 에피소드 초안의 `새로 도입한 사실` 중 세계 층위 사실(제도, 기관, 절차, 현상, 관측)을 등재 후보로 추린다. 인물 내면·관계 사실은 세계관 문서에 넣지 않는다.
2. site-save 요청을 받으면 씬 저장과 함께 세계관 갱신안을 제시한다: 기존 문서 문단 추가(우선) 또는 신규 문서(번호 체계 유지).
3. 사용자가 확인한 항목만 `world.yaml`에 반영한다.
4. 반영 후 `npm run validate`와 `npm run test:run`을 실행해 스키마·비밀 유지·색인 테스트를 확인한다.
