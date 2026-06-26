(function () {
  const DATA_URL = "/data/solutions.json";
  const SECTION_ID = "solutions-lineup";
  const REFERENCES_ID = "solution-references";
  const META = {
    title: "비오케이솔루션 · 솔루션 레퍼런스 — 학술대회·EMS·BMS·여행·AI 자동화",
    description:
      "비오케이솔루션은 학술대회 통합 시스템(e-Regi), AI 동시통역, EMS·BMS 통합 운영 관제, 에너지 관리 시스템, 배터리 관리 시스템, 호텔 예약 커머스, 법률·행정 자동화 등 실제 운영 중인 솔루션을 보유하고 있으며, 고객사에 맞춘 커스터마이징을 제공합니다. 관계사 (주)홍커뮤니케이션의 학술·MICE 운영 현장에서 다년간 검증되었습니다.",
    ogDescription: "실제 운영 중인 12개 솔루션 포트폴리오를 고객사의 업무·도메인·규모에 맞춰 커스터마이징합니다."
  };

  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const listItems = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const chips = (items) => items.map((item) => `<span>${escapeHtml(item)}</span>`).join("");

  function renderLineup(categories) {
    return `
      <div class="solution-lineup" aria-label="솔루션 카테고리">
        ${categories
          .map(
            (category, index) => `
              <button class="solution-lineup__card" type="button" data-lineup="${escapeHtml(category.id)}" aria-label="${escapeHtml(category.name)} 솔루션 보기">
                <span class="solution-lineup__top">
                  <span class="solution-lineup__mark">${String(index + 1).padStart(2, "0")}</span>
                  <span class="solution-lineup__count">솔루션 ${escapeHtml(category.count)}개</span>
                </span>
                <span class="solution-lineup__label">${escapeHtml(category.label)}</span>
                <span class="solution-lineup__name">${escapeHtml(category.name)}</span>
                <span class="solution-lineup__summary">${escapeHtml(category.summary)}</span>
                <span class="solution-lineup__preview">${escapeHtml(category.preview.join(" · "))}</span>
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderFilters(categories) {
    return `
      <div class="solution-filters" aria-label="솔루션 필터">
        <button class="solution-filter is-active" type="button" data-filter="all" aria-pressed="true">전체</button>
        ${categories
          .map(
            (category) => `
              <button class="solution-filter" type="button" data-filter="${escapeHtml(category.id)}" aria-pressed="false">
                ${escapeHtml(category.name)}
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  function renderCard(solution) {
    const energyBadges = solution.featured
      ? `<span class="solution-energy-badges" aria-label="EMS BMS 보조 키워드"><span>ENERGY</span><span>BESS</span></span>`
      : "";

    return `
      <article class="solution-card${solution.featured ? " is-featured" : ""}" tabindex="0" data-category="${escapeHtml(solution.categoryId)}" data-solution-id="${escapeHtml(solution.id)}" aria-label="${escapeHtml(solution.name)}">
        <div class="solution-card__top">
          <span class="solution-tag">${escapeHtml(solution.categoryLabel)}</span>
          ${energyBadges}
        </div>
        <h3>${escapeHtml(solution.name)}</h3>
        <div class="solution-card__id">${escapeHtml(solution.englishId)}</div>
        <p class="solution-card__headline">${escapeHtml(solution.headline)}</p>
        <div class="solution-card__block">
          <h4>핵심 기능</h4>
          <ul>${listItems(solution.features)}</ul>
        </div>
        <p class="solution-card__case"><strong>운영 사례</strong>${escapeHtml(solution.case)}</p>
        <div class="solution-card__custom">
          <span class="solution-custom-badge" aria-label="커스터마이징 가능 영역">▣ 커스터마이징 가능 영역</span>
          <div class="solution-card__block">
            <ul>${listItems(solution.customizable)}</ul>
          </div>
          <div class="solution-card__industries" aria-label="적합 업종">${chips(solution.industries)}</div>
        </div>
      </article>
    `;
  }

  function renderSolutions(data) {
    return `
      <section class="beok-solutions" id="${SECTION_ID}" aria-labelledby="solutions-heading">
        <div class="beok-solutions__inner">
          <div class="beok-solutions__header">
            <div>
              <span class="beok-eyebrow">Our Solutions</span>
              <h2 id="solutions-heading">Our Solutions — 검증된 솔루션, 당신에 맞게</h2>
              <p class="beok-solutions__lead">검증된 솔루션을, 당신의 비즈니스에 맞게 새로 조립합니다. 학술대회·여행 커머스·에너지 관제·법률 자동화·기업 시스템까지, 실제 운영 중인 솔루션을 화면·기능·연동 범위까지 고객사에 맞춰 구성합니다.</p>
            </div>
            <div class="beok-solutions__proof" aria-label="솔루션 검증 지표">
              <div><strong>12</strong><span>운영 중인 솔루션 포트폴리오</span></div>
              <div><strong>5</strong><span>학술·행사 운영 현장 검증 솔루션</span></div>
              <div><strong>100%</strong><span>업무·도메인·규모별 커스터마이징</span></div>
            </div>
          </div>
          ${renderLineup(data.categories)}
          <div id="${REFERENCES_ID}" class="scroll-mt-24">
            ${renderFilters(data.categories)}
            <div class="solution-grid">
              ${data.solutions.map(renderCard).join("")}
            </div>
          </div>
          <section class="solution-cta" aria-labelledby="solutions-custom-heading">
            <div>
              <h2 id="solutions-custom-heading">모든 솔루션은 커스터마이징 가능합니다.</h2>
              <p>화면·기능·연동·운영 정책까지, 고객사 상황에 맞게 새로 조립합니다.</p>
              <div class="solution-cta__actions">
                <a class="solution-cta__button solution-cta__button--primary" href="/contact">솔루션 도입 상담</a>
                <a class="solution-cta__button solution-cta__button--ghost" href="#custom-build">커스터마이징 범위 보기</a>
              </div>
            </div>
            <div class="solution-cta__columns">
              <div class="solution-cta__column"><strong>화면 · UX</strong><span>사용자 흐름과 UI 컴포넌트를 도메인·브랜드에 맞춰 새로 설계합니다.</span></div>
              <div class="solution-cta__column"><strong>데이터 · 연동</strong><span>결제 PG · 알림 채널 · 외부 API · 기존 시스템 데이터까지 통합합니다.</span></div>
              <div class="solution-cta__column"><strong>운영 정책 · 권한</strong><span>회원 등급·요금·승인 흐름·역할 기반 접근(RBAC)을 회사에 맞춥니다.</span></div>
            </div>
          </section>
        </div>
      </section>
    `;
  }

  function findPlacementRoot() {
    const root = document.getElementById("root") || document.body;
    const sections = Array.from(root.querySelectorAll("main section, section"));
    const processSection = sections.find((element) => /진행 과정/.test(element.textContent || ""));
    const comparisonSection = sections.find((element) => /비교 포인트/.test(element.textContent || ""));
    const target = processSection || (comparisonSection ? comparisonSection.nextElementSibling : null);

    const customBuild = sections.find((element) => /포함 기능|필요한 기능|맞춤 개발/.test(element.textContent || ""));
    if (customBuild && !customBuild.id) {
      customBuild.id = "custom-build";
    }

    if (target && target.parentElement) {
      return { parent: target.parentElement, before: target };
    }

    return { parent: root, before: null };
  }

  function applyMeta() {
    document.documentElement.lang = "ko";
    document.querySelectorAll("title").forEach((title) => title.remove());
    const title = document.createElement("title");
    title.textContent = META.title;
    document.head.appendChild(title);

    const setMeta = (selector, attributes) => {
      document.querySelectorAll(selector).forEach((node) => node.remove());
      const meta = document.createElement("meta");
      Object.entries(attributes).forEach(([key, value]) => meta.setAttribute(key, value));
      document.head.appendChild(meta);
    };

    setMeta('meta[name="description"]', { name: "description", content: META.description });
    setMeta('meta[property="og:title"]', { property: "og:title", content: META.title });
    setMeta('meta[property="og:description"]', { property: "og:description", content: META.ogDescription });
    setMeta('meta[property="og:type"]', { property: "og:type", content: "website" });
    setMeta('meta[property="og:url"]', { property: "og:url", content: "https://beoksolution.com/" });
    setMeta('meta[property="og:image"]', { property: "og:image", content: "https://beoksolution.com/img/logo.png" });
  }

  function wireInteractions(section) {
    const filters = Array.from(section.querySelectorAll("[data-filter]"));
    const cards = Array.from(section.querySelectorAll("[data-category]"));

    function applyFilter(categoryId) {
      filters.forEach((button) => {
        const isActive = button.dataset.filter === categoryId;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
      });

      cards.forEach((card) => {
        const visible = categoryId === "all" || card.dataset.category === categoryId;
        card.classList.toggle("is-hidden", !visible);
      });
    }

    filters.forEach((button) => {
      button.addEventListener("click", () => applyFilter(button.dataset.filter));
    });

    section.querySelectorAll("[data-lineup]").forEach((button) => {
      button.addEventListener("click", () => {
        const categoryId = button.dataset.lineup;
        applyFilter(categoryId);
        const firstCard = section.querySelector(`[data-category="${CSS.escape(categoryId)}"]`);
        (firstCard || document.getElementById(REFERENCES_ID)).scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function appendStructuredData(data) {
    if (document.getElementById("beok-solutions-jsonld")) {
      return;
    }

    const organization = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "주식회사 비오케이솔루션",
      alternateName: ["BEOK Solution", "비오케이솔루션"],
      url: "https://beoksolution.com",
      logo: "https://beoksolution.com/img/logo.png",
      address: {
        "@type": "PostalAddress",
        streetAddress: "송파대로 201",
        addressLocality: "송파구",
        addressRegion: "서울특별시",
        addressCountry: "KR"
      },
      email: "aaron@beoksolution.com",
      subOrganization: {
        "@type": "Organization",
        name: "(주)홍커뮤니케이션",
        url: "https://hongcomm.kr",
        description: "관계사 — MICE·학술대회 기획·운영 전문"
      }
    };

    const softwareApplications = data.solutions.map((solution) => ({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: solution.name,
      alternateName: [solution.englishId, ...solution.seoKeywords],
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description: `${solution.headline} ${solution.case} ${solution.customizable.join(" · ")}까지 고객사에 맞춰 커스터마이징됩니다.`,
      provider: {
        "@type": "Organization",
        name: "주식회사 비오케이솔루션",
        url: "https://beoksolution.com"
      },
      offers: {
        "@type": "Offer",
        url: "https://beoksolution.com/#contact",
        priceCurrency: "KRW",
        price: "0",
        availability: "https://schema.org/InStock"
      }
    }));

    const script = document.createElement("script");
    script.id = "beok-solutions-jsonld";
    script.type = "application/ld+json";
    script.textContent = JSON.stringify({ "@context": "https://schema.org", "@graph": [organization, ...softwareApplications] });
    document.head.appendChild(script);
  }

  async function mountSolutions() {
    if (document.getElementById(SECTION_ID)) {
      return;
    }

    const response = await fetch(DATA_URL, { cache: "no-cache" });
    const data = await response.json();
    applyMeta();
    appendStructuredData(data);

    const container = document.createElement("div");
    container.innerHTML = renderSolutions(data).trim();
    const section = container.firstElementChild;
    const placement = findPlacementRoot();
    placement.parent.insertBefore(section, placement.before);
    wireInteractions(section);
    if (location.hash === `#${SECTION_ID}` || location.hash === `#${REFERENCES_ID}`) {
      document.querySelector(location.hash)?.scrollIntoView({ block: "start" });
    }
    window.setTimeout(applyMeta, 1000);
  }

  function whenReady() {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const root = document.getElementById("root");
      if ((root && root.children.length) || attempts > 20) {
        window.clearInterval(timer);
        mountSolutions().catch((error) => console.error("Failed to mount BEOK solutions section", error));
      }
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", whenReady);
  } else {
    whenReady();
  }
})();
