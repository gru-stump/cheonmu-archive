# World Archive Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CM-01~CM-06에서 공개된 정보만 담은 단계형 세계관 기록실을 추가하고, 기존 공개 아카이브에서 천령의 비밀 설정을 우회 열람할 수 없게 한다.

**Architecture:** 공개용 세계관 데이터는 `src/content/world.yaml`에만 두고 Zod로 파싱하여 `ArchiveContent.world`에 포함한다. `WorldPage`는 `#/world/:documentId?`에서 색인과 문서를 렌더링하며, 현재 공개 단계 `6` 이하의 섹션만 표시한다. 전체 설정 원본은 기존 직접 하위 glob이 읽지 않는 `_hidden` 폴더로 이동하고 공개본은 CM-06 관측 범위로 축소한다.

**Tech Stack:** React 19, React Router 7, TypeScript, Vite, YAML, Zod, Vitest, Testing Library, Playwright, CSS

## Global Constraints

- 공개 기준 시점은 정확히 `CM-06`, 숫자 단계는 `6`이다.
- 상단 메뉴 순서는 `천무 · 기록철 · 세계관 · 아카이브`다.
- 세계관 주소는 `#/world`와 `#/world/:documentId`다.
- 세계관 본문이나 공개 프로필에서 천령을 `인외`라고 직접 명명하지 않는다.
- 천령의 피의 성질, 실제 나이와 기원, 동물화, 특재청 잔류 이유, 능력 원리·한계, 오염 내성을 공개하지 않는다.
- 낮은 체온, 불안정한 측정값, 설명하기 어려운 치료 반응은 관측 사실로만 표시한다.
- 잠긴 영역에는 미래 비밀 원문을 저장하거나 CSS로 숨기지 않고 `추가 기록 확인 후 해금`만 표시한다.
- 기존 전체 설정·프로필·관계·CM-06 원문은 `_hidden` 하위에 원형 그대로 보관하며 공개 glob과 검증 컬렉션에서 제외한다.
- 공개 세계관 데이터에는 CM-01~CM-06에 실제로 존재하는 관련 기록 ID만 사용한다.
- 사용자 PDF, PNG, 루트의 프로필 원문 Markdown을 수정·이동·스테이징·커밋하지 않는다.
- 이 계획에는 배포가 포함되지 않는다.

---

### Task 1: 공개 아카이브를 CM-06 기밀 기준으로 정리

**Files:**
- Move: `src/content/documents/settings.md` → `src/content/documents/_hidden/settings.md`
- Move: `src/content/profiles/cheonryeong.md` → `src/content/profiles/_hidden/cheonryeong-full.md`
- Create: `src/content/profiles/cheonryeong.md`
- Move: `src/content/documents/relationship.md` → `src/content/documents/_hidden/relationship-full.md`
- Create: `src/content/documents/relationship.md`
- Move: `src/content/records/06-keeping-distance.md` → `src/content/records/_hidden/06-keeping-distance-full.md`
- Create: `src/content/records/06-keeping-distance.md`
- Modify: `src/content/records/05-fracture.md`
- Test: `src/content/content.test.ts`
- Create: `scripts/public-world.test.ts`

**Interfaces:**
- Consumes: existing direct-child Vite globs in `src/content/load.ts`.
- Produces: sanitized public profile/document/record files; byte-preserved full originals in ignored nested directories.

- [ ] **Step 1: Write failing public-secrecy tests**

Add exact assertions to `src/content/content.test.ts`:

```ts
const FORBIDDEN_PUBLIC_SECRETS = [
  '천령은 인외',
  '인외 의사',
  '피는 독이자 약',
  '흰 백사',
  '실제 나이 불명',
  '독과 약으로',
];

it('keeps direct identity and ability disclosures out of public content', () => {
  const content = loadAllContent();
  const publicText = JSON.stringify({
    profiles: content.profiles,
    documents: content.documents,
    records: content.records,
  });

  expect(content.documents.map((item) => item.id)).not.toContain('settings');
  for (const secret of FORBIDDEN_PUBLIC_SECRETS) {
    expect(publicText).not.toContain(secret);
  }
});

it('keeps the CM-06 relationship stage without naming the hidden identity', () => {
  const stageSix = loadAllContent().records.find((record) => record.stage === 6);

  expect(stageSix?.id).toBe('keeping-distance');
  expect(stageSix?.body).toContain('통제 밖으로 벗어나는 것을 견디지 못하는 치료자');
  expect(stageSix?.body).not.toContain('인외');
  expect(stageSix?.quote).toBe('누가 가볍다고 판단했어요?');
});

it('describes CM-05 treatment without confirming a hidden ability', () => {
  const stageFive = loadAllContent().records.find((record) => record.stage === 5);
  expect(stageFive?.body).toContain('천령의 치료로도 살리기 어려운 중상');
  expect(stageFive?.body).not.toContain('천령의 능력');
});
```

Create `scripts/public-world.test.ts` with a real production build boundary test:

```ts
// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

const outputs: string[] = [];
const FORBIDDEN_PUBLIC_SECRETS = [
  '천령은 인외', '인외 의사', '피는 독이자 약',
  '흰 백사', '실제 나이 불명', '독과 약으로',
];

async function emittedText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return emittedText(path);
    return ['.html', '.js', '.css', '.map'].includes(extname(entry.name))
      ? readFile(path, 'utf8')
      : '';
  }));
  return chunks.join('\n');
}

afterEach(async () => {
  await Promise.all(outputs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('public world production boundary', () => {
  it('excludes private canon phrases from emitted public assets', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cheonmu-public-world-'));
    outputs.push(outDir);
    await build({
      configFile: resolve('vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    const bundle = await emittedText(outDir);

    for (const phrase of FORBIDDEN_PUBLIC_SECRETS) {
      expect(bundle).not.toContain(phrase);
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/content/content.test.ts scripts/public-world.test.ts
```

Expected: both new tests fail because `settings`, the full profile/relationship, and CM-06 direct label are still public.

- [ ] **Step 3: Move originals and create the sanitized public files**

Use `git mv` for the three full originals so history and exact bytes are preserved. Recreate the direct-child public files with these contents.

`src/content/profiles/cheonryeong.md`:

```md
---
id: cheonryeong
title: "천령 (天靈 | Cheonryeong)"
height: 186cm
---

## 공개 신상

- 성별: 남성
- 연령대: 외관상 20대
- 직업: 의사 · 연구원
- 소속: 특재청 제3의료센터
- 역할: 특수재난 부상자 치료와 현장 의료 지원

## 외형과 체형

희고 창백한 피부와 옅은 머리색. 가늘고 긴 체형으로, 근육이 크게 드러나지 않는 유연한 장신. 나른하게 처진 눈매와 속내를 읽기 어려운 미소가 특징이다.

전통 장식이 섞인 의료복과 백색 가운을 착용한다. 붉은 장식과 탁한 녹색 계열이 주요 포인트 컬러다. 체온이 낮고 손끝이 차갑다는 관측이 반복된다.

## 성격

나른하고 능글맞으며 웬만한 상황에도 여유를 잃지 않는다. 상대를 직접 위로하기보다 말을 던져 반응을 살피고, 장난스러운 태도로 자신의 속내를 감춘다.

사람을 살리지만 그 이유를 좀처럼 설명하지 않는다. 관심이 오래 이어질수록 치료와 관찰의 경계가 흐려지며, 정말 소중한 대상이 죽을 위기에 놓이면 웃음과 여유가 사라진다.

## 말투

- 존댓말과 반말이 자연스럽게 섞이는 반존대.
- 느리고 나른한 말투.
- 감정을 직접 고백하지 않고 농담이나 관찰을 가장해 우회함.
- 심각한 상황에서는 말이 짧고 단호해짐.

> “죽게 두기엔, 아직 조금 아깝잖아.”

> “눈 떠. 지금 자면 안 돼.”

## 관측 제한

신원 기록과 일부 의료 기록은 열람이 제한되어 있다. 반복되는 이상 반응은 세계관 기록실의 관측 문서에서 확인할 수 있다.
```

`src/content/documents/relationship.md`:

```md
---
id: relationship
title: "천무 관계 프로필"
---

## 기본 관계

- 페어명: 천무 (天無)
- 조합: 천령 × 무영
- 관계의 출발: 치료자와 중상 환자
- 관계의 중심: 반복되는 귀환과 치료
- 갈등의 중심: 생명을 대하는 기준과 자기희생
- 공개 단계: 흥미와 경계 → 익숙함 → 불쾌한 신뢰 → 애착과 거리 두기

## Where you return, I remain.

**당신이 돌아올 곳에, 내가 있다.**

사람을 두고 나오지 못하는 현장 지휘관 무영과, 그런 지휘관을 죽게 두지 못하는 의사 천령. 서로의 방식도 선택도 이해하지 못하지만 가장 위태로운 순간이면 누구보다 먼저 상대를 찾는다.

반복되는 구조와 치료 속에서 불신은 불쾌할 만큼 단단한 신뢰로 변했다. 그러나 서로를 보호하려는 선택은 CM-06에서 오히려 두 사람 사이의 거리를 벌리고 있다.

## 서로를 바라보는 시선

### 천령이 생각하는 무영

**고집스러운 환자**

자기 몸은 함부로 쓰면서 남은 버리지 못하는 사람. 처음에는 어디까지 버티는지 궁금했지만, 이제 돌아오지 않으면 곤란한 환자다.

### 무영이 생각하는 천령

**죽음을 허락하지 않는 사람**

생명을 대하는 방식도 자신을 바라보는 눈도 이해할 수 없다. 그러나 천령이 살릴 수 있다고 말하면 믿게 된다.

## 호칭

### 천령 → 무영

- 지휘관 씨
- 지휘관님 / 우리 지휘관님 — 일부러 예의를 과장해 비꼬거나 장난칠 때만 사용
- 환자분
- 고질적인 환자

### 무영 → 천령

- 천령
- 천령 선생
- 선생님
- 의료관님

## 관계가 깊어진 뒤의 변화

- 천령은 평소 ‘지휘관 씨’라고 부른다. 심각하거나 감정이 흔들리는 순간에는 ‘무영’이라고만 부른다.
- 무영은 초반에는 ‘의료관님’을 기본으로 쓰다가 관계가 쌓인 뒤에는 ‘천령 선생’이라 부른다. 감정이 흔들릴 때는 ‘천령’이라고만 부른다.
```

`src/content/records/06-keeping-distance.md`:

```md
---
id: keeping-distance
recordNumber: CM-06
title: "거리 두기"
stage: 6
status: confirmed
characters: [cheonryeong, muyeong]
tags: [거리, 보호, 통제]
# CM-07 공개 시 promise-to-return을 related에 복원할 것
related: [fracture]
quote: "누가 가볍다고 판단했어요?"
cinematic: false
---

**보호하기 위해 피하는 인간과, 통제 밖으로 벗어나는 것을 견디지 못하는 치료자.**

> “요즘은 나한테 안 오네.”
>
> “가벼운 부상이었습니다.”
>
> “누가 가볍다고 판단했어요?”
```

In `src/content/records/05-fracture.md`, replace only `천령의 능력으로도 살리기 어려운 중상` with `천령의 치료로도 살리기 어려운 중상`. Preserve the rest of CM-05 exactly.

- [ ] **Step 4: Run focused tests and content validation**

Run:

```powershell
npx vitest run src/content/content.test.ts scripts/public-world.test.ts
npm run validate
```

Expected: tests pass and `Content validation passed.`

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/content/documents src/content/profiles src/content/records src/content/content.test.ts scripts/public-world.test.ts
git commit -m "content: align public archive with CM-06 secrecy"
```

---

### Task 2: 세계관 데이터 모델·로더·검증 추가

**Files:**
- Create: `src/content/world.yaml`
- Modify: `src/content/schema.ts`
- Modify: `src/content/load.ts`
- Modify: `src/content/validation.ts`
- Modify: `scripts/validate-content.ts`
- Modify: `editor/archive-persistence.ts`
- Test: `src/content/frontmatter.test.ts`
- Test: `src/content/content.test.ts`
- Test: `editor/storage.test.ts`
- Modify fixtures that construct `ArchiveContent`: `src/features/archive/ArchivePage.test.tsx`
- Test: `scripts/public-world.test.ts`

**Interfaces:**
- Produces: `WORLD_PUBLIC_STAGE = 6`, `WorldDocument`, `worldSchema`, and required `ArchiveContent.world: WorldDocument[]`.
- Produces: `visibleWorldSections(document, stage = WORLD_PUBLIC_STAGE): WorldSection[]`.
- Consumes: public records for `relatedRecords` validation.

- [ ] **Step 1: Write failing schema, loader, and validation tests**

Add tests that parse one world document, filter sections by stage, and reject missing related records and duplicate IDs/numbers:

```ts
it('loads staged world documents and exposes only released sections', () => {
  const content = loadContentFromSources({}, undefined, true, `
- id: agency
  documentNumber: WF-01
  title: Agency
  categories: [organization]
  status: public
  clearance: public
  basisStage: 1
  summary: Summary
  explanation: Explanation
  sections:
    - revealStage: 1
      paragraphs: [Visible]
    - revealStage: 7
      paragraphs: [Future]
  relatedRecords: []
`);

  expect(content.world[0].sections).toHaveLength(2);
  expect(visibleWorldSections(content.world[0])).toEqual([
    { revealStage: 1, paragraphs: ['Visible'] },
  ]);
});

it('rejects duplicate world identifiers and missing record links', () => {
  const worldFixture = (overrides: Partial<WorldDocument> = {}): WorldDocument => ({
    id: 'world-entry', documentNumber: 'WF-99', title: 'World entry',
    categories: ['organization'], status: 'public', clearance: 'Public',
    basisStage: 1, summary: 'Summary', explanation: 'Explanation',
    sections: [], relatedRecords: [], ...overrides,
  });
  const result = validateContent({
    records: [], scenes: [], profiles: [], documents: [], gallery: [],
    world: [
      worldFixture({ id: 'same', documentNumber: 'WF-01', relatedRecords: ['missing'] }),
      worldFixture({ id: 'same', documentNumber: 'WF-01' }),
    ],
  });

  expect(result.errors).toEqual(expect.arrayContaining([
    'Duplicate world document ID: same',
    'Duplicate world document number: WF-01',
    'World document same references missing record ID: missing',
  ]));
});
```

Add `world: []` to every explicit `ArchiveContent` fixture. Add this editor regression so prospective mutations still validate `world.yaml` relationships:

```ts
it('includes world record relationships in prospective archive validation', async () => {
  const rootDir = await makeRoot();
  await writeFile(join(rootDir, 'src', 'content', 'world.yaml'), `
- id: broken-world
  documentNumber: WF-99
  title: Broken world
  categories: [organization]
  status: public
  clearance: Public
  basisStage: 1
  summary: Summary
  explanation: Explanation
  sections: []
  relatedRecords: [missing-record]
`, 'utf8');
  const storage = createEditorStorage({ rootDir });

  await expect(storage.writeEntry('profiles', 'entry', simpleSource('entry')))
    .rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: { archive: expect.stringContaining('missing-record') },
    });
});
```

Extend the production boundary test after the world YAML is introduced:

```ts
expect(bundle).toContain('특수재난관리청');
expect(bundle).toContain('신원 기록 일부 불일치');
expect(bundle).toContain('추가 기록 확인 후 해금');
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npx vitest run src/content/frontmatter.test.ts src/content/content.test.ts editor/storage.test.ts
```

Expected: compile/test failures because the world types, loader argument, and validation do not exist.

- [ ] **Step 3: Add the exact schemas and selector**

In `src/content/schema.ts` add:

```ts
export const WORLD_PUBLIC_STAGE = 6;
export const worldCategorySchema = z.enum([
  'organization', 'field-response', 'medical', 'anomaly', 'observation', 'classified',
]);
export const worldStatusSchema = z.enum(['public', 'partial', 'locked']);
export const worldSectionSchema = z.object({
  revealStage: z.number().int().min(1).max(8),
  paragraphs: z.array(nonEmptyText).min(1),
});
export const worldDocumentSchema = z.object({
  id: contentId,
  documentNumber: nonEmptyText,
  title: nonEmptyText,
  categories: z.array(worldCategorySchema).min(1),
  status: worldStatusSchema,
  clearance: nonEmptyText,
  basisStage: z.number().int().min(1).max(8),
  summary: nonEmptyText,
  explanation: nonEmptyText,
  sections: z.array(worldSectionSchema),
  relatedRecords: z.array(contentId),
  lockLabel: nonEmptyText.optional(),
});
export const worldSchema = z.array(worldDocumentSchema);
export type WorldCategory = z.infer<typeof worldCategorySchema>;
export type WorldDocument = z.infer<typeof worldDocumentSchema>;
export type WorldSection = z.infer<typeof worldSectionSchema>;

export function visibleWorldSections(
  document: WorldDocument,
  stage = WORLD_PUBLIC_STAGE,
): WorldSection[] {
  return document.sections.filter((section) => section.revealStage <= stage);
}
```

Add required `world: WorldDocument[]` to `ArchiveContent`.

- [ ] **Step 4: Add world YAML loading to all three production consumers**

Change `loadContentFromSources` to accept a fourth `worldSource?: string` argument, initialize `world: []`, and parse it with `worldSchema`. Import `world.yaml?raw` in the browser loader and pass it explicitly.

```ts
import worldSource from './world.yaml?raw';

export function loadContentFromSources(
  markdown: RawContentModules,
  gallerySource?: string,
  includePrivateGallery = true,
  rawWorldSource?: string,
): ArchiveContent {
  const content: ArchiveContent = {
    records: [], scenes: [], profiles: [], documents: [], gallery: [], world: [],
  };
  // existing Markdown and gallery loading remains unchanged
  if (rawWorldSource) content.world = worldSchema.parse(parseYaml(rawWorldSource));
  return content;
}

function loadContent(includePrivateGallery: boolean): ArchiveContent {
  return loadContentFromSources(markdownModules(), publicGallerySource, includePrivateGallery, worldSource);
}
```

In `scripts/validate-content.ts`, read and parse `src/content/world.yaml` or use `[]` only when it does not exist. In `editor/archive-persistence.ts`, add a `loadWorld(contentRoot)` helper that reads the exact regular file `world.yaml`, rejects symbolic links/non-files, verifies `realpath` containment under `contentRoot`, parses with `worldSchema`, and includes `world` in prospective archive validation. Do not make `world` optional.

```ts
async function loadWorld(contentRoot: string): Promise<WorldDocument[]> {
  const path = join(contentRoot, 'world.yaml');
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('World content must be a regular file.');
  }
  const canonicalPath = await realpath(path);
  if (!isWithin(contentRoot, canonicalPath)) {
    throw new Error('World content must be within the content root.');
  }
  return worldSchema.parse(parseYaml(await readFile(canonicalPath, 'utf8')));
}
```

The CLI literal must use:

```ts
world: existsSync(join(contentDirectory, 'world.yaml'))
  ? worldSchema.parse(parseYaml(readFileSync(join(contentDirectory, 'world.yaml'), 'utf8')))
  : [],
```

- [ ] **Step 5: Add relationship and uniqueness validation**

In `src/content/validation.ts` add:

```ts
const worldIds = new Set<string>();
const worldNumbers = new Set<string>();
for (const document of content.world) {
  if (worldIds.has(document.id)) errors.push(`Duplicate world document ID: ${document.id}`);
  if (worldNumbers.has(document.documentNumber)) {
    errors.push(`Duplicate world document number: ${document.documentNumber}`);
  }
  worldIds.add(document.id);
  worldNumbers.add(document.documentNumber);
  for (const relatedId of document.relatedRecords) {
    if (!recordIds.has(relatedId)) {
      errors.push(`World document ${document.id} references missing record ID: ${relatedId}`);
    }
  }
}
```

- [ ] **Step 6: Create the seven public world documents**

Create `src/content/world.yaml` with exactly seven entries and no future secret prose. Use these IDs/numbers/categories/statuses/links:

```yaml
- id: special-disaster-agency
  documentNumber: WF-01
  title: 특수재난관리청
  categories: [organization]
  status: public
  clearance: 공개 열람
  basisStage: 1
  summary: 미확인 개체와 특수재난을 관리하는 기관.
  explanation: 현장 부서와 의료 부서를 함께 운용하는 특수재난 대응 기관이다.
  sections:
    - revealStage: 1
      paragraphs: [현장 통제와 격리, 구조, 의료 지원을 담당한다.]
  relatedRecords: [first-contact, field-accompaniment]

- id: special-task-force
  documentNumber: WF-02
  title: 특수기동대
  categories: [organization]
  status: public
  clearance: 공개 열람
  basisStage: 1
  summary: 고위험 현장에 투입되는 대응 부서.
  explanation: 무영이 소속된 현장 대응 부서다.
  sections:
    - revealStage: 1
      paragraphs: [지휘관은 철수 순서와 구조 인원의 안전을 확인하며 무영이 현장 지휘를 맡고 있다.]
  relatedRecords: [first-contact, field-accompaniment]

- id: third-medical-center
  documentNumber: WF-03
  title: 제3의료센터
  categories: [medical]
  status: public
  clearance: 공개 열람
  basisStage: 1
  summary: 특수재난 부상자와 오염 노출자를 치료하고 관찰하는 의료 기관.
  explanation: 천령이 근무하며 무영의 치료가 반복되는 곳이다.
  sections:
    - revealStage: 1
      paragraphs: [천령이 의사이자 연구원으로 소속되어 현장 의료 지원에도 참여한다.]
  relatedRecords: [first-contact, repeated-treatment]

- id: containment-protocol
  documentNumber: WF-04
  title: 격리 및 철수 절차
  categories: [field-response]
  status: public
  clearance: 공개 열람
  basisStage: 1
  summary: 미확인 개체가 관측된 현장은 격리선을 기준으로 통제된다.
  explanation: 현장 인원을 살리기 위한 절차이며 두 사람의 판단이 자주 부딪치는 지점이다.
  sections:
    - revealStage: 1
      paragraphs: [의료진도 철수 명령의 대상이지만 현장 판단과 충돌한 사례가 존재한다.]
  relatedRecords: [first-contact, field-accompaniment]

- id: contamination-treatment
  documentNumber: WF-05
  title: 오염과 치료
  categories: [anomaly, medical]
  status: partial
  clearance: 부분 공개
  basisStage: 5
  summary: 오염은 일반 외상과 구분해 다뤄진다.
  explanation: 특수재난 현장의 부상은 상처만 치료한다고 끝나지 않는다.
  sections:
    - revealStage: 1
      paragraphs: [노출 정도에 따라 장비 측정과 의료 관찰이 이루어진다.]
    - revealStage: 5
      paragraphs: [치료 방식과 일부 회복 사례는 제한 정보로 분류되어 있다.]
  relatedRecords: [first-contact, fracture]

- id: recurring-anomalies
  documentNumber: OB-01
  title: 반복 관측 이상
  categories: [observation]
  status: partial
  clearance: 부분 공개
  basisStage: 5
  summary: 서로 다른 현장에서 같은 종류의 이상이 반복되고 있다.
  explanation: 원인을 확정하지 않고 기록철에서 관측된 사실만 연결한다.
  sections:
    - revealStage: 1
      paragraphs: [천령의 낮은 체온과 불안정한 측정값이 기록되었다.]
    - revealStage: 3
      paragraphs: [현장 의료 지원 중에도 설명하기 어려운 반응이 반복되었다.]
    - revealStage: 5
      paragraphs: [심각한 오염과 치료 이후 일부 보고 수치가 정정되었다.]
  relatedRecords: [first-contact, field-accompaniment, fracture]

- id: cheonryeong-restricted
  documentNumber: CL-01
  title: 의료인 천령 관련 제한 기록
  categories: [classified]
  status: locked
  clearance: 제한 열람
  basisStage: 5
  summary: 신원 및 의료 활동 관련 일부 기록의 열람이 제한되어 있다.
  explanation: 현재 확인 가능한 것은 기록의 불일치와 반복 관측뿐이다.
  sections:
    - revealStage: 1
      paragraphs: [신원 기록 일부 불일치.]
    - revealStage: 5
      paragraphs: [특정 오염 상황에서 비정상 반응 관측.]
  relatedRecords: [first-contact, fracture]
  lockLabel: 추가 기록 확인 후 해금
```

- [ ] **Step 7: Run focused and full data verification**

```powershell
npx vitest run src/content/frontmatter.test.ts src/content/content.test.ts editor/storage.test.ts src/features/archive/ArchivePage.test.tsx scripts/public-world.test.ts
npm run validate
```

Expected: all focused tests pass and content validation passes.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/content/world.yaml src/content/schema.ts src/content/load.ts src/content/validation.ts scripts/validate-content.ts editor/archive-persistence.ts src/content/frontmatter.test.ts src/content/content.test.ts editor/storage.test.ts src/features/archive/ArchivePage.test.tsx scripts/public-world.test.ts
git commit -m "feat: add staged world archive content"
```

---

### Task 3: 세계관 색인·문서 열람 UI 추가

**Files:**
- Create: `src/features/world/WorldPage.tsx`
- Create: `src/features/world/WorldPage.test.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/app/router.tsx`
- Modify: `src/styles/document.css`
- Modify: `e2e/archive.spec.ts`

**Interfaces:**
- Consumes: `ArchiveContent.world`, `WORLD_PUBLIC_STAGE`, `visibleWorldSections`.
- Produces: `WorldPage({ documents?, records? })`, routes `/world` and `/world/:documentId`.

- [ ] **Step 1: Write failing navigation, routing, and page tests**

Test exact navigation order and links:

```ts
expect(screen.getAllByRole('link').map((link) => link.textContent))
  .toEqual(['천무', '기록철', '세계관', '아카이브']);
expect(screen.getByRole('link', { name: '세계관' })).toHaveAttribute('href', '/world');
```

In `WorldPage.test.tsx`, cover:

- `/world` selects `WF-01`.
- `/world/recurring-anomalies` displays only sections with `revealStage <= 6`.
- a missing ID falls back to `WF-01` with a canonical link to `/world/special-disaster-agency`.
- related `CM-01` links to `/records/first-contact`.
- `CL-01` displays both approved clues and `추가 기록 확인 후 해금` but no forbidden secret phrase.
- clicking the mobile index toggle changes `aria-expanded`, and selecting a document closes the index.

In `e2e/archive.spec.ts`, add desktop `[1440, 1000]` and mobile `[390, 844]` cases that:

- see four top navigation items in the exact order;
- open `#/world` and see WF-01;
- navigate to OB-01 and follow its CM-05 related link;
- open CL-01 and see the two approved clues plus lock label;
- confirm forbidden direct labels are absent from `.world-page`;
- on mobile, expand the index, select a document, and verify `aria-expanded="false"` afterward.

- [ ] **Step 2: Run focused UI tests and verify RED**

```powershell
npx vitest run src/app/AppShell.test.tsx src/features/world/WorldPage.test.tsx
npm run build
npx playwright test e2e/archive.spec.ts
```

Expected: unit tests fail for missing nav/page behavior and E2E fails because `/world` does not exist.

- [ ] **Step 3: Add navigation and lazy routes**

In `AppShell.tsx`, insert `<NavLink to="/world">세계관</NavLink>` between records and archive. In `router.tsx`, lazy-load `WorldPage` and add both routes:

```tsx
const WorldPage = lazy(() => import('../features/world/WorldPage').then((module) => ({
  default: module.WorldPage,
})));

<Route path="world" element={<WorldPage />} />
<Route path="world/:documentId" element={<WorldPage />} />
```

- [ ] **Step 4: Implement the indexed reader component**

`WorldPage.tsx` must:

- obtain `documentId` with `useParams`;
- default to the first document when missing/invalid;
- group documents by the six category labels in the design order;
- use links for document selection so URLs are shareable;
- render document number, clearance, `CM-06 기준`, status, summary, explanation, visible sections, related record links, and the lock label;
- use a real `<button aria-expanded aria-controls="world-index">` for the mobile index;
- close the mobile index after navigation via link click;
- mark the selected link with `aria-current="page"`;
- never render a hidden section whose stage exceeds `WORLD_PUBLIC_STAGE`.

Use this component structure (retain these class names for CSS and E2E):

```tsx
import { useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import {
  WORLD_PUBLIC_STAGE,
  visibleWorldSections,
  type ArchiveRecord,
  type WorldCategory,
  type WorldDocument,
} from '../../content/schema';

type WorldPageProps = {
  documents?: readonly WorldDocument[];
  records?: readonly ArchiveRecord[];
};

const CATEGORY_LABELS = {
  organization: '기관과 조직',
  'field-response': '현장 대응',
  medical: '의료와 치료',
  anomaly: '미확인 개체·오염',
  observation: '관측 기록',
  classified: '기밀 문서',
} as const;

export function WorldPage({
  documents = loadAllContent().world,
  records = loadAllContent().records,
}: WorldPageProps): JSX.Element {
  const { documentId } = useParams();
  const [indexOpen, setIndexOpen] = useState(false);
  const selected = documents.find((item) => item.id === documentId) ?? documents[0];
  const invalidId = Boolean(documentId && selected?.id !== documentId);

  if (!selected) {
    return <section className="record-not-found"><h1>세계관 문서가 없습니다</h1></section>;
  }

  return (
    <section className="world-page" aria-labelledby="world-title">
      <header className="document-header">
        <div>
          <p className="document-kicker">World File · CM-06</p>
          <h1 id="world-title">세계관 기록실</h1>
          <p>공개된 기록을 기준으로 기관과 현상을 열람합니다.</p>
        </div>
      </header>
      {invalidId && (
        <p className="world-route-notice">
          요청한 문서가 없어 첫 문서를 표시합니다.{' '}
          <Link to={`/world/${selected.id}`}>정식 문서 주소</Link>
        </p>
      )}
      <button
        className="world-index-toggle"
        type="button"
        aria-expanded={indexOpen}
        aria-controls="world-index"
        onClick={() => setIndexOpen((value) => !value)}
      >
        분류 색인
      </button>
      <div className="world-layout">
        <nav id="world-index" className="world-index" data-open={indexOpen} aria-label="세계관 문서 색인">
          {Object.entries(CATEGORY_LABELS).map(([category, label]) => {
            const items = documents.filter((item) => item.categories.includes(category as WorldCategory));
            return items.length > 0 && (
              <section key={category}>
                <h2>{label}</h2>
                {items.map((item) => (
                  <Link
                    key={item.id}
                    to={`/world/${item.id}`}
                    aria-current={item.id === selected.id ? 'page' : undefined}
                    onClick={() => setIndexOpen(false)}
                  >
                    <span>{item.documentNumber}</span>{item.title}
                  </Link>
                ))}
              </section>
            );
          })}
        </nav>
        <article className="world-document">
          <header>
            <p>{selected.documentNumber} · {selected.clearance} · CM-{String(WORLD_PUBLIC_STAGE).padStart(2, '0')} 기준</p>
            <h2>{selected.title}</h2>
            <strong>{selected.summary}</strong>
          </header>
          <p className="world-explanation">쉽게 말하면 — {selected.explanation}</p>
          {visibleWorldSections(selected).map((section) => section.paragraphs.map((paragraph) => (
            <p key={`${section.revealStage}-${paragraph}`}>{paragraph}</p>
          )))}
          {selected.status === 'locked' && (
            <aside className="world-lock" aria-label="잠긴 기밀 정보">
              <span aria-hidden="true">▣</span> {selected.lockLabel}
            </aside>
          )}
          <footer className="world-related">
            <h3>관련 기록</h3>
            {selected.relatedRecords.map((id) => {
              const record = records.find((item) => item.id === id);
              return record && <Link key={id} to={`/records/${id}`}>{record.recordNumber}</Link>;
            })}
          </footer>
        </article>
      </div>
    </section>
  );
}
```

Use these category labels:

```ts
const CATEGORY_LABELS = {
  organization: '기관과 조직',
  'field-response': '현장 대응',
  medical: '의료와 치료',
  anomaly: '미확인 개체·오염',
  observation: '관측 기록',
  classified: '기밀 문서',
} as const;
```

- [ ] **Step 5: Add responsive document styling**

Add focused `.world-*` rules to `src/styles/document.css`:

- `.world-page` max width `68rem`;
- `.world-layout` desktop grid `15rem minmax(0, 1fr)`;
- sticky `.world-index` aligned under the document header;
- selected index link uses black background and red left rule;
- `.world-document` uses paper background, double top/bottom rule, and document typography near `1rem/1.75`;
- `.world-lock` uses a lock marker, dashed border, muted fill, and visible readable clue text;
- `.world-index-toggle` hidden on desktop;
- below `47.999rem`, show toggle, collapse index when closed, and use one column;
- change mobile `.archive-navigation` from three to four equal columns and keep labels legible at 390px;
- preserve `:focus-visible` outlines and reduced-motion behavior.

Use these exact layout rules as the starting implementation:

```css
.world-page { width: min(100%, 68rem); margin-inline: auto; }
.world-layout { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: var(--space-xl); margin-top: var(--space-lg); }
.world-index { position: sticky; top: var(--space-lg); align-self: start; }
.world-index section + section { margin-top: var(--space-md); }
.world-index h2 { margin: 0 0 var(--space-xs); color: var(--ink-muted); font: 800 0.68rem/1.4 var(--font-label); letter-spacing: 0.12em; }
.world-index a { display: grid; grid-template-columns: 3.5rem 1fr; padding: 0.55rem 0.65rem; border-left: 0.2rem solid transparent; font: 700 0.76rem/1.45 var(--font-label); text-decoration: none; }
.world-index a[aria-current='page'] { color: var(--paper-raised); background: var(--muyeong-black); border-left-color: var(--muyeong-red); }
.world-index a span { color: var(--ink-muted); }
.world-index a[aria-current='page'] span { color: var(--paper-shadow); }
.world-index-toggle { display: none; }
.world-document { padding: clamp(var(--space-lg), 4vw, var(--space-xl)); background: rgb(251 247 235 / 78%); border-block: 0.2rem double var(--rule); font-size: 1rem; line-height: 1.75; }
.world-document header { padding-bottom: var(--space-lg); border-bottom: 1px solid var(--rule); }
.world-document header p { margin: 0; color: var(--muyeong-red); font: 800 0.7rem/1.4 var(--font-label); letter-spacing: 0.12em; }
.world-document h2 { margin: var(--space-xs) 0 var(--space-sm); font-size: clamp(1.8rem, 4vw, 3rem); }
.world-explanation { padding: var(--space-md); background: rgb(216 203 178 / 28%); }
.world-lock { margin-top: var(--space-lg); padding: var(--space-md); color: var(--ink-muted); background: rgb(29 27 26 / 6%); border: 1px dashed var(--ink-muted); font-family: var(--font-label); }
.world-related { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); margin-top: var(--space-xl); padding-top: var(--space-md); border-top: 1px solid var(--rule); }
.world-related h3 { width: 100%; margin: 0; font: 800 0.7rem/1.4 var(--font-label); letter-spacing: 0.12em; }
.world-route-notice { padding: var(--space-sm); border: 1px dashed var(--rule); }

@media (max-width: 47.999rem) {
  .archive-navigation { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .world-index-toggle { display: block; width: 100%; margin-top: var(--space-lg); min-height: 2.75rem; }
  .world-layout { grid-template-columns: 1fr; gap: var(--space-md); }
  .world-index { position: static; display: none; }
  .world-index[data-open='true'] { display: block; }
}
```

- [ ] **Step 6: Run focused UI tests**

```powershell
npx vitest run src/app/AppShell.test.tsx src/features/world/WorldPage.test.tsx src/styles/document.test.ts
npm run build
npx playwright test e2e/archive.spec.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src/features/world/WorldPage.tsx src/features/world/WorldPage.test.tsx src/app/AppShell.tsx src/app/AppShell.test.tsx src/app/router.tsx src/styles/document.css e2e/archive.spec.ts
git commit -m "feat: add indexed world archive page"
```

---

### Task 4: 전체 통합 검증과 최종 리뷰

**Files:**
- Verify only. A failure must be returned to the task that owns the affected file.

**Interfaces:**
- Consumes: built `dist`, world routes, public content.
- Produces: browser and bundle evidence that locked source material is not public and the complete feature is ready for review.

- [ ] **Step 1: Run complete verification**

```powershell
npm run validate
npm run test:run
npm run build
npm run e2e
git diff --check
git status --short
```

Expected:

- content validation passes;
- all Vitest files pass with only intentional platform skips;
- TypeScript/Vite build passes;
- all Playwright tests pass at desktop and mobile sizes;
- no whitespace errors;
- only the user’s pre-existing untracked PDF/image/profile files remain unstaged.

- [ ] **Step 2: Inspect scope and public collection boundaries**

```powershell
git diff --check
git status --short
$branchBase = git merge-base main HEAD
git diff --name-status "$branchBase..HEAD"
```

Expected: no whitespace errors; `_hidden` originals and intended public/UI/test files are tracked; user PDF/image/profile source files remain untracked; no `_hidden` path appears in a Vite glob.

- [ ] **Step 3: Request whole-branch review**

Review the full branch against `docs/superpowers/specs/2026-07-20-world-archive-menu-design.md`. Block completion on any correctness, accessibility, route, content-stage, canon, bundle-privacy, path-security, or regression finding. Do not deploy without a later explicit user request.
