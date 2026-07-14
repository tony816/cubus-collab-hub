# 보안 모델

- 작품 데이터는 Supabase에만 저장하고 공개 GitHub에는 코드만 저장합니다.
- Data API의 service-role은 Supabase Edge Function 런타임 안에서만 사용합니다. Worker는 허용 목록이 적용된 프록시를 별도 비밀값으로 호출하며, service-role 키는 Worker·브리지·AI 클라이언트에 전달하지 않습니다.
- MCP는 OAuth 2.1 및 GitHub 본인 확인으로 보호하고 허용 GitHub 로그인 하나만 통과시킵니다.
- ChatGPT Actions와 브리지는 서로 다른 장기 난수 토큰을 사용합니다.
- 웹훅 비밀값은 고정 길이 해시의 constant-time 비교로 검사합니다.
- AI 제안과 사용자 정본 변경을 분리하고, 승인 시 기준 버전을 다시 잠급니다.
- 오래된 기준 버전은 덮어쓰지 않고 `conflicts`에 남깁니다.
- Discord에는 문서 본문, frontmatter, 제안 내용이 전송되지 않습니다.
- OAuth state와 consent는 TTL 10분의 Cloudflare KV 값 및 브라우저 바인딩 쿠키로 검증합니다.
- 공개 저장소 스캔은 개인 로컬 경로, 이전 Drive 식별자, 대표적인 토큰 패턴을 거부합니다.

비밀값을 교체할 때는 Cloudflare Worker Secret을 먼저 갱신한 뒤 Bridge 자격 증명 또는 GPT Action 인증을 갱신합니다.
