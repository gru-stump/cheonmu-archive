---
name: deploy-site
description: Validate, test, build, and deploy the Cheonmu archive to GitHub Pages. Only use when the user explicitly asks to deploy.
argument-hint: "[커밋 메시지(선택)]"
disable-model-invocation: true
---

천무 아카이브를 검증하고 GitHub Pages에 배포한다. 아래 순서를 지키고, 어느 단계든 실패하면 멈추고 실패 내용을 보고한다.

1. `git status --short`로 작업 트리를 확인한다.
   - 미커밋 변경이 있으면 변경 파일 목록을 보여주고, 커밋에 포함할지 사용자에게 확인받는다. 인자로 커밋 메시지가 주어졌으면(`$ARGUMENTS`) 그것을 사용하고, 없으면 변경 내용에 맞는 메시지를 제안해 승인받는다.
   - 루트의 `천무_캐릭터_프로필.md`처럼 사이트 빌드에 포함되지 않는 파일이 커밋 대상에 섞여 있으면, 공개 저장소에서 열람 가능해진다는 점을 한 번 언급한다.
2. 검증을 순서대로 실행한다: `npm run validate` → `npm run test:run` → `npm run build`. 하나라도 실패하면 배포를 중단하고 원인을 보고한다.
3. 커밋이 필요하면 커밋하고 `git push origin main`으로 푸시한다.
4. `gh run list --limit 1`로 트리거된 워크플로를 확인하고 `gh run watch <id> --exit-status`로 완료까지 지켜본다.
5. 결과를 보고한다: 커밋 해시, 워크플로 결론, 공개 주소 `https://gru-stump.github.io/cheonmu-archive/`.

주의: 이 명령은 공개 사이트를 바꾼다. 사용자가 명시적으로 요청한 경우에만 실행하며, 검증 실패 상태로 푸시하지 않는다.
