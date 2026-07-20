---
name: new-art
description: Register a new illustration into the Cheonmu gallery — place the image file, write the gallery.yaml entry (alt, creator, characters, tags, public flag), and validate. Use when the user wants to add or replace artwork.
argument-hint: "[이미지 파일 경로] [공개|비공개]"
---

새 일러스트를 갤러리에 등록한다. 인자(`$ARGUMENTS`)로 파일 경로와 공개 여부가 오면 사용하고, 없으면 사용자에게 묻는다.

## 절차

1. **파일 확인** — 이미지 파일을 찾아 확장자(png/jpg/jpeg/webp)를 확인한다. 파일명은 스키마 규칙 `[A-Za-z0-9_-]+`에 맞아야 한다(한글·공백·괄호 불가). 맞지 않으면 기존 파일들(`Cheonryeong_LD.png` 등)의 명명 관례를 따라 새 이름을 제안하고 확인받는다.
2. **배치** — 공개 이미지는 `public/images/`, 비공개는 `src/content/private-images/`에 복사한다. **같은 이름의 기존 파일을 교체하는 경우 기존 파일을 `.trash/images/`로 먼저 이동**하고 나서 복사한다(저장소 복구 규칙).
3. **gallery.yaml 등재** — `src/content/gallery.yaml`에 항목을 추가한다:
   - `id`: kebab-case, 전체 콘텐츠에서 유일
   - `title`, `alt`: alt는 인물·복장·구도를 담은 한 문장. **비밀 문구 금지** — 특히 동물화·정체 관련 표현(`흰 백사` 등)은 공개 유출 검사에 걸린다. 뱀·늑대 이미지라면 정체를 확정하지 않는 표현을 쓴다.
   - `creator`: 기존 항목 기본값은 `불가사리`. 다른 작가면 반드시 확인받고, 저작권상 등록 권한이 있는지 한 번 확인한다.
   - `characters`: `[cheonryeong]`, `[muyeong]` 또는 둘 다
   - `tags`, `public`: 공개 게시는 `public: true` + 실제 공개 이미지가 모두 있어야 한다
4. **검증** — `npm run validate`와 `npm run test:run`을 실행한다. 갤러리 관련 테스트(`content.test.ts`)가 이미지 목록을 고정하고 있으면 실패 내용을 보여주고 테스트 갱신을 확인받은 뒤 수정한다.
5. **보고** — 추가된 항목, 이동·교체된 파일, 검증 결과를 보고한다. 커밋과 배포는 하지 않는다 — 필요하면 `/deploy-site`를 안내한다.

이미지를 먼저 올리고 메타데이터를 나중에 확정하는 정식 흐름은 로컬 편집기(`npm run editor`)의 staged-images 절차도 있다. 대량 등록이면 편집기를 안내한다.
