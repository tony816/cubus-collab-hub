# CUBUS Collaboration Hub

CUBUS 작업 내용을 Google Drive 턴 로그로 복사하는 대신, Supabase를 정본 저장소로 사용해 ChatGPT·Claude·Obsidian을 동기화하는 개인용 협업 허브입니다.

## 핵심 원칙

- 이 공개 저장소에는 코드와 스키마만 둡니다. CUBUS 원고·설정·프롬프트·로그는 절대 커밋하지 않습니다.
- AI는 정본 문서를 직접 수정할 수 없습니다. AI 변경은 `proposal`로 생성되고 사용자의 명시적 승인 후에만 반영됩니다.
- Supabase service-role 키는 Cloudflare Worker Secret에만 저장합니다.
- Discord 알림에는 작품 본문을 넣지 않고 이벤트 종류, 문서 경로, 제안 ID만 보냅니다.

## 구성

- `packages/worker`: OAuth 보호 MCP, ChatGPT Actions REST API, Supabase 웹훅
- `packages/bridge`: Obsidian 전체 가져오기, 검증, 실시간 양방향 동기화
- `packages/shared`: 입력 스키마와 공용 타입
- `supabase/migrations`: RLS 및 낙관적 잠금이 포함된 데이터베이스 스키마
- `openapi`: ChatGPT Custom GPT Actions 명세
- `docs`: 배포·보안·클라이언트 연결 문서

## 빠른 시작

```powershell
npm install
npm run check
```

배포 순서는 [docs/setup.md](docs/setup.md)를 따릅니다. 비밀값은 `.dev.vars.example`을 참고하되 실제 값은 파일에 저장하지 않고 Wrangler Secret과 Windows 자격 증명 관리자에 넣습니다.

## 라이선스

라이선스를 부여하지 않습니다. 소스는 공개 열람할 수 있지만 복제, 수정, 배포 또는 상업적 이용 권한은 별도로 허가되지 않습니다.

