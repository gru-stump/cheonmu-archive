# 천무 기록 보관소

천령과 무영의 관계 기록, 인물 문서, 설정 문서, 공개 갤러리를 제공하는 정적 React 아카이브입니다. GitHub Pages 주소는 `https://thdus4320.github.io/cheonmu-archive/`이며, 해시 라우팅을 사용합니다.

## 로컬 작업

Node.js 20 이상에서 의존성을 설치한 뒤 개발 서버를 실행합니다.

```powershell
npm install
npm run dev
```

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

## 배포

GitHub Actions는 `main` 브랜치에 푸시된 커밋을 검증하고 `dist/`를 GitHub Pages에 배포합니다. 로컬 파일을 수정하거나 빌드하는 것만으로는 공개 사이트가 바뀌지 않으며, 변경 사항을 커밋한 뒤 `main`에 푸시해야 공개 사이트에 반영됩니다.
