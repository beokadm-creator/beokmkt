"""채널 레지스트리. 발행 워커는 여기만 본다."""
from publishers.naver import NaverPublisher
from publishers.selfhosted import SelfHostedPublisher
from publishers.tistory import TistoryPublisher
from publishers.twitter import TwitterPublisher

# 2026-07-05: notebook_return 채널(Firestore articles → notebook-return.web.app)은
# *.web.app 서브도메인 검색 권위 0 + 고아 페이지 문제로 폐지. 반품 노트북 콘텐츠는
# category="notebook_return"로 selfhosted(beoksolution.com) 채널에 발행한다.
PUBLISHERS = {
    "selfhosted": SelfHostedPublisher(),
    "naver": NaverPublisher(),
    "tistory": TistoryPublisher(),
    "twitter": TwitterPublisher(),
}
