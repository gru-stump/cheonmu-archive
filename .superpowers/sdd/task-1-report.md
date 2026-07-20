# Task 1 Report: Separate record summary and cinematic prose

## Outcome

Separated the first-contact record's public summary from its full cinematic prose, and added scene loading and validation support.

## RED evidence

Ran:

```powershell
npx vitest run src/content/frontmatter.test.ts src/content/content.test.ts src/features/archive/ArchivePage.test.tsx
```

Before implementation, the focused run failed as expected:

- the loader left the record body as the prior prose and did not populate `cinematicBody` or `content.scenes`;
- validation did not report the required non-cinematic, orphan, or empty-scene errors;
- the public-content test still found the full prose in the record body.

## GREEN evidence

After implementation, the same focused command passed:

```text
Test Files  3 passed (3)
Tests  21 passed (21)
```

The required CLI validation also passed:

```text
> npm run validate
Content validation passed.
```

## Files changed

- Added `src/content/scenes/first-contact.md` with the approved prose and no frontmatter.
- Replaced the record body in `src/content/records/01-first-contact.md` with the exact three-paragraph public summary while retaining its frontmatter.
- Added `ArchiveScene`, optional `ArchiveRecord.cinematicBody`, and required `ArchiveContent.scenes`.
- Loaded raw scene Markdown by filename-derived ID, trimmed scene bodies, and attached matching scenes to records after source loading.
- Added empty, orphan, and non-cinematic scene validation plus CLI scene collection.
- Added loader, validation, public-content, and explicit-fixture coverage.

## Self-review

- `git diff --check` completed without whitespace errors.
- Verified the moved prose matches the original record body after line-ending normalization.
- Verified the replacement record body exactly matches the requested three paragraphs.
- Reviewed the diff to confirm only task-owned source, test, content, and report paths are intended for staging; user PDFs, PNGs, and profile source Markdown remain unstaged.

## Concerns

None.
