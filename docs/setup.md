# 배포 및 이전 안내

이 문서는 비밀값이나 작품 데이터를 GitHub에 저장하지 않는 것을 전제로 합니다.

## 1. Supabase

1. Supabase Dashboard에서 Free Organization `CUBUS`를 생성합니다.
2. 해당 조직에 프로젝트 `cubus-collab`, 리전 `Northeast Asia (Seoul)`을 생성합니다.
3. 프로젝트 ref를 확인한 뒤 다음을 실행합니다.

```powershell
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push --linked
```

마이그레이션 후 Security Advisor와 Performance Advisor에서 새 오류가 없는지 확인합니다. 모든 public 테이블은 RLS가 켜져 있고 `anon`, `authenticated`에는 접근 정책이 없습니다.

## 2. Cloudflare Worker와 GitHub OAuth

```powershell
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

출력된 KV ID를 `packages/worker/wrangler.jsonc`의 `OAUTH_KV` ID에 넣습니다. GitHub Settings → Developer settings → OAuth Apps에서 앱을 생성합니다.

- Homepage: `https://cubus-collab-hub.zpfhfh816.workers.dev`
- Callback: `https://cubus-collab-hub.zpfhfh816.workers.dev/callback`
- GitHub 권한: `read:user user:email`

각 비밀값은 파일이나 셸 기록에 남기지 말고 대화형으로 입력합니다.

```powershell
cd packages/worker
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PROXY_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ACTIONS_API_TOKEN
npx wrangler secret put BRIDGE_API_TOKEN
npx wrangler secret put WEBHOOK_SHARED_SECRET
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put ALLOWED_GITHUB_LOGIN
npx wrangler deploy
```

`ALLOWED_GITHUB_LOGIN`은 `tony816`으로 설정합니다. 나머지 토큰은 각각 다른 32바이트 이상의 난수로 만듭니다.

## 3. Supabase 웹훅과 Discord

배포 마이그레이션은 `public.events`의 알림 대상 이벤트만 다음 주소로 보내는 비동기 `pg_net` 트리거를 구성합니다.

`https://cubus-collab-hub.zpfhfh816.workers.dev/webhooks/supabase`

공유 비밀값은 Supabase Vault의 `cubus_webhook_shared_secret`에 저장하며 헤더 `X-CUBUS-Webhook-Secret`으로만 전송합니다. Worker는 제안·승인·거절·충돌 이벤트만 Discord로 보내며 본문은 폐기합니다. `DISCORD_WEBHOOK_URL`이 아직 없으면 이벤트를 안전하게 수락하되 외부 전송은 생략합니다.

## 4. Obsidian 초기 이전

```powershell
npm run bridge -- configure https://cubus-collab-hub.zpfhfh816.workers.dev "<CUBUS_VAULT_PATH>"
npm run bridge -- auth-set <BRIDGE_API_TOKEN>
npm run bridge -- import
npm run bridge -- verify
npm run bridge -- install-task
```

Windows가 작업 스케줄러 등록 권한을 거부하면 설치기는 현재 사용자 `HKCU` 로그인 실행 항목으로 자동 폴백합니다.

`auth-set`은 토큰을 Windows Credential Manager에 저장합니다. 마이그레이션 보고서와 브리지 로그는 `%LOCALAPPDATA%\cubus-collab-hub`에 생성되며 공개 저장소나 볼트에는 들어가지 않습니다.

## 5. 운영 전환

- 초기 보고서의 `verified`가 `true`인지 확인합니다.
- Claude와 ChatGPT 연결 테스트 후 Google Drive 마스터 로그를 읽기 전용 보관 상태로 전환합니다.
- 기존 Drive 원문을 삭제하지 않습니다.
- AI 응답 전 `sync_context`, 응답 성공 후 `record_turn_summary`를 호출하도록 지시합니다.
