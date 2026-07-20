# Cheonmu Public Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a responsive, read-only Cheonmu narrative archive whose timeline, profiles, documents, and gallery are sourced from validated Markdown and metadata.

**Architecture:** A Vite React application loads Markdown as raw build-time modules, parses YAML frontmatter into Zod-validated domain objects, and renders HashRouter routes suitable for GitHub Pages. Feature folders own their screens and tests; shared content and UI modules contain reusable contracts. Public assets and draft/confirmed records are filtered by the content layer rather than embedded in components.

**Tech Stack:** Vite, React, TypeScript, React Router, Vitest, Testing Library, Zod, YAML, React Markdown, Playwright, GitHub Actions

## Global Constraints

- Public site is read-only and deploys to `https://<github-user>.github.io/cheonmu-archive/`.
- Use `HashRouter`; every detail route must survive direct access and refresh on GitHub Pages.
- PC, tablet, and mobile expose the same content and functions.
- Visually distinguish `confirmed` records from `draft` records.
- Public production builds must exclude gallery items whose `public` value is `false`.
- Preserve `천무_캐릭터_프로필.md` as source material.
- Treat the source conflict between Muyeong heights `185cm` and `189cm` as a validation failure until one value is selected.
- Respect keyboard operation, visible focus, image alternative text, and `prefers-reduced-motion`.

---

## File Map

- `package.json`: scripts and dependencies.
- `vite.config.ts`: React, test environment, GitHub Pages base path.
- `src/content/schema.ts`: Zod schemas and exported content types.
- `src/content/load.ts`: raw Markdown discovery, frontmatter parsing, link validation, public filtering.
- `src/content/**/*.md`: profiles, events, documents, and settings.
- `src/content/gallery.yaml`: gallery metadata.
- `src/app/router.tsx`: HashRouter route tree.
- `src/app/AppShell.tsx`: shared header, navigation, and page frame.
- `src/features/home/HomePage.tsx`: pair landing page.
- `src/features/timeline/*`: timeline, filters, record detail, cinematic scene.
- `src/features/archive/*`: archive index, profiles, documents, gallery, lightbox.
- `src/styles/*`: design tokens, document theme, responsive and reduced-motion rules.
- `scripts/validate-content.ts`: build-time content validation entry point.
- `e2e/archive.spec.ts`: public critical-path browser tests.
- `.github/workflows/deploy.yml`: GitHub Pages deployment.

### Task 1: Establish the tested React application shell

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/main.tsx`
- Create: `src/app/AppShell.tsx`
- Create: `src/app/router.tsx`
- Create: `src/test/setup.ts`
- Create: `src/app/AppShell.test.tsx`
- Create: `.gitignore`

**Interfaces:**
- Produces: `AppShell(): JSX.Element` and `AppRouter(): JSX.Element`.
- Produces scripts: `dev`, `build`, `test`, `test:run`, `validate`, `e2e`.

- [ ] **Step 1: Add the failing navigation test**

```tsx
// src/app/AppShell.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('offers the three primary archive destinations', () => {
    render(<MemoryRouter><AppShell /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '천무' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '기록철' })).toHaveAttribute('href', '/records');
    expect(screen.getByRole('link', { name: '아카이브' })).toHaveAttribute('href', '/archive');
  });
});
```

- [ ] **Step 2: Scaffold dependencies and run the failing test**

Run:

```powershell
npm init -y
npm install react react-dom react-router-dom react-markdown zod yaml
npm install -D vite typescript @vitejs/plugin-react vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/react @types/react-dom tsx playwright
npm run test:run -- src/app/AppShell.test.tsx
```

Expected: FAIL because the application files and scripts do not exist yet.

- [ ] **Step 3: Add the minimal shell and configuration**

Use `base: '/cheonmu-archive/'` in Vite, `environment: 'jsdom'` in Vitest, and these routes in `src/app/router.tsx`:

```tsx
export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div>천무</div>} />
          <Route path="records" element={<div>기록철</div>} />
          <Route path="archive" element={<div>아카이브</div>} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
```

Implement `AppShell` with three `NavLink` elements and an `Outlet`. Add `.superpowers/`, `node_modules/`, `dist/`, `playwright-report/`, and `test-results/` to `.gitignore`.

- [ ] **Step 4: Verify the shell**

Run: `npm run test:run -- src/app/AppShell.test.tsx`

Expected: 1 passing test.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json index.html tsconfig.json vite.config.ts src/main.tsx src/app src/test .gitignore
git commit -m "feat: establish Cheonmu archive shell"
```

### Task 2: Define and validate the content contracts

**Files:**
- Create: `src/content/schema.ts`
- Create: `src/content/frontmatter.ts`
- Create: `src/content/load.ts`
- Create: `src/content/frontmatter.test.ts`
- Create: `scripts/validate-content.ts`

**Interfaces:**
- Produces: `parseMarkdown<T>(source: string, schema: ZodType<T>): { data: T; body: string }`.
- Produces: `RecordMeta`, `ProfileMeta`, `DocumentMeta`, `GalleryItem` types.
- Produces: `loadAllContent(): ArchiveContent`, where `ArchiveContent` is `{ records: ArchiveRecord[]; profiles: ArchiveProfile[]; documents: ArchiveDocument[]; gallery: GalleryItem[] }`.
- Produces: `validateContent(): ValidationResult` with `{ errors: string[]; warnings: string[] }`.

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './frontmatter';
import { recordMetaSchema } from './schema';

it('parses a confirmed event record', () => {
  const source = `---\nid: first-contact\nrecordNumber: CM-01\ntitle: 첫 조우\nstage: 1\nstatus: confirmed\ncharacters: [cheonryeong, muyeong]\ntags: [첫조우]\nrelated: []\nquote: 모두 무사합니까?\ncinematic: true\n---\n본문`;
  expect(parseMarkdown(source, recordMetaSchema).data.id).toBe('first-contact');
});

it('rejects a record without a status', () => {
  expect(() => parseMarkdown('---\nid: broken\ntitle: 오류\n---\n본문', recordMetaSchema)).toThrow();
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run test:run -- src/content/frontmatter.test.ts`

Expected: FAIL because schemas and parser do not exist.

- [ ] **Step 3: Implement schemas and parser**

Define `status: z.enum(['confirmed', 'draft'])`, bounded `stage: z.number().int().min(1).max(8)`, nonempty IDs/titles, URL validation for optional credits, and nonempty alternative text for gallery images. Split the source at the opening and closing `---`, parse with `YAML.parse`, validate with the supplied Zod schema, and return the remaining body unchanged. In `loadAllContent`, use eager `import.meta.glob('./**/*.md', { query: '?raw', import: 'default', eager: true })`, parse each collection, sort records by stage, parse `gallery.yaml`, and return `ArchiveContent`.

- [ ] **Step 4: Add cross-record validation**

Implement `validateContent` to report duplicate IDs, missing related IDs, missing public image files, invalid stages, and both `185cm` and `189cm` being present for Muyeong. The height conflict error text must be `무영 신장이 185cm와 189cm로 충돌합니다.`.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:run -- src/content`

Expected: all content tests pass.

```powershell
git add src/content scripts/validate-content.ts package.json
git commit -m "feat: add validated archive content contracts"
```

### Task 3: Convert the profile source into initial content

**Files:**
- Create: `src/content/profiles/cheonryeong.md`
- Create: `src/content/profiles/muyeong.md`
- Create: `src/content/records/01-first-contact.md` through `08-before-lovers.md`
- Create: `src/content/documents/relationship.md`
- Create: `src/content/documents/settings.md`
- Create: `src/content/gallery.yaml`
- Create: `public/images/cheonmu-full.png`
- Create: `public/images/cheonmu-pair-template.png`
- Create: `public/images/creator-profile.png`
- Create: `src/content/content.test.ts`

**Interfaces:**
- Consumes: schemas and `validateContent()` from Task 2.
- Produces: eight ordered records, two profiles, two documents, and three public gallery entries.

- [ ] **Step 1: Add a failing completeness test**

```ts
it('contains eight ordered relationship stages and four cinematics', () => {
  const content = loadAllContent();
  expect(content.records.map((record) => record.stage)).toEqual([1,2,3,4,5,6,7,8]);
  expect(content.records.filter((record) => record.cinematic)).toHaveLength(4);
});
```

- [ ] **Step 2: Run the test and confirm missing content**

Run: `npm run test:run -- src/content/content.test.ts`

Expected: FAIL because the source content has not been converted.

- [ ] **Step 3: Create content with explicit provenance**

Use the profile document verbatim only for facts already present. Mark the four cinematic records as stages 1, 3, 5, and 7. Any newly written disaster name, chronology, or connective scene must use `status: draft` and begin its body with `> 이 기록은 서사 제안 초안입니다.`. Stage 8 ends before either character names the relationship.

- [ ] **Step 4: Resolve the height conflict before validation**

Pause and ask the user to choose Muyeong's canonical height (`185cm` or `189cm`). Update only `src/content/profiles/muyeong.md` after the choice; do not silently infer it from the images.

- [ ] **Step 5: Copy assets and write credits**

Copy the three supplied PNG files to the exact public paths above. Record known creator credit from the supplied profile image as data; leave an absent external source link omitted rather than inventing one.

- [ ] **Step 6: Validate and commit**

Run: `npm run validate && npm run test:run -- src/content`

Expected: validation succeeds with eight records and no height conflict.

```powershell
git add src/content public/images
git commit -m "content: add initial Cheonmu archive records"
```

### Task 4: Build the document-themed responsive foundation

**Files:**
- Create: `src/styles/tokens.css`
- Create: `src/styles/global.css`
- Create: `src/styles/document.css`
- Modify: `src/main.tsx`
- Modify: `src/app/AppShell.tsx`
- Create: `src/components/StatusStamp.tsx`
- Create: `src/components/StatusStamp.test.tsx`

**Interfaces:**
- Produces: `StatusStamp({ status }: { status: 'confirmed' | 'draft' })`.
- Produces CSS tokens for paper, ink, Cheonryeong green/plum, Muyeong black/red, focus, and reduced motion.

- [ ] **Step 1: Test accessible status labels**

```tsx
it.each([['confirmed', '확정 기록'], ['draft', '초안 기록']] as const)(
  'labels %s records', (status, label) => {
    render(<StatusStamp status={status} />);
    expect(screen.getByText(label)).toBeVisible();
  }
);
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run test:run -- src/components/StatusStamp.test.tsx`

Expected: FAIL because `StatusStamp` does not exist.

- [ ] **Step 3: Implement tokens and responsive shell**

Use CSS custom properties, a centered maximum content width, a desktop archive rail, and a mobile top-tab layout below `768px`. Add `:focus-visible` outlines and a `@media (prefers-reduced-motion: reduce)` rule that removes nonessential animation and smooth scrolling.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- src/components/StatusStamp.test.tsx && npm run build`

Expected: tests pass and Vite creates `dist/`.

```powershell
git add src/styles src/components src/main.tsx src/app/AppShell.tsx
git commit -m "feat: add responsive archive visual system"
```

### Task 5: Implement home, timeline, and record detail routes

**Files:**
- Create: `src/features/home/HomePage.tsx`
- Create: `src/features/timeline/TimelinePage.tsx`
- Create: `src/features/timeline/TimelineFilter.tsx`
- Create: `src/features/timeline/RecordCard.tsx`
- Create: `src/features/timeline/RecordDetailPage.tsx`
- Create: `src/features/timeline/TimelinePage.test.tsx`
- Modify: `src/app/router.tsx`

**Interfaces:**
- Consumes: `loadAllContent()` and `RecordMeta` from Task 2.
- Produces routes `/`, `/records`, `/records/:recordId`.
- Produces filter query `status=all|confirmed|draft` in the hash URL.

- [ ] **Step 1: Add the failing filter test**

```tsx
it('filters the timeline to confirmed records', async () => {
  renderTimelineWithFixtures();
  await userEvent.click(screen.getByRole('button', { name: '확정' }));
  expect(screen.getAllByTestId('record-card')).toHaveLength(confirmedFixtureCount);
  expect(screen.queryByText('초안 기록')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run test:run -- src/features/timeline/TimelinePage.test.tsx`

Expected: FAIL because timeline components do not exist.

- [ ] **Step 3: Implement the routes and filter**

Render eight cards sorted by `stage`, use buttons with `aria-pressed`, synchronize the selected status to `useSearchParams`, and link cards to `/records/:recordId`. On unknown IDs, render `기록을 찾을 수 없습니다` and an `기록철로 돌아가기` link.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- src/features/timeline && npm run build`

Expected: timeline tests and production build pass.

```powershell
git add src/features/home src/features/timeline src/app/router.tsx
git commit -m "feat: add narrative timeline and record pages"
```

### Task 6: Add accessible cinematic scene reconstruction

**Files:**
- Create: `src/features/timeline/CinematicScene.tsx`
- Create: `src/features/timeline/CinematicScene.test.tsx`
- Modify: `src/features/timeline/RecordDetailPage.tsx`
- Modify: `src/styles/document.css`

**Interfaces:**
- Produces: `CinematicScene({ title, scenes, onClose }: CinematicSceneProps)`.
- Scene shape: `{ id: string; speaker?: string; text: string; backdrop?: string }`.

- [ ] **Step 1: Test keyboard scene operation**

```tsx
it('moves through scenes and restores focus when closed', async () => {
  const onClose = vi.fn();
  render(<CinematicScene title="귀환의 약속" scenes={sceneFixtures} onClose={onClose} />);
  await userEvent.click(screen.getByRole('button', { name: '다음 장면' }));
  expect(screen.getByText(sceneFixtures[1].text)).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run test:run -- src/features/timeline/CinematicScene.test.tsx`

Expected: FAIL because the scene component does not exist.

- [ ] **Step 3: Implement the dialog**

Use a labeled modal dialog, previous/next buttons, Escape handling, focus trapping, focus restoration, and reduced-motion-safe transitions. Do not autoplay sound or animation.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- src/features/timeline/CinematicScene.test.tsx`

Expected: all cinematic tests pass.

```powershell
git add src/features/timeline src/styles/document.css
git commit -m "feat: add cinematic record reconstruction"
```

### Task 7: Implement archive profiles, documents, and gallery

**Files:**
- Create: `src/features/archive/ArchivePage.tsx`
- Create: `src/features/archive/ProfilePage.tsx`
- Create: `src/features/archive/DocumentPage.tsx`
- Create: `src/features/archive/GalleryPage.tsx`
- Create: `src/features/archive/GalleryLightbox.tsx`
- Create: `src/features/archive/ArchivePage.test.tsx`
- Create: `src/features/archive/GalleryLightbox.test.tsx`
- Modify: `src/app/router.tsx`

**Interfaces:**
- Produces routes `/archive`, `/archive/profiles/:id`, `/archive/documents/:id`, `/archive/gallery`.
- Produces filters `type`, `character`, and `tag`.

- [ ] **Step 1: Add failing archive and gallery tests**

```tsx
it('shows only public gallery items', () => {
  renderGalleryWithFixtures();
  expect(screen.getByAltText('천령과 무영 전신 설정화')).toBeVisible();
  expect(screen.queryByAltText('비공개 작업')).not.toBeInTheDocument();
});

it('closes the lightbox with Escape', async () => {
  render(<GalleryLightbox items={publicFixtures} initialIndex={0} onClose={onClose} />);
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:run -- src/features/archive`

Expected: FAIL because archive screens do not exist.

- [ ] **Step 3: Implement archive routing and filtering**

Add type, character, and tag controls with visible labels. Render Markdown with `react-markdown`. Link every archive card to an independent hash route. Return an archive recovery link for missing IDs.

- [ ] **Step 4: Implement the responsive gallery and lightbox**

Filter `public === true` before render. Provide image alt text, title, creator, optional source link, tags, previous/next buttons, Escape close, focus trap, and focus restoration.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:run -- src/features/archive && npm run build`

Expected: archive tests and production build pass.

```powershell
git add src/features/archive src/app/router.tsx
git commit -m "feat: add profiles documents and gallery archive"
```

### Task 8: Add end-to-end verification and GitHub Pages deployment

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/archive.spec.ts`
- Create: `.github/workflows/deploy.yml`
- Modify: `package.json`
- Create: `README.md`

**Interfaces:**
- Consumes: complete public app.
- Produces: automated Pages deployment from `main` and a documented local workflow.

- [ ] **Step 1: Add the failing critical-path browser test**

```ts
test('visitor reads a record and opens its cinematic scene', async ({ page }) => {
  await page.goto('/#/records');
  await page.getByRole('link', { name: /첫 조우/ }).click();
  await page.getByRole('button', { name: '장면 재구성 열기' }).click();
  await expect(page.getByRole('dialog', { name: /첫 조우/ })).toBeVisible();
});

test('mobile visitor opens a gallery image', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/archive/gallery');
  await page.getByAltText('천령과 무영 전신 설정화').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run build && npm run e2e`

Expected: FAIL until Playwright web server configuration and final accessible names match.

- [ ] **Step 3: Configure verification and deployment**

Configure Playwright to serve `npm run preview -- --host 127.0.0.1`. Configure GitHub Actions with `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages`; run `npm ci`, `npm run validate`, `npm run test:run`, and `npm run build` before upload. Set Pages permissions to `pages: write` and `id-token: write`.

- [ ] **Step 4: Document the owner workflow**

README commands must include:

```powershell
npm install
npm run dev
npm run validate
npm run test:run
npm run build
```

Explain that public changes appear only after committing and pushing to `main`.

- [ ] **Step 5: Run the full public-site gate**

Run:

```powershell
npm run validate
npm run test:run
npm run build
npm run e2e
```

Expected: validation passes, all Vitest and Playwright tests pass, and `dist/` contains no editor route.

- [ ] **Step 6: Commit**

```powershell
git add playwright.config.ts e2e .github/workflows/deploy.yml package.json README.md
git commit -m "ci: deploy verified archive to GitHub Pages"
```

## Phase Completion Gate

Before beginning the local editor plan, visually verify the home page, timeline, one confirmed record, one draft record, both profiles, and the gallery at widths 1440, 768, and 390 pixels. Confirm the deployed hash URLs reload correctly and no local editor asset exists in `dist/`.
