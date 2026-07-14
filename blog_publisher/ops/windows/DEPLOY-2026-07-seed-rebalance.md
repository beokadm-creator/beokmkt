# 배포 안내 (2026-07-14) — 시드 공급 복구 + 브랜드 비율 강제

발행 PC(Windows) 운영자용. `git-update`로 코드는 자동 반영됩니다.

## 무엇이 바뀌나

- **발행 정지 복구**: 키워드 풀이 소진돼(archived 723건이 topic을 영구 점유) stock-seed가
  "새 키워드 없음"으로 0건을 생성하던 문제 수정. archived 글의 topic은
  30일 냉각기간이 지나면 재작성 시드로 다시 쓸 수 있다.
- **브랜드 비율 강제**: stock-seed가 목표 재고(40)를 `beok 50% / hong 25% /
  notebook_return 25%`로 나눠 브랜드별로 채운다. "남은 키워드 풀 크기가 곧
  발행 비율"이 되던 구조(반품 노트북 독점 사고)를 차단.
- **테마 캡 강화**: 포화 마커(예: '반품') 외 후보가 없으면 이전처럼 전량
  시드하지 않고 배치당 최대 1건만 시드한다.

## 확인 사항

1. **`.env` 오버라이드 점검** — 아래 키는 **미설정 권장**(config 기본값 사용).
   비율을 바꾸고 싶을 때만 설정:
   - `SEED_BRAND_RATIOS` (기본 `beok:0.5,hong:0.25,notebook_return:0.25`)
   - `ARCHIVED_TOPIC_RESEED_COOLDOWN_DAYS` (기본 30; 음수로 두면 과거처럼 영구 차단 = 발행 정지 재발 위험)
   - `AUTO_SEED_THEME_FALLBACK_MAX` (기본 1)
2. **배포 직후 확인** — 다음 Stock Seed 실행(최대 1시간) 후:
   ```
   python blog_publisher\run.py stock_seed selfhosted 40
   ```
   출력에 `브랜드 재고 보충: ... brand=beok ...` 형태로 3개 브랜드가 나오고
   시드가 생성되면 정상. 이후 generate → 발행이 재개된다.
3. **재시드 글은 재작성** — 냉각기간이 지난 archived 주제가 다시 들어오므로
   과거에 품질 문제로 내린 주제도 새 원고(깊이 피벗 프롬프트)로 재작성된다.
   품질 게이트(review 80 / grounding)는 그대로 적용된다.

## 수동 시드(필요 시)

특정 브랜드만 바로 보충하려면:

```
python blog_publisher\run.py auto_seed selfhosted 5 beok
```

## 롤백

`git revert`로 이 커밋만 되돌리면 이전 동작(archived 영구 차단 + 채널 총량
시드)으로 복귀한다. 단, 그 상태에서는 키워드 풀 소진 시 발행이 다시 멈춘다.
