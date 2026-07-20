# Record Summary and Cinematic Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기록 상세에는 2~3문단 요약을 표시하고 별도 장면 Markdown의 장편 본문은 자동 숨김 헤더가 있는 연속 스크롤 독서 화면으로 제공한다.

**Architecture:** `src/content/scenes/<record-id>.md`를 raw 장면 원본으로 추가하고 콘텐츠 로더가 동일 id 기록의 `cinematicBody`에 연결한다. RecordDetailPage는 요약 `body`와 장면 `cinematicBody`를 분리해 사용하며, CinematicScene은 prose 장면에서만 스크롤 방향을 추적해 sticky 헤더를 숨기거나 복원한다.

**Tech Stack:** React 19, TypeScript, Vite raw Markdown glob, Zod, Vitest, Testing Library, Playwright, CSS

## Global Constraints

- 상세 페이지 요약은 2~3문단이며 장편 전용 문장을 DOM에 포함하지 않는다.
- 첫 조우 장편은 현재 승인된 본문을 보존하되 별도 Markdown으로 이동한다.
- prose 본문은 15~17px, 최대 폭 42rem, 행간 1.85와 연속 스크롤을 유지한다.
- 아래 스크롤에서 헤더를 숨기고 위 스크롤과 최상단·키보드 포커스에서 표시한다.
- PC와 모바일에 같은 규칙을 적용한다.
- 기존 stage 3·5·7의 짧은 장면 이동 방식과 `Escape`/포커스 복귀를 보존한다.
- 공개 사이트 배포는 이 계획 범위에 포함하지 않는다.
- 사용자가 추가한 PDF, 이미지, 원본 프로필 파일을 수정하거나 커밋하지 않는다.

---

### Task 1: 요약과 장편 장면 콘텐츠 분리

**Files:**
- Create: `src/content/scenes/first-contact.md`
- Modify: `src/content/records/01-first-contact.md`
- Modify: `src/content/schema.ts`
- Modify: `src/content/load.ts`
- Modify: `src/content/validation.ts`
- Modify: `scripts/validate-content.ts`
- Test: `src/content/frontmatter.test.ts`
- Test: `src/content/content.test.ts`
- Test: `src/features/archive/ArchivePage.test.tsx`

**Interfaces:**
- Consumes: raw Markdown module map `Record<string, string>` and record id filenames.
- Produces: `ArchiveScene { id: string; body: string }`, `ArchiveRecord.cinematicBody?: string`, `ArchiveContent.scenes: ArchiveScene[]`.

- [ ] **Step 1: Write failing loader and validation tests**

Add a loader test to `src/content/frontmatter.test.ts` using a real record source and raw scene source:

```ts
it('attaches a same-id raw scene to its cinematic record', () => {
  const content = loadContentFromSources({
    './records/first-contact.md': `---
id: first-contact
recordNumber: CM-01
title: First contact
stage: 1
status: confirmed
characters: [cheonryeong, muyeong]
tags: [first-contact]
related: []
quote: Is everyone safe?
cinematic: true
---
Short summary`,
    './scenes/first-contact.md': 'Full cinematic prose',
  });

  expect(content.records[0].body.trim()).toBe('Short summary');
  expect(content.records[0].cinematicBody).toBe('Full cinematic prose');
  expect(content.scenes).toEqual([{ id: 'first-contact', body: 'Full cinematic prose' }]);
});
```

Add validation tests for all invalid links:

```ts
it('rejects orphan, empty, and non-cinematic scene files', () => {
  const content: ArchiveContent = {
    records: [{
      id: 'plain-record', recordNumber: 'CM-02', title: 'Plain', stage: 2,
      status: 'confirmed', characters: [], tags: [], related: [], quote: 'Quote',
      cinematic: false, body: 'Summary', cinematicBody: 'Unexpected scene',
    }],
    profiles: [], documents: [], gallery: [],
    scenes: [
      { id: 'plain-record', body: 'Unexpected scene' },
      { id: 'missing-record', body: 'Orphan scene' },
      { id: 'empty-scene', body: '   ' },
    ],
  };

  expect(validateContent(content).errors).toEqual(expect.arrayContaining([
    'Scene plain-record is attached to a non-cinematic record.',
    'Scene missing-record has no matching record.',
    'Scene empty-scene is empty.',
  ]));
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run src/content/frontmatter.test.ts src/content/content.test.ts
```

Expected: FAIL because `ArchiveContent.scenes` and `cinematicBody` loading do not exist.

- [ ] **Step 3: Add the content types and raw scene loading**

Update `src/content/schema.ts`:

```ts
export type ArchiveScene = { id: string; body: string };
export type ArchiveRecord = RecordMeta & { body: string; cinematicBody?: string };

export interface ArchiveContent {
  records: ArchiveRecord[];
  profiles: ArchiveProfile[];
  documents: ArchiveDocument[];
  gallery: GalleryItem[];
  scenes: ArchiveScene[];
}
```

Add `scenes: []` to the existing `ArchiveContent` literal in `src/features/archive/ArchivePage.test.tsx` and to every explicit `ArchiveContent` fixture in `src/content/frontmatter.test.ts`. This keeps the required interface consistent instead of making `scenes` optional.

In `loadContentFromSources`, initialize `scenes: []`, recognize `/scenes/`, derive the id from the final `.md` filename, and connect after all modules are read:

```ts
function sceneIdFromPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1)!.replace(/\.md$/, '');
}

// inside the module loop
if (path.includes('/scenes/')) {
  content.scenes.push({ id: sceneIdFromPath(path), body: source.trim() });
  continue;
}

// after the module loop
for (const scene of content.scenes) {
  const record = content.records.find((item) => item.id === scene.id);
  if (record) record.cinematicBody = scene.body;
}
```

- [ ] **Step 4: Add scene relationship validation and CLI loading**

In `src/content/validation.ts`, validate every `content.scenes` item:

```ts
for (const scene of content.scenes) {
  const record = content.records.find((item) => item.id === scene.id);
  if (!scene.body.trim()) errors.push(`Scene ${scene.id} is empty.`);
  if (!record) {
    errors.push(`Scene ${scene.id} has no matching record.`);
  } else if (!record.cinematic) {
    errors.push(`Scene ${scene.id} is attached to a non-cinematic record.`);
  }
}
```

In `scripts/validate-content.ts`, read `src/content/scenes/*.md` without frontmatter and include it in `ArchiveContent`:

```ts
function readSceneCollection(directory: string): Array<{ id: string; body: string }> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => ({
      id: fileName.replace(/\.md$/, ''),
      body: readFileSync(join(directory, fileName), 'utf8').trim(),
    }));
}

// ArchiveContent literal
scenes: readSceneCollection(join(contentDirectory, 'scenes')),
```

- [ ] **Step 5: Move the approved prose and write the public summary**

Move the current 4,501-character prose body, including `## 격리선 밖의 의사`, into `src/content/scenes/first-contact.md` without frontmatter. Replace `src/content/records/01-first-contact.md` body with exactly three short paragraphs:

```md
**정체불명의 의사와 중상 환자.**

미확인 개체의 격리가 무너진 현장에서 무영은 마지막 대원까지 철수시킨 뒤 중상을 입는다. 현장 임시 치료소로 옮겨진 그는 자신의 상처보다 대원들의 생사부터 확인하려 한다.

그곳에서 무영은 혼란 속에서도 지나치게 고요한 의사 천령을 처음 만난다. 끝내 전원이 무사하다는 답을 들은 뒤에야, 무영은 낯선 치료자의 손에 자신의 생명을 맡기고 의식을 놓는다.
```

Add assertions in `src/content/content.test.ts` that the summary includes `현장 임시 치료소`, excludes the final prose sentence, and `cinematicBody` contains both the first and last prose sentences.

- [ ] **Step 6: Run focused tests and validation**

Run:

```powershell
npx vitest run src/content/frontmatter.test.ts src/content/content.test.ts src/features/archive/ArchivePage.test.tsx
npm run validate
```

Expected: focused tests PASS and `Content validation passed.`

- [ ] **Step 7: Commit Task 1**

```powershell
git add src/content/scenes/first-contact.md src/content/records/01-first-contact.md src/content/schema.ts src/content/load.ts src/content/validation.ts scripts/validate-content.ts src/content/frontmatter.test.ts src/content/content.test.ts src/features/archive/ArchivePage.test.tsx
git commit -m "feat: separate cinematic prose from record summary"
```

---

### Task 2: Prose source selection and direction-aware sticky header

**Files:**
- Modify: `src/features/timeline/RecordDetailPage.tsx`
- Modify: `src/features/timeline/CinematicScene.tsx`
- Modify: `src/styles/document.css`
- Test: `src/features/timeline/TimelinePage.test.tsx`
- Test: `src/features/timeline/CinematicScene.test.tsx`
- Test: `e2e/archive.spec.ts`

**Interfaces:**
- Consumes: `ArchiveRecord.cinematicBody?: string` from Task 1.
- Produces: one prose `CinematicSceneItem` for sidecar content and header classes `cinematic-scene__header--sticky` / `cinematic-scene__header--hidden`.

- [ ] **Step 1: Write failing source-selection and scroll-direction tests**

Update the existing long-record test so `record.body` is a short summary and `record.cinematicBody` contains the first and last full-prose sentences. Assert the detail DOM omits the last full-prose sentence while the opened modal contains it in one `.cinematic-scene__text--prose`.

In `CinematicScene.test.tsx`, import `fireEvent` and add:

```tsx
it('hides its prose header while scrolling down and restores it while scrolling up', () => {
  const longText = '긴 본문입니다. '.repeat(100);
  const { container } = render(
    <CinematicScene title="첫 조우" scenes={[{ id: 'prose', text: longText }]} onClose={vi.fn()} />,
  );
  const scroller = container.querySelector<HTMLElement>('.cinematic-scene')!;
  const header = container.querySelector('.cinematic-scene__header')!;

  scroller.scrollTop = 120;
  fireEvent.scroll(scroller);
  expect(header).toHaveClass('cinematic-scene__header--hidden');

  scroller.scrollTop = 80;
  fireEvent.scroll(scroller);
  expect(header).not.toHaveClass('cinematic-scene__header--hidden');

  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  expect(header).not.toHaveClass('cinematic-scene__header--hidden');
});
```

Add a test that focusing the close button after a downward scroll removes the hidden class. Keep the existing `Escape`, focus trap, short-scene paging, and one-prose-scene control tests.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npx vitest run src/features/timeline/CinematicScene.test.tsx src/features/timeline/TimelinePage.test.tsx
```

Expected: FAIL because RecordDetailPage does not select `cinematicBody` and the header has no direction state.

- [ ] **Step 3: Select the sidecar prose source**

Replace the body-length heuristic in `RecordDetailPage.tsx` with explicit sidecar selection:

```ts
function scenesFromRecord(record: ArchiveRecord): CinematicSceneItem[] {
  if (record.cinematicBody) {
    return [{
      id: `${record.id}-prose`,
      text: proseFromRecordBody(record.cinematicBody),
    }];
  }
  return scenesFromShortRecordBody(record);
}
```

Keep the current Markdown cleanup for the prose body and the existing line-by-line parser for short records.

- [ ] **Step 4: Implement direction-aware header state**

In `CinematicScene.tsx`, add the scroll container ref and last position:

```ts
const scrollContainerRef = useRef<HTMLDivElement>(null);
const lastScrollTopRef = useRef(0);
const [isHeaderHidden, setIsHeaderHidden] = useState(false);

function handleScroll() {
  if (!isProseScene) return;
  const nextTop = scrollContainerRef.current?.scrollTop ?? 0;
  if (nextTop <= 24 || nextTop < lastScrollTopRef.current) {
    setIsHeaderHidden(false);
  } else if (nextTop > 72 && nextTop > lastScrollTopRef.current) {
    setIsHeaderHidden(true);
  }
  lastScrollTopRef.current = nextTop;
}
```

Attach `ref={scrollContainerRef}` and `onScroll={handleScroll}` to `.cinematic-scene`. For prose only, add the sticky class; add the hidden class from state:

```tsx
<header
  className={[
    'cinematic-scene__header',
    isProseScene && 'cinematic-scene__header--sticky',
    isProseScene && isHeaderHidden && 'cinematic-scene__header--hidden',
  ].filter(Boolean).join(' ')}
  onFocusCapture={() => setIsHeaderHidden(false)}
>
```

Reset `lastScrollTopRef` and `isHeaderHidden` when `sceneIndex` or `isProseScene` changes.

- [ ] **Step 5: Add sticky header styles and reduced-motion behavior**

Add to `src/styles/document.css`:

```css
.cinematic-scene__header--sticky {
  position: sticky;
  z-index: 2;
  top: 0;
  margin-inline: calc(clamp(var(--space-md), 4vw, var(--space-xl)) * -1);
  padding: var(--space-md) clamp(var(--space-md), 4vw, var(--space-xl));
  background: linear-gradient(180deg, var(--muyeong-black) 75%, rgb(29 27 26 / 88%));
  transition: transform 180ms ease, opacity 180ms ease;
}

.cinematic-scene__header--hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateY(calc(-100% - 1px));
}

@media (prefers-reduced-motion: reduce) {
  .cinematic-scene__header--sticky { transition: none; }
}
```

Keep the prose font at `clamp(0.95rem, 1.1vw, 1.0625rem)`, `max-width: 42rem`, and `line-height: 1.85`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/features/timeline/CinematicScene.test.tsx src/features/timeline/TimelinePage.test.tsx
```

Expected: both files PASS; short scenes still show paging controls.

- [ ] **Step 7: Add desktop and mobile E2E direction checks**

Refactor the prose E2E into viewport cases `[1440, 1000]` and `[390, 844]`. For each case:

```ts
const reader = page.locator('.cinematic-scene');
const header = page.locator('.cinematic-scene__header');
await reader.evaluate((element) => element.scrollTo(0, 500));
await expect(header).toHaveClass(/cinematic-scene__header--hidden/);
await reader.evaluate((element) => element.scrollTo(0, 300));
await expect(header).not.toHaveClass(/cinematic-scene__header--hidden/);
```

Also assert the summary sentence is visible before opening, the last prose sentence is absent from the detail DOM, the modal contains it, font size is 15–17px, and there is no next button.

- [ ] **Step 8: Build before E2E and verify browser behavior**

Run:

```powershell
npm run build
npm run e2e
```

Expected: all archive E2E tests PASS at both prose viewports. Build first because Playwright preview serves `dist`.

- [ ] **Step 9: Commit Task 2**

```powershell
git add src/features/timeline/RecordDetailPage.tsx src/features/timeline/CinematicScene.tsx src/styles/document.css src/features/timeline/TimelinePage.test.tsx src/features/timeline/CinematicScene.test.tsx e2e/archive.spec.ts
git commit -m "feat: add direction-aware cinematic reader"
```

---

### Task 3: Full integration verification

**Files:**
- Verify only; modify a task-owned file only if a failing test exposes a requirement gap.

**Interfaces:**
- Consumes: Task 1 content split and Task 2 reader behavior.
- Produces: verified local changes ready for an explicit later deployment request.

- [ ] **Step 1: Run content and unit verification**

```powershell
npm run validate
npm run test:run
```

Expected: content validation passes and all Vitest files pass with only intentional skips.

- [ ] **Step 2: Run production and browser verification**

```powershell
npm run build
npm run e2e
```

Expected: TypeScript and Vite build pass; all archive Playwright tests pass.

- [ ] **Step 3: Inspect scope and whitespace**

```powershell
git diff --check
git status --short
git log --oneline -5
```

Expected: no whitespace errors; only intended commits plus the user's pre-existing untracked PDF/image/profile files remain. Do not stage those files.

- [ ] **Step 4: Request final review**

Review the complete change against `docs/superpowers/specs/2026-07-20-record-summary-cinematic-reader-design.md`. Block completion on any correctness, accessibility, content-source, privacy, or regression finding.
