-- 블로그 발행 시스템 핵심 테이블
-- 모든 워커(생성/검수/발행)는 이 테이블의 status만 보고 동작한다.
-- SQLite 기준. PostgreSQL로 옮길 때는 주석 참고.

CREATE TABLE IF NOT EXISTS posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- PG: BIGSERIAL
    channel       TEXT    NOT NULL,                   -- selfhosted | naver | tistory
    topic         TEXT,                               -- 생성 시드(키워드/주제)
    content_type  TEXT    NOT NULL DEFAULT 'howto',   -- review | howto | niche (기획 06)
    category      TEXT,                               -- 분야(기획 08, 네이버 주제 일관)
    blog_profile  TEXT,                               -- 배정된 블로그 프로필 키
    locale        TEXT    NOT NULL DEFAULT 'ko',      -- ko | en (기획 11)
    source_url    TEXT,                               -- 재작성 원본 URL(기획 10)
    translated_from INTEGER,                          -- 번역 원본 post id(기획 11)
    intent        TEXT,                               -- 검색 의도(근거팩에서)
    keywords      TEXT,                               -- 주/보조 키워드(JSON)
    target_engine TEXT,                               -- naver | google (기획 07)
    tags          TEXT,                               -- 발행 태그(JSON)
    title         TEXT,
    meta_desc     TEXT,                               -- 메타 설명(SEO)
    outline       TEXT,                               -- 개요 산출물(JSON 문자열)
    evidence      TEXT,                               -- 근거팩(JSON, 기획 05 §5)
    sources       TEXT,                               -- 출처 목록(JSON)
    grounding_ratio REAL,                             -- 사실검증 결과(기획 05 §6)
    body          TEXT,                               -- 최종 본문(마크다운/HTML)

    status        TEXT    NOT NULL DEFAULT 'draft',
    -- draft -> reviewed -> queued -> publishing -> published | failed | needs_human

    idem_key      TEXT    UNIQUE,                      -- 중복 발행 방지(channel+해시)
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 4,
    next_run_at   TEXT    NOT NULL DEFAULT (datetime('now')),  -- 재시도/예약 발행 시각(UTC)

    review_issues TEXT,                               -- 검수 실패 사유(JSON)
    published_url TEXT,
    last_error    TEXT,

    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 워커가 다음 작업을 빠르게 집어오기 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_posts_status_next
    ON posts(status, next_run_at);

CREATE INDEX IF NOT EXISTS idx_posts_channel
    ON posts(channel);
