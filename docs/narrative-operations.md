# 천무 자율 서사 소유자 운영 가이드

이 문서는 서버 개발자가 아닌 단일 소유자가 계정, 비밀, 예산, 일정,
게시를 안전하게 운영하기 위한 순서도입니다. 실제 키 값은 이 문서, 소스 코드,
스크린샷, 티켓, 대화에 남기지 않습니다.

## 1. 현재 출시 상태

로컬 보안 검사와 테스트는 실제 계정을 사용하지 않고 실행할 수 있습니다. 다음은
별도의 외부 작업 승인 전까지 **보류**입니다.

- 실제 OpenAI/Anthropic 유료 호출
- Supabase 호스팅 프로젝트 마이그레이션·Edge Function·Vault 설정
- Vercel 관리자 배포
- GitHub 임시 브랜치 생성·게시·삭제와 Pages 배포
- 일간·접속 시·주간·특별일 생산 활성화

또한 현재 `run-schedules`는 예정된 작업을 `generation_jobs`에 **대기열로만
넣고**, 대기 작업을 `generate-draft`로 실행하는 생산 worker가 저장소에 없습니다.
관리자 UI도 `action: access`를 호출하지 않습니다. 두 경로가 구현되고 로컬·스테이징
검증 증거가 있기 전에는 생산 일정을 활성화하지 않습니다. 시계 호출이 성공해도
실제 초안이 생성되지 않을 수 있기 때문입니다.

## 2. 절대 원칙

1. 자동화는 항상 끄고 시작합니다.
2. AI 제공자는 한 번에 하나만 활성화합니다. 자동 장애 전환은 없습니다.
3. 앱 예산과 제공자 계정의 지출 한도를 모두 설정합니다. 더 작은 값이 실질 한도입니다.
4. 승인된 고정 버전만 게시하며, GitHub 경로 충돌을 자동 덮어쓰지 않습니다.
5. 커밋 성공, Actions 성공, Pages 배포 성공을 서로 다른 상태로 판단합니다.
6. 오류 증거에는 ID, 시각, 상태, 안전한 URL만 남기고 키, 전체 인증 헤더,
   원본 prompt, 원본 제공자 응답은 남기지 않습니다.

## 3. 필수 준비물과 증거표

아래 항목을 먼저 준비하고, 값 대신 확인 여부와 날짜만 운영 기록에 남깁니다.

| 항목 | 요구 사항 | 증거 |
| --- | --- | --- |
| Supabase | 전용 프로젝트, 단일 Auth 사용자 | 프로젝트 ref, owner UUID, 확인일 |
| 관리자 주소 | 프로토콜·호스트·포트가 고정된 HTTPS origin | 예: `https://admin.example.com` |
| AI | OpenAI 또는 Anthropic 하나, 전용 API key | 제공자, model ID, 단가 확인일 |
| 예산 | 앱 월/일/호출 한도 + 제공자 계정 한도 | 설정된 USD 금액과 확인일 |
| GitHub | 대상 저장소 하나만 허용하는 fine-grained token | owner/repo/branch, 허용 요약, 만료일 |
| 백업 | 복구 시험이 완료된 DB 백업 + Git 원격 | 백업 ID, 복구 시험일 |

## 4. 로컬 출시 게이트

Node.js 20 이상, Docker Desktop, Supabase CLI, Playwright Chromium을 준비합니다. 실제 비밀은
로컬 `.env` 파일에도 복사하지 않습니다.

```powershell
npm ci
npm run narrative:security
npm run validate
npm run test:run
npm run build
npm run e2e
npm --prefix admin ci
npm --prefix admin run test -- --run
npm --prefix admin run build
npm --prefix admin run e2e
npx supabase db reset --local --yes
npx supabase test db
npm run test:db:concurrency
npm run test:db:upgrade
npm run test:functions:gateway
```

`narrative:security`는 Git 추적 파일, `dist`, `admin/dist`를 스캔합니다. 발견 시 파일명과
규칙명만 출력하며 일치한 값은 출력하지 않습니다. 실패하면 즉시 출시를 중단하고,
유출 가능성이 있는 키는 먼저 폐기·재발급한 뒤 Git 이력을 정리합니다.

## 5. 단일 소유자와 로그인

1. 모든 마이그레이션을 적용한 뒤 Supabase Dashboard의 **Authentication > Users > Add user**에서
   소유자 이메일 계정 하나만 만듭니다.
2. 생성된 UUID를 복사하고 SQL Editor에서 다음을 한 번만 실행합니다.

```sql
insert into public.owner_profiles (owner_id, display_name)
values ('<OWNER_UUID>'::uuid, '천무 소유자')
on conflict (owner_id) do update set display_name = excluded.display_name;
```

3. **Authentication > Sign In / Providers**에서 `Allow new users to sign up`을 끄고, 익명 로그인도
   끄나있음을 확인합니다. 로컬 `supabase/config.toml`의 `enable_signup = false`는 호스팅
   프로젝트를 자동 변경하지 않습니다. [Supabase Auth 일반 설정](https://supabase.com/docs/guides/auth/general-configuration)에서도
   이 옵션을 끄면 기존 사용자만 로그인할 수 있음을 명시합니다.
4. Auth **URL Configuration**의 Site URL과 Redirect URLs에 실제 관리자 origin을 등록합니다.
   매직 링크는 현재 `window.location.origin`으로 돌아옵니다.
5. 소유자 계정으로 마직 링크를 받아 로그인하고, 다른 계정은 `관리자 권한이
   없습니다`로 차단되는지 확인합니다.

## 6. RLS와 권한 확인

SQL Editor는 관리자 권한으로 RLS를 우회할 수 있으므로, 테이블 설정과 실제
`authenticated` 역할 행동을 둘 다 확인합니다.

```sql
-- 결과 0행: public 일반 테이블 중 RLS가 꺼진 테이블이 없어야 합니다.
select c.relname
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by c.relname;

-- 결과 1: 등록된 owner profile은 하나뿐입니다.
select count(*) from public.owner_profiles;
```

다음 검사는 `<OWNER_UUID>`를 실제 값으로, `<NON_OWNER_UUID>`를 존재하지 않는 다른 UUID로
바꿠 트랜잭션 내에서만 실행합니다.

```sql
begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '<NON_OWNER_UUID>', true);
set local role authenticated;
select count(*) as visible_owner_profiles from public.owner_profiles; -- 0
select count(*) as visible_drafts from public.drafts;                 -- 0
rollback;

begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '<OWNER_UUID>', true);
set local role authenticated;
select count(*) as visible_owner_profiles from public.owner_profiles; -- 1
rollback;
```

`npx supabase test db`와 `npm run test:functions:gateway`도 전체 통과해야 합니다. 위 수동 쿼리는
자동 pgTAP 검사를 대체하지 않습니다.

## 7. 관리자 origin과 동일 출처 프록시

브라우저는 상대 경로 `/api/narrative/*`만 호출합니다. `admin/api/narrative/[...path].ts`가
같은 origin의 서버 함수에서 Supabase로 전달합니다. 브라우저에 service key, AI key,
GitHub token을 넣지 않습니다.

Vercel 프로젝트 루트를 `admin/`으로 설정하고 다음만 환경변수로 넣습니다.

- 브라우저 번들: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- Vercel Function: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- 절대 금지: `SUPABASE_SERVICE_ROLE_KEY`, AI key, GitHub token을 Vercel이나 `VITE_*`에 넣기

환경변수를 바꾸면 이전 배포에는 적용되지 않으므로 새 배포가 필요합니다.
([Vercel 환경변수](https://vercel.com/docs/environment-variables)) 관리자 프록시 응답은
`cache-control: no-store`이며, 브라우저가 Supabase REST/Edge를 직접 호출하도록 바꾸지 않습니다.

Supabase Edge 환경변수 `NARRATIVE_ADMIN_ORIGINS`에는 정확한 관리자 origin만 쉼표로
나열합니다. 예: `https://admin.example.com,https://admin-preview.example.com`. `*`, 경로,
쿼리, 마지막 `/`를 사용하지 않습니다. 무작위 preview URL을 모두 허용하지 말고,
캐너리에 사용할 하나의 고정 origin만 등록합니다.

## 8. Vault, Edge 비밀, GitHub 설정

Supabase [Vault](https://supabase.com/docs/guides/database/vault)는 비밀을 암호화해 저장합니다.
소유자 전용 키는 관리자 **설정 > 비밀 연결**에서 저장하고, 저장 후에는
값이 다시 표시되지 않는지 확인합니다. 내부 이름은 다음과 같습니다.

- `narrative_<OWNER_UUID>_openai`
- `narrative_<OWNER_UUID>_anthropic`
- `narrative_<OWNER_UUID>_github`

AI key는 활성 제공자 하나의 것만 저장해도 됩니다. GitHub는 해당 저장소 하나만
선택한 fine-grained token을 사용합니다. 게시 코드는 Contents API로 새 파일을
만들고 Actions/Pages를 읽으므로, 필요한 저장소 권한만 부여합니다.

- Contents: write
- Actions: read
- Pages/Deployments 조회에 필요한 read
- Metadata: 기본 read
- Workflows: 게시 대상이 `.github/workflows/`가 아니므로 write 불필요

[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)는 파일 쓰기에 Contents write가 필요하고
동시 쓰기를 직렬화해야 함을 명시합니다. 토큰에는 만료일을 두고 저장소
전체/organization 관리 권한을 주지 않습니다.

소유자의 GitHub 대상은 SQL Editor에서 서버 설정으로 고정합니다.

```sql
update public.narrative_admin_settings
set github_repository_owner = '<GITHUB_OWNER>',
    github_repository_name = '<GITHUB_REPOSITORY>',
    github_branch = '<TARGET_BRANCH>',
    updated_at = now()
where owner_id = '<OWNER_UUID>'::uuid;
```

스케줄러와 게시 관찰자는 전역 Vault 재료를 사용합니다.

- `narrative_schedule_dispatch_url` = `https://<PROJECT_REF>.supabase.co/functions/v1/run-schedules`
- `narrative_publication_check_url` = `https://<PROJECT_REF>.supabase.co/functions/v1/check-publication`
- `narrative_schedule_dispatch_token` = 충분히 긴 무작위 값

마지막 token은 Edge Function 비밀 `NARRATIVE_SCHEDULE_DISPATCH_TOKEN`과 정확히 같아야 합니다.
정확한 URL과 키를 소스에 쓰지 말고 Dashboard/Vault/Edge secrets에서만 저장합니다.

## 9. 모델 단가와 계정 하드 한도

이 작업에서 공식 문서 링크를 마지막으로 확인한 날은 **2026-08-16**입니다.
단가는 바뀐 수 있으므로 이 문서에 특정 금액을 고정하지 않습니다.

- OpenAI: [API 가격](https://openai.com/api/pricing/), [organization limits](https://platform.openai.com/settings/organization/limits)
- Anthropic: [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [지출·속도 한도](https://platform.claude.com/docs/en/api/rate-limits)

활성할 model ID가 제공자 계정에서 실제로 사용 가능한지 확인한 뒤, 표준
비캐시 입력 USD/1M token과 출력 USD/1M token을 관리자 설정에 입력합니다.
캐싱, batch, long-context, fast/priority 등 별도 단가를 이 시스템의 표준 단가로 잘못
입력하지 않습니다. `단가 확인일`은 오늘보다 미래를 입력할 수 없고, 유효 기간이
지나면 자동 실행이 차단됩니다.

계정 하드 한도는 앱과 독립적으로 설정합니다.

1. OpenAI는 organization/project Billing에서 월 예산·알림을, Anthropic은 Settings > Billing에서
   지출 한도를 설정합니다.
2. 계정 한도는 소유자가 감당할 수 있는 최대 손실 이하로 둡니다.
3. 앱의 월간 한도는 계정 한도 이하, 일일 한도는 월간 한도 이하로 둡니다.
4. 첫 캐너리는 소유자가 승인한 최소의 0이 아닌 월/일 예산과 수동 호출 1회로 한정합니다.
5. 주의/위험 기준은 예를 들어 80%/95%로 시작하되, 실제 예산에 맞게 소유자가 결정합니다.

제공자 지출 한도는 지연되어 적용될 수 있으므로 OpenAI도 사용량 대시보드를
정기적으로 확인하라고 안내합니다. 앱의 사전 예약 장치를 지출 한도의 단일
방어선으로 보지 않습니다.

## 10. fake provider 제거 확인

`NARRATIVE_FAKE_LOCAL_FIXTURE=true`는 로컬/E2E 전용입니다. 호스팅 Edge Function에는 이 변수를
만들지 않거나 `false`로 둡니다. 로컬 `supabase db reset`은 fixture 사용자·제공자를
다시 만드는 개발용 명령이므로 호스팅 DB에 실행하지 않습니다.

호스팅 SQL Editor에서 다음 결과가 0인지 확인합니다.

```sql
select count(*)
from public.provider_settings
where provider_key = 'fake-local-provider' and enabled;
```

관리자 설정에서 실제 제공자 하나만 `활성 제공자`로 표시되는지, 해당 비밀이
`연결됨`인지 확인합니다.

## 11. 배포 순서

아래는 외부 작업 승인 후에만 실행할 순서입니다. 명령은 예시이며 실제
project ref와 연결 상태를 먼저 확인합니다.

1. 새 DB 백업을 만듭니다.
2. Supabase 마이그레이션을 적용하고 스키마 diff를 저장합니다.
3. Edge secrets와 Vault 이름을 맞춘 뒤 Edge Functions를 배포합니다.
4. RLS·인증·gateway 확인 후 관리자 preview를 배포합니다.
5. preview 고정 origin으로 로그인·읽기 경로를 확인한 뒤에만 production을 배포합니다.
6. 자동화와 모든 일정은 아직 끄어 둡니다.

배포를 돌린 직후 관리자 로그인, 설정 조회, 초안 목록, 비밀 연결
상태, 현재 예산을 확인합니다. 비밀 값 자체는 확인 화면에 나오면 안 됩니다.

## 12. 제어된 라이브 캐너리—현재 보류

이 절차는 다음 모든 조건이 충족되고 소유자가 서면으로 외부 작업을 승인한
뒤에만 시작합니다.

- 대기열에서 `generate-draft`로 연결되는 worker가 구현·검증됨
- Admin 새 수동 생성 또는 검증된 수동 dispatcher 경로가 구현됨
- 임시 GitHub branch를 사용해도 production Pages가 즉시 변경되지 않는 preview 경로가 확보됨
- 백업 및 복구 시험 완료, 비상 정지 담당자 대기
- 월/일 예산과 수동 호출 한도가 승인된 최소의 0이 아닌 값임

실행할 때의 정확한 순서는 다음과 같습니다.

1. 자동화와 모든 일정을 끄고, 실제 제공자 하나만 활성화합니다.
2. 제공자 계정 하드 한도와 앱 월/일/수동 1회 한도를 재확인합니다.
3. 짧은 대화 1건을 수동 생성합니다. job ID, draft ID, provider response ID,
   model ID, 입력/출력 token, 예약/정산 미달러, 시각만 기록합니다.
4. 제공자가 보고한 token 사용량과 ledger 정산이 일치하는지 확인합니다.
5. 해당 초안을 사유와 함께 거절합니다. 정사/연속/최근 기억에는 추가되지 않고,
   feedback memory만 작성되는지 확인합니다.
6. fixture-safe 대화 1건을 다시 생성하고 내용·연속성 검사를 직접 한 뒤 공개 승인합니다.
7. 임시 branch에만 게시하고, 게시 커밋 SHA가 승인된 고정 버전과 같은지
   확인합니다. Actions run을 정확한 SHA로 연결하고 validate/test/build/e2e를 모두 확인합니다.
8. preview에서 연결된 기록 제목·본문·메타데이터만 보이고 prompt, raw response,
   private memory, 비용, audit가 보이지 않는지 확인합니다.
9. 커밋 SHA, Actions run ID, preview URL, ledger 요약, DB 상태, 시작/종료 시각을 증거표에 남깁니다.
10. 즉시 자동화를 끄고 임시 branch를 GitHub UI에서 삭제합니다. branch 삭제 전에
    증거가 보존되었는지 확인합니다.

중간에 한 단계라도 실패하면 다음 단계로 가지 않고 다음 롤백을 실행합니다.

- 자동화·일정 전부 끄기
- 활성 provider 해제, 수동 호출 한도 0, 월/일 예산을 이미 약정된 금액 이하로 낮추기
- 임시 branch 후속 게시 중단; 생성된 커밋은 증거 확보 전에 삭제하지 않기
- 예산 예약이 남았다면 job ID로 실패/정산 상태를 확인하고 수동 DB 수정 전에 백업하기
- 원인과 새 테스트 증거가 없으면 재시도하지 않기

## 13. 생산 일정 점진 활성화—현재 보류

제12절의 캐너리가 통과하고 queue worker와 access 호출 경로가 검증되기 전에는
아래 순서를 실행하지 않습니다.

1. **일간만 활성화**: 선택한 서울 시각, 최소 간격, `short_dialogue`로 시작합니다.
2. 24시간 뒤 job/draft 상태, provider token, ledger 정산, 예산 상태, 연속성 경고를 검토합니다.
3. **접속 시 생산**: 관리자 로드 당 호출이 아니라 서버의 최소 간격·일일 호출 한도로
   중복이 차단되는지 확인한 뒤 켭니다.
4. 또 하루 건전성을 확인한 뒤 **주간**을 켭니다. 주의 예산에서 주간 생산이
   중지되는지도 확인합니다.
5. 마지막으로 **특별일**을 하나씩 켭니다. Asia/Seoul 날짜·시각과 재실행 방지를 확인합니다.

각 단계는 `활성 시각 / 설정자 / 일정 ID / 예산 / 첫 job ID / 결과 / 롤백 시각`을
기록합니다. 롤백은 해당 일정의 `활성`을 먼저 끄고, 문제가 전역이면 `자동화 사용`도
끈 뒤 이미 생성된 job의 상태를 별도로 조사하는 순서입니다.

## 14. 게시·배포 장애 복구

### `publish_failed`

1. 초안 승인 상태와 승인된 버전을 바꾸지 않습니다.
2. 관리자에서 failure code, 대상 repository/branch, 기존 경로 충돌 여부를 확인합니다.
3. 인증 실패면 GitHub token을 교체하고, 경로 충돌면 기존 파일을 자동 덮어쓰지 말고
   레코드 ID/번호 충돌의 원인을 수정합니다.
4. 원인이 해소된 뒤 같은 승인 버전의 `게시 재시도`를 한 번만 누릅니다.
5. 같은 idempotency key로 커밋이 두 개 만들어지지 않았는지 확인합니다.

### 커밋은 있지만 workflow/Pages가 실패

- 커밋 성공을 취소하거나 승인 상태를 되돌리지 않습니다.
- 관리자의 workflow 링크가 정확한 commit SHA의 run인지 확인합니다.
- validate/test/build/e2e 중 첫 실패를 로컬에서 재현하고 별도 코드 변경으로 수정합니다.
- 관찰이 `tracking_timed_out`이면 커밋 SHA와 GitHub의 실제 상태를 먼저 대조한 뒤
  service-only tracking retry 절차를 사용합니다. 맹목적으로 새 게시를 만들지 않습니다.
- Pages 배포만 실패했다면 GitHub Actions에서 성공한 빌드 artifact와 Pages 환경을 확인합니다.

## 15. 키 교체

정기 교체와 유출 의심 교체는 같은 순서를 사용합니다.

1. 자동화·일정을 전부 끈니다. 게시 작업이 진행 중이면 끝날 때까지 새 게시를 막습니다.
2. 제공자/GitHub에서 새 키를 만들고 기존 키는 아직 폐기하지 않습니다.
3. 관리자 비밀 연결에 새 값을 덮어쓰고 `연결됨`을 확인합니다.
4. 가격 조회·GitHub 읽기 같은 무변경 확인 경로를 거친 뒤 새 키가 동작함을 확인합니다.
5. 기존 키를 폐기하고 제공자 사용 기록에서 이상 호출이 없는지 확인합니다.
6. dispatcher token은 Edge secret와 Vault를 같은 작업 창에서 교체하고, 둘이 일치하는지
   무변경 호출로 확인합니다.
7. 교체 시각, 키 종류, 기존 키 폐기 여부만 기록하고 값은 기록하지 않습니다.

유출이 의심되면 새 키 검증보다 기존 키 폐기를 우선하고, 관련 커밋·빌드
artifact·로그의 노출 범위를 조사합니다.

## 16. 비상 정지

예산 급증, 많은 중복 job, 알 수 없는 커밋, 유출 의심, 계속되는 401/403/429,
잘못된 정사 게시 중 하나라도 보이면 다음 순서로 정지합니다.

1. 관리자 **설정 > 자동화 사용**을 끈니다.
2. **일정**에서 모든 활성 체크를 끄고 저장합니다.
3. 수동 호출 한도를 0으로 낮추고, 새 AI 호출을 막기 위해 활성 provider를 해제합니다.
4. 제공자 콘솔에서 API key를 폐기하거나 프로젝트 한도를 즉시 낮추는 외부 정지를 실행합니다.
5. 게시가 문제면 GitHub token을 폐기하고, 저장소 Actions/Pages의 진행 중 작업을 GitHub UI에서 중지합니다.
6. 환경이 연결되지 않는 시간에는 Supabase cron job `narrative-schedule-dispatcher`와
   `narrative-publication-checker`를 Dashboard에서 비활성화합니다. 이는 호스팅 변경이므로 사고
   대응자가 실행합니다.
7. 사고 시작 시각을 고정하고 그 시각 이후의 audit, jobs, budget, GitHub, provider 사용 기록을 보존합니다.

정지는 이미 시작한 외부 호출을 취소하지 못할 수 있습니다. 정지 후에도 provider usage와
예산 reconciliation을 확인하는 이유입니다.

## 17. 백업과 복구

- Supabase의 사용 중인 플랜에서 DB 백업/PITR 보존 기간을 확인합니다.
- 배포·마이그레이션·대규모 키 교체 전에 즉시 백업을 만듭니다.
- GitHub 저장소의 모든 승인 콘텐츠는 commit SHA로 복구할 수 있게 원격과 보호 branch를 유지합니다.
- Vault 백업이 DB 백업에 포함되는지는 해당 플랜을 확인하고, 복구한 키는 보안을 위해 재발급합니다.
- 최소 분기 1회 별도 프로젝트로 복구해 migration head, owner 1명, RLS, draft/version,
  memory, budget ledger, schedules, publication SHA를 표본 대조합니다.
- 복구 시험은 자동화·cron·provider·GitHub token이 끄진 격리 환경에서 합니다.

## 18. 모니터링

### 매일

- 대시보드의 실패 10건과 다음 예정 시각
- provider/model별 token·비용, 예약과 정산의 차이
- 일일 예산, 주의/위험/한도 상태, 제공자 계정 usage
- `queued`/`running`/예약 상태로 비정상적으로 오래 남은 job
- 새 `publish_failed`, workflow/pages failure, `tracking_timed_out`

### 매주

- 거절/승인·연속성 경고 비율과 반복되는 원인
- 단가 확인일의 유효 기간, provider model deprecation 공지
- GitHub token 만료일, 알 수 없는 Actions run/commit
- Auth 사용자 1명, owner profile 1건, 예상하지 않은 세션/로그인
- `npm run narrative:security`와 주요 로컬 게이트

임계값을 넘거나 원인을 알 수 없는 실패가 2회 반복되면 자동화를 끈고 원인을
조사합니다. 단가 확인일이 만료되면 시스템이 자동 실행을 막는 것이 정상입니다.

## 19. 커스텀 도메인 주소

현재 게시 관찰자와 관리자 UI는 정지된 repository owner/name에서 만든
`https://<owner>.github.io/<repository>/` 형태만 안전한 Pages 링크로 표시합니다.
GitHub Pages 커스텀 도메인에 배포되었더라도 배포 상태는 `deployed`가 될 수 있지만
아웃바운드 링크는 생략됩니다. v1에는 커스텀 도메인 allowlist가 없으므로 정상적인
보안 동작입니다. 임의의 커스텀 URL을 문서나 DB에 넣어 우회하지 않습니다.

## 20. 외부 작업 체크포인 기록 양식

다음 표를 외부 변경을 하기 전에 복사해 작성합니다.

| 항목 | 기록 |
| --- | --- |
| 승인자 / 승인 시각 | |
| 변경 대상 | Supabase / Vercel / AI / GitHub / schedule 중 선택 |
| 변경 범위 | 프로젝트·함수·브랜치·일정 ID만 기록 |
| 사전 백업 ID | |
| 예산 / 계정 하드 한도 | 금액만 기록 |
| 시작 상태 | 자동화 off, 일정 off, 활성 provider |
| 성공 증거 | job/draft/commit/run/deployment ID, 시각, 결과 |
| 롤백 기준 | |
| 롤백 실행자 / 시각 | |
| 잔여 문제 | |

비밀 값, 전체 Authorization 헤더, 원본 prompt/response는 이 표에 절대 기록하지 않습니다.
