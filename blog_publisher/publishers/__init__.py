"""채널 레지스트리. 발행 워커는 여기만 본다."""
from publishers.naver import NaverPublisher
from publishers.selfhosted import SelfHostedPublisher
from publishers.tistory import TistoryPublisher
from publishers.twitter import TwitterPublisher

PUBLISHERS = {
    "selfhosted": SelfHostedPublisher(),
    "naver": NaverPublisher(),
    "tistory": TistoryPublisher(),
    "twitter": TwitterPublisher(),
}
