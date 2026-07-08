# 배포 안내 (2026-07) — 블로그 품질 개편: 인라인 스타일 + 깊이 피벗

발행 PC(Windows) 운영자용. `git-update`가 `git fetch origin main; git merge --ff-only origin/main`로 코드는 자동 반영됩니다. 아래는 그 외 확인 사항입니다.

## 무엇이 바뀌나
- **자체 블로그 디자인 살아남음**: 렌더러가 컴포넌트를 인라인 스타일(다크+골드)로 그린다. 그동안 CMS(beoksolution.com)가 CSS 클래스를 렌더하지 않아 본문이 평문으로 나가던 문제 해결. 새로 발행되는 자체 블로그 글부터 적용(기존 글은 소급 안 됨).
- **반복 붙박이 제거**: 본문에 표/체크리스트가 있으면 글마다 반복되던 공용 비교표/서비스범위/운영흐름을 억제.
- **깊이 피벗**: 얇은 글 대량 → 심층 원고 소량. 글이 더 길고(≈2200~3000자, 5섹션) 밀도 있게, 글마다 고유한 비교표·체크리스트 포함. 발행 큐 깊이/간격을 줄여(3 / 150분) 소량 발행.

## 확인 사항 (중요)
1. **`.env` 오버라이드 점검** — 새 기본값은 `blog_publisher/config.py`에 있고, `.env`가 있으면 그 값이 우선한다. Windows `.env`가 아래를 **구값으로 고정하고 있으면 새 설정이 안 먹으니 그 줄을 지우거나 아래 값으로 맞춘다**:
   - `MODEL_OUTLINE/MODEL_SECTION/MODEL_REVIEW=glm-5.1`
   - `MAX_TOKENS_SECTION=4000` (또는 미설정)
   - `SECTION_MAX_LEN`, `SECTION_TOKEN_CAP`, `DAILY_PUBLISH_TARGET`, `PUBLISH_SPACING_MIN`, `GENERATE_POST_TIMEOUT_SEC`, `OPERATIONAL_BODY_MAX_LEN` → **미설정 권장**(config 기본값 사용).
2. **생성이 느려짐** — glm-5.1 thinking + 4000토큰 × 5섹션으로 글 1건이 ~5~12분. `GENERATE_POST_TIMEOUT_SEC=1080`(18분)으로 Windows 작업 20분 제한보다 먼저 정리되게 맞춰둠. generate 작업이 스케줄러에 의해 강제 종료되면 해당 작업 런타임 제한을 25분으로 올린다.
3. **첫 발행 후 스타일 생존 확인** — 새 자체 블로그 글이 처음 발행되면 공개 URL로 한 번 검증(인라인 style이 CMS 통과하는지 최종 확인. div/span/aside는 실증됨, table/h2만 남음):
   ```
   python blog_publisher\tools\verify_inline_styles.py <새_발행_공개URL>
   ```
   "판정: 통과"가 나오면 완료. "실패"면 해당 태그가 CMS에서 벗겨진 것이니 알려줄 것.

## 롤백
문제 시 `git revert 7838efe`(생성 깊이) 또는 `git revert 9bad6a5`(렌더러)로 개별 되돌림 가능. 두 커밋은 독립적이다.
