# Claude와 ChatGPT 연결

## Claude

Claude의 Settings → Integrations에서 다음 원격 MCP URL을 사용자 지정 커넥터로 추가합니다.

`https://cubus-collab-hub.zpfhfh816.workers.dev/mcp`

브라우저에서 GitHub OAuth를 완료합니다. 허용 계정이 아니면 Worker가 403으로 거부합니다.

프로젝트 지침에는 다음 규칙을 넣습니다.

1. 응답 전에 `sync_context`를 호출한다.
2. 변경은 `propose_patch`로만 제출한다.
3. 사용자가 현재 대화에서 명시적으로 승인하거나 거절한 경우에만 승인·거절 도구를 호출한다.
4. 응답이 성공한 뒤 `record_turn_summary`를 호출한다.

## ChatGPT MCP

계정에서 전체 MCP 커넥터 쓰기를 지원하면 동일한 `/mcp` URL을 사용합니다.

## ChatGPT Custom GPT Actions

전체 MCP 쓰기가 제공되지 않으면 `openapi/cubus-collab-actions.yaml`을 Custom GPT Actions에 가져옵니다.

1. OpenAPI 문서의 `servers[0].url`을 실제 Worker URL로 바꿉니다.
2. Authentication은 API Key, Bearer 방식으로 설정합니다.
3. 값으로 Worker의 `ACTIONS_API_TOKEN`을 입력합니다.
4. 승인·거절 액션은 consequential 상태를 유지합니다.

GPT 지침에는 Claude와 같은 네 가지 협업 규칙을 넣습니다. API 토큰은 GPT 지침이나 대화 본문에 붙여 넣지 않습니다.
