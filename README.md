# 천무 기록 보관소

천령과 무영의 관계 기록, 인물 문서, 설정 문서, 공개 갤러리를 제공하는 정적 React 아카이브입니다. GitHub Pages 주소는 `https://gru-stump.github.io/cheonmu-archive/`이며, 해시 라우팅을 사용합니다.

## 로컬 작업

Node.js 20 이상에서 의존성을 설치한 뒤 개발 서버를 실행합니다.

```powershell
npm install
npm run dev
```

로컬 편집기는 별도 터미널에서 실행합니다.

```powershell
npm run editor
```

Vite 개발 서버는 `http://localhost:5173`, 편집 서비스는 IPv4 loopback 전용
`http://127.0.0.1:4174`를 사용합니다. 편집 API는 정해진 loopback `Host`와 개발
`Origin`만 허용하며 Vite 프록시를 통해 접근합니다.

콘텐츠 원본은 `src/content/`, 공개 이미지는 `public/images/`, 비공개 이미지는
`src/content/private-images/`에 저장됩니다. 삭제되거나 교체된 파일은 저장소 루트의
`.trash/`로 이동하여 복구할 수 있습니다. 공개 갤러리는 `public: true`인 항목과 실제
공개 이미지가 모두 준비되어야 하며, `npm run validate`를 통과한 뒤에만 게시합니다.

이미지를 먼저 등록하는 흐름에서는 검사된 임시 파일과 소유권 manifest가
`src/content/staged-images/`에 머뭅니다. 편집기가 표시하는 변경 파일 계획을 확인해
메타데이터 저장을 확정하면 staged 원본이 공개 또는 비공개 목적지로 설치되고 staged
파일과 manifest는 제거됩니다. 교체되는 기존 이미지는 `.trash/images/`로 이동합니다.
`src/content/staged-images/`는 공개 빌드 입력이 아니며 그 안의 파일은 사이트에 게시되지
않습니다.

공개 사이트 변경을 확인하기 전에 콘텐츠 검증, 단위 테스트, 프로덕션 빌드를 실행합니다.

```powershell
npm run validate
npm run test:run
npm run build
```

프로덕션 빌드의 핵심 사용자 경로까지 확인하려면 Playwright용 Chromium을 한 번 설치하고 엔드투엔드 테스트를 실행합니다.

```powershell
npx playwright install chromium
npm run e2e
```

## 천무 서사작가

서사작가 스킬의 정본은 `.agents/skills/cheonmu-story-writer/`에 있으며, Claude Code와 Codex 등 여러 도구가 공유합니다. 문체·묘사 참고 자료는 `.agents/skills/cheonmu-story-writer/references/style-samples/`에 Markdown으로 추가합니다. 이 자료는 표현을 위한 참고일 뿐이며, 사건·설정·인물 정보의 정본(canon)이 아닙니다.

Claude Code에서는 슬래시 명령으로 호출합니다(`.claude/skills/cheonmu-story-writer/`의 래퍼가 정본을 불러옵니다).

```text
/cheonmu-story-writer 새 에피소드를 함께 기획해줘.
```

서사작가는 방향을 바꾸는 질문을 먼저 받고, 장면 계획을 제시해 승인을 받은 뒤에만 초안을 작성합니다. 초안 승인만으로는 파일 저장·사이트 갱신·배포가 실행되지 않습니다.

저장 또는 갱신이 필요할 때는 `이 초안을 사이트에 저장해줘` 또는 `에피소드 문서를 업데이트해줘`처럼 분명히 요청하세요. 나중에 배포할 때는 `저장한 변경을 배포해줘`라고 별도로 요청하세요.

## 배포

GitHub Actions는 `main` 브랜치에 푸시된 커밋을 검증하고 `dist/`를 GitHub Pages에 배포합니다. 로컬 파일을 수정하거나 빌드하는 것만으로는 공개 사이트가 바뀌지 않으며, 변경 사항을 커밋한 뒤 `main`에 푸시해야 공개 사이트에 반영됩니다.
