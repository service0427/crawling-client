// 📁 extension/content.js - 분산 크롤링 페이지 데이터 수집기


// 에이전트 ID 및 상태 관리
let agentId = null;
let currentJobId = null;
let dataCollectionStartTime = null;

// Chrome Storage에서 에이전트 정보 로드
loadAgentInfo();

async function loadAgentInfo() {
  try {
    const result = await chrome.storage.local.get(['agentId', 'serverId']);
    agentId = result.agentId;
  } catch (error) {
  }
}

// 페이지 데이터 수집 함수
function getAgentData() {
  dataCollectionStartTime = Date.now();

  try {
    // 기본 페이지 정보
    const pageInfo = {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname,
      pathname: window.location.pathname,
      search: window.location.search,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };

    // HTML 수집
    const html = document.documentElement.outerHTML;

    // 쇼핑몰 전용 데이터 수집
    const shoppingData = collectShoppingData();

    // 성능 정보
    const performanceData = collectPerformanceData();

    // 메타데이터
    const metadata = {
      htmlSize: html.length,
      elementCount: document.getElementsByTagName('*').length,
      imageCount: document.images.length,
      linkCount: document.links.length,
      loadTime: Date.now() - dataCollectionStartTime,
      isShoppingSite: isShoppingSite(),
      contentLanguage: document.documentElement.lang || 'unknown'
    };


    return {
      agentId: agentId,
      html: html,
      pageInfo: pageInfo,
      shoppingData: shoppingData,
      performance: performanceData,
      metadata: metadata,
      collectedAt: Date.now()
    };

  } catch (error) {
    throw error;
  }
}

// 쇼핑몰 전용 데이터 수집
function collectShoppingData() {
  if (!isShoppingSite()) return null;

  try {
    const products = [];

    // 네이버 쇼핑 상품 데이터 수집
    if (window.location.hostname.includes('shopping.naver.com')) {
      const productElements = document.querySelectorAll('.product_item, .basicList_item, .product_title');

      productElements.forEach((element, index) => {
        try {
          const titleEl = element.querySelector('.product_title a, .basicList_title a');
          const priceEl = element.querySelector('.price_num, .price strong');
          const imageEl = element.querySelector('img');
          const linkEl = element.querySelector('a');

          if (titleEl || priceEl) {
            products.push({
              index: index,
              title: titleEl?.textContent?.trim() || '',
              price: priceEl?.textContent?.trim() || '',
              image: imageEl?.src || '',
              link: linkEl?.href || '',
              selector: getElementSelector(element)
            });
          }
        } catch (error) {
        }
      });
    }

    // 일반 쇼핑몰 상품 데이터 (휴리스틱 기반)
    if (products.length === 0) {
      const potentialProducts = document.querySelectorAll('[class*="product"], [class*="item"], [data-product-id]');

      potentialProducts.forEach((element, index) => {
        if (index >= 50) return; // 최대 50개까지만

        try {
          const title = element.querySelector('[class*="title"], [class*="name"], h1, h2, h3')?.textContent?.trim();
          const price = element.querySelector('[class*="price"], [class*="cost"]')?.textContent?.trim();

          if (title && price) {
            products.push({
              index: index,
              title: title,
              price: price,
              selector: getElementSelector(element)
            });
          }
        } catch (error) {
        }
      });
    }

    return {
      productCount: products.length,
      products: products.slice(0, 20), // 최대 20개 상품만 전송
      searchQuery: extractSearchQuery(),
      categoryInfo: extractCategoryInfo()
    };

  } catch (error) {
    return null;
  }
}

// 성능 데이터 수집
function collectPerformanceData() {
  try {
    const timing = performance.timing;
    const navigation = performance.navigation;

    return {
      loadEventEnd: timing.loadEventEnd,
      domContentLoadedEventEnd: timing.domContentLoadedEventEnd,
      responseEnd: timing.responseEnd,
      domainLookupTime: timing.domainLookupEnd - timing.domainLookupStart,
      connectTime: timing.connectEnd - timing.connectStart,
      responseTime: timing.responseEnd - timing.requestStart,
      domReadyTime: timing.domContentLoadedEventEnd - timing.navigationStart,
      loadCompleteTime: timing.loadEventEnd - timing.navigationStart,
      navigationType: navigation.type,
      redirectCount: navigation.redirectCount
    };
  } catch (error) {
    return null;
  }
}

// 쇼핑 사이트 여부 판단
function isShoppingSite() {
  const hostname = window.location.hostname.toLowerCase();
  const shoppingSites = [
    'shopping.naver.com',
    'search.shopping.naver.com',
    'smartstore.naver.com',
    'coupang.com',
    'gmarket.co.kr',
    'auction.co.kr',
    '11st.co.kr',
    'interpark.com',
    'lotte.com',
    'tmon.co.kr',
    'wemakeprice.com'
  ];

  return shoppingSites.some(site => hostname.includes(site)) ||
    document.querySelector('[class*="product"], [class*="shop"], [data-product-id]') !== null;
}

// 검색어 추출
function extractSearchQuery() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('query') || urlParams.get('q') || urlParams.get('keyword') || '';
}

// 카테고리 정보 추출
function extractCategoryInfo() {
  try {
    const breadcrumbs = document.querySelectorAll('.breadcrumb li, [class*="breadcrumb"] a, [class*="category"] a');
    const categories = Array.from(breadcrumbs).map(el => el.textContent?.trim()).filter(Boolean);

    return {
      breadcrumbs: categories,
      currentCategory: categories[categories.length - 1] || ''
    };
  } catch (error) {
    return null;
  }
}

// CSS 셀렉터 생성
function getElementSelector(element) {
  try {
    if (element.id) return `#${element.id}`;

    let selector = element.tagName.toLowerCase();
    if (element.className) {
      const classes = element.className.split(' ').filter(Boolean).slice(0, 2);
      selector += '.' + classes.join('.');
    }

    return selector;
  } catch (error) {
    return 'unknown';
  }
}

// HTTP 백업 전송 (WebSocket 실패 시)
async function sendHttpBackup(data) {
  try {
    const response = await fetch('http://localhost:4000/receive-html', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...data,
        backup: true,
        source: 'content_script'
      })
    });

    if (response.ok) {
      return true;
    } else {
      return false;
    }
  } catch (error) {
    return false;
  }
}

// Background Script 메시지 리스너 - 분산 크롤링용
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  switch (message.type) {
    case 'COLLECT_PAGE_DATA':
      handleDataCollectionRequest(message, sendResponse);
      return true; // 비동기 응답

    case 'GET_PAGE_STATUS':
      sendResponse({
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        isShoppingSite: isShoppingSite()
      });
      break;

    default:
  }
});

async function handleDataCollectionRequest(message, sendResponse) {
  currentJobId = message.jobId;

  try {
    // 페이지 로드 완료 대기
    if (document.readyState !== 'complete') {

      const loadPromise = new Promise((resolve) => {
        const checkLoad = () => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            setTimeout(checkLoad, 100);
          }
        };
        checkLoad();
      });

      await loadPromise;
    }

    // 추가 대기 (동적 콘텐츠 로드) - 최적화: 1.5초 → 0.5초
    await new Promise(resolve => setTimeout(resolve, 500));

    const agentData = getAgentData();

    const responseData = {
      success: true,
      data: {
        ...agentData,
        jobId: currentJobId,
        metadata: {
          ...agentData.metadata,
          url: window.location.href,
          title: document.title,
          domain: window.location.hostname,
          collectedAt: new Date().toISOString()
        }
      }
    };

    sendResponse(responseData);

  } catch (error) {

    sendResponse({
      success: false,
      error: error.message,
      jobId: currentJobId
    });

    // HTTP 백업 시도
    try {
      const basicData = {
        agentId: agentId,
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title,
        error: error.message,
        jobId: currentJobId
      };

      await sendHttpBackup(basicData);
    } catch (backupError) {
    }
  } finally {
    currentJobId = null;
  }
}

// 페이지 가시성 변경 감지
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentJobId) {
  }
});

// 페이지 언로드 시 정리
window.addEventListener('beforeunload', () => {
  if (currentJobId) {
  }
});

// 초기화 완료 알림
chrome.runtime.sendMessage({
  type: 'CONTENT_SCRIPT_READY',
  url: window.location.href,
  timestamp: Date.now()
}).catch(() => {
  // Background script가 준비되지 않았을 수 있음
});

