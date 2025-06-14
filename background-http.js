// 📁 extension/background-http.js - HTTP 폴링 방식 분산 크롤링 에이전트

class DistributedCrawlingAgent {
  constructor() {
    this.agentId = null;
    this.isConnected = false;
    this.currentJobs = new Map();
    this.statistics = {
      completedJobs: 0,
      failedJobs: 0,
      totalJobs: 0
    };

    // 프로덕션 서버 URL
    this.HTTP_SERVER = 'http://mkt.techb.kr';

    this.pollInterval = 800; // 800ms 마다 작업 확인 (기존 3초에서 변경)
    this.pollTimer = null;

    // 탭 풀 관리
    this.tabPool = [];
    this.tabPoolSize = 3; // 미리 생성할 탭 개수
    this.tabStatus = new Map(); // tabId -> {status: 'idle'|'busy', jobId: null}

    this.init();
  }

  async init() {

    // Chrome Storage에서 에이전트 ID 로드
    await this.loadAgentId();

    // 에이전트 등록
    await this.registerAgent();

    // Chrome 메시지 리스너 설정
    this.setupMessageListeners();

    // Chrome Alarms를 사용하여 주기적으로 Service Worker 깨우기
    this.setupAlarms();

    // 탭 풀 초기화
    await this.initializeTabPool();

    // 탭 상태 모니터링 시작
    this.startTabMonitoring();
  }

  async loadAgentId() {
    const result = await chrome.storage.local.get(['agentId', 'agentAlias']);
    if (result.agentId) {
      // 저장된 ID를 그대로 사용 (이미 별칭이 포함되어 있을 수 있음)
      this.agentId = result.agentId;
    } else {
      // 새로 생성하는 경우
      const randomId = this.generateAgentId(); // 4자리 랜덤 문자열

      // 별칭이 있으면 별칭_랜덤4자리, 없으면 랜덤4자리만
      if (result.agentAlias) {
        this.agentId = `${result.agentAlias}_${randomId}`;
      } else {
        this.agentId = randomId;
      }

      await chrome.storage.local.set({ agentId: this.agentId });
    }
  }

  generateAgentId() {
    // 4자리 랜덤 문자열 생성 (영문 소문자 + 숫자)
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  async registerAgent() {
    try {
      const response = await fetch(`${this.HTTP_SERVER}/api/agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          agentId: this.agentId,
          payload: {
            name: 'Chrome Extension Agent',
            capabilities: ['chrome_extension', 'naver_shopping'],
            maxConcurrentJobs: 3,
            supportedSites: ['naver.com', 'shopping.naver.com'],
            version: '2.0.0'
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        this.isConnected = true;
        this.updateConnectionStatus('online');

        // 작업 폴링 시작
        this.startPolling();
      } else {
        const errorText = await response.text();
        throw new Error(`Registration failed: ${response.status}`);
      }
    } catch (error) {
      this.isConnected = false;
      this.updateConnectionStatus('offline');

      // 재시도
      setTimeout(() => this.registerAgent(), 5000);
    }
  }

  startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(async () => {
      if (!this.isConnected) return;

      try {
        const response = await fetch(`${this.HTTP_SERVER}/api/agent/get-pending-jobs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            agentId: this.agentId
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.jobs && data.jobs.length > 0) {
            for (const job of data.jobs) {
              await this.handleJobAssignment(job);
            }
          }
        }

        // 작업 유무와 관계없이 항상 하트비트 전송
        await this.sendHeartbeat();
      } catch (error) {
      }
    }, this.pollInterval);
  }

  async sendHeartbeat() {
    try {
      const response = await fetch(`${this.HTTP_SERVER}/api/agent/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          agentId: this.agentId,
          type: 'HEARTBEAT',
          payload: {
            timestamp: Date.now(),
            currentJobs: Array.from(this.currentJobs.keys()),
            statistics: this.statistics
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 연결 상태 업데이트
      if (!this.isConnected) {
        this.isConnected = true;
        this.updateConnectionStatus('online');
      }
    } catch (error) {

      // 연결 실패 시 상태 업데이트
      if (this.isConnected) {
        this.isConnected = false;
        this.updateConnectionStatus('offline');

        // 10초 후 재연결 시도
        setTimeout(() => {
          this.registerAgent();
        }, 10000);
      }
    }
  }

  async handleJobAssignment(payload) {
    const { jobId, query, options } = payload;


    const job = {
      id: jobId,
      query: query,
      options: options || {},
      startTime: Date.now(),
      timeout: options?.timeout || 30000,
      status: 'assigned'
    };

    this.currentJobs.set(jobId, job);
    this.statistics.totalJobs++;

    try {
      // Chrome 탭에서 작업 실행
      await this.executeJob(job);
    } catch (error) {
      await this.reportJobResult(jobId, false, null, error.message);
    }

    await this.updateStorageData();
  }

  async executeJob(job) {

    try {
      // 사용 가능한 탭 찾기
      const availableTab = await this.getAvailableTab();
      if (!availableTab) {
        throw new Error('사용 가능한 탭이 없습니다');
      }

      // 탭 상태를 busy로 변경
      this.tabStatus.set(availableTab.id, { status: 'busy', jobId: job.id });
      job.tabId = availableTab.id;
      job.status = 'executing';

      // 검색 URL 생성
      const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(job.query)}`;

      // 기존 탭에서 URL 변경
      await chrome.tabs.update(availableTab.id, { url: searchUrl });

      // 타임아웃 설정
      const timeoutId = setTimeout(async () => {
        await this.reportJobResult(job.id, false, null, 'timeout');
        await this.releaseTab(availableTab.id);
        this.cleanupJob(job.id);
      }, job.timeout);

      job.timeoutId = timeoutId;

      // 페이지 로드 완료 대기
      await this.waitForTabLoad(availableTab.id);

      // Content script에게 데이터 수집 요청
      try {
        const response = await chrome.tabs.sendMessage(availableTab.id, {
          type: 'COLLECT_PAGE_DATA',
          jobId: job.id
        });

        if (response && response.success) {
          const processingTime = Date.now() - job.startTime;

          await this.reportJobResult(job.id, true, response.data, null, processingTime);
        } else {
          throw new Error('Content script 응답 없음');
        }

      } catch (error) {
        await this.reportJobResult(job.id, false, null, error.message);
      }

      // 탭을 다시 idle 상태로 전환
      await this.releaseTab(availableTab.id);
      this.cleanupJob(job.id);

    } catch (error) {
      await this.reportJobResult(job.id, false, null, error.message);
      this.cleanupJob(job.id);
    }
  }

  async reportJobResult(jobId, success, result, error, processingTime) {
    const job = this.currentJobs.get(jobId);
    if (!job) {
      return;
    }

    try {
      const response = await fetch(`${this.HTTP_SERVER}/api/agent/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          agentId: this.agentId,
          type: 'JOB_RESULT',
          payload: {
            jobId: jobId,
            status: success ? 'completed' : 'failed',
            data: result,
            error: error,
            processingTime: processingTime || (Date.now() - job.startTime)
          }
        })
      });

      if (response.ok) {
        // 통계 업데이트
        if (success) {
          this.statistics.completedJobs++;
        } else {
          this.statistics.failedJobs++;
        }

      }
    } catch (error) {
    }

    await this.updateStorageData();
  }

  cleanupJob(jobId) {
    const job = this.currentJobs.get(jobId);
    if (!job) return;

    // 타임아웃 클리어
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
    }

    // 탭은 닫지 않고 풀에 유지

    this.currentJobs.delete(jobId);
  }

  async updateConnectionStatus(status) {
    await chrome.storage.local.set({
      connectionStatus: status,
      lastUpdate: Date.now()
    });
  }

  async updateStorageData() {
    await chrome.storage.local.set({
      agentId: this.agentId,
      isConnected: this.isConnected,
      currentJobs: Array.from(this.currentJobs.entries()),
      statistics: this.statistics,
      lastUpdate: Date.now()
    });
  }

  setupMessageListeners() {
    // Chrome 확장 메시지 처리
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'GET_AGENT_STATUS':
          sendResponse({
            agentId: this.agentId,
            isConnected: this.isConnected,
            currentJobs: this.currentJobs.size,
            statistics: this.statistics
          });
          break;

        case 'FORCE_RECONNECT':
          this.registerAgent();
          sendResponse({ success: true });
          break;

        case 'UPDATE_AGENT_ALIAS':
          this.updateAgentAlias(message.alias).then(() => {
            sendResponse({ success: true });
          });
          return true; // 비동기 응답을 위해 true 반환
          break;

        case 'CHANGE_AGENT_ID':
          this.changeAgentId(message.newId, message.alias).then(() => {
            sendResponse({ success: true });
          }).catch((error) => {
            sendResponse({ success: false, error: error.message });
          });
          return true; // 비동기 응답을 위해 true 반환
          break;

        default:
      }
    });
  }

  async updateAgentAlias(alias) {
    // 별칭을 스토리지에 저장
    await chrome.storage.local.set({ agentAlias: alias });

    // 현재 ID 저장
    const oldAgentId = this.agentId;

    // 새 ID 생성 (별칭_랜덤4자리 또는 랜덤4자리만)
    const randomId = this.generateAgentId();
    this.agentId = alias ? `${alias}_${randomId}` : randomId;

    // 스토리지에 새 ID 저장
    await chrome.storage.local.set({ agentId: this.agentId });

    // 기존 에이전트 삭제 요청
    if (oldAgentId !== this.agentId) {
      try {
        await fetch(`${this.HTTP_SERVER}/api/agent/${encodeURIComponent(oldAgentId)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
      }
    }

    // 폴링 중지
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // 연결 상태 초기화
    this.isConnected = false;

    // 새 ID로 재등록
    await this.registerAgent();
  }

  async changeAgentId(newId, alias) {
    const oldAgentId = this.agentId;

    // 폴링 중지
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // 현재 진행 중인 작업들 정리
    this.currentJobs.clear();

    // 기존 에이전트 삭제 요청
    if (oldAgentId && oldAgentId !== newId) {
      try {
        await fetch(`${this.HTTP_SERVER}/api/agent/${encodeURIComponent(oldAgentId)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          }
        });
      } catch (error) {
      }
    }

    // 새 ID를 그대로 사용 (별칭은 이미 ID에 포함되어 있음)
    this.agentId = newId;

    // ID에서 별칭 부분 추출 (별칭_4자리 형식인 경우)
    let extractedAlias = '';
    const parts = newId.split('_');
    if (parts.length === 2 && parts[1].length === 4) {
      // 별칭_4자리 형식
      extractedAlias = parts[0];
    }

    // 스토리지에 새 ID와 추출한 별칭 저장
    await chrome.storage.local.set({
      agentId: newId,
      agentAlias: extractedAlias
    });

    // 통계 초기화
    this.statistics = {
      completedJobs: 0,
      failedJobs: 0,
      totalJobs: 0
    };

    // 연결 상태 초기화
    this.isConnected = false;
    this.updateConnectionStatus('offline');

    // 새 ID로 재등록
    await this.registerAgent();
  }

  setupAlarms() {
    // 30초마다 알람을 설정하여 Service Worker를 깨우기
    chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 }); // 30초

    // 알람 리스너 설정
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'keepAlive') {
        // 폴링이 중단되었다면 다시 시작
        if (!this.pollTimer && this.isConnected) {
          this.startPolling();
        }
        // 탭 풀이 비어있다면 다시 초기화
        if (this.tabPool.length === 0) {
          this.initializeTabPool();
        }
        // 탭 상태 확인
        this.checkTabHealth();
      }
    });
  }

  // 탭 풀 초기화
  async initializeTabPool() {

    // 먼저 Storage에서 기존 탭 ID들을 확인
    const storageData = await chrome.storage.local.get('tabPoolIds');
    const existingTabIds = storageData.tabPoolIds || [];

    // 기존 탭들이 여전히 열려있는지 확인
    if (existingTabIds.length > 0) {

      for (const tabId of existingTabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          // 탭이 존재하고 about:blank인 경우만 재사용
          if (tab && (tab.url === 'about:blank' || tab.url === 'chrome://newtab/')) {
            this.tabPool.push(tab);
            this.tabStatus.set(tab.id, { status: 'idle', jobId: null });
          }
        } catch (error) {
          // 탭이 닫혔거나 접근할 수 없음
        }
      }
    }

    // 현재 활성 윈도우 확인 (시크릿 모드 포함)
    const windows = await chrome.windows.getAll();
    const currentWindow = windows.find(w => w.focused) || windows[0];

    // 부족한 탭 수만큼 새로 생성
    const tabsToCreate = this.tabPoolSize - this.tabPool.length;

    for (let i = 0; i < tabsToCreate; i++) {
      try {
        // 현재 윈도우와 같은 모드에서 탭 생성
        const tab = await chrome.tabs.create({
          url: 'about:blank',
          active: false,
          windowId: currentWindow.id
        });

        this.tabPool.push(tab);
        this.tabStatus.set(tab.id, { status: 'idle', jobId: null });

      } catch (error) {
      }
    }

    // 탭 풀 ID들을 Storage에 저장
    const newTabIds = this.tabPool.map(tab => tab.id);
    await chrome.storage.local.set({ tabPoolIds: newTabIds });

  }

  // 사용 가능한 탭 찾기
  async getAvailableTab() {
    // idle 상태의 탭 찾기
    for (const tab of this.tabPool) {
      const status = this.tabStatus.get(tab.id);
      if (status && status.status === 'idle') {
        // 탭이 여전히 존재하는지 확인
        try {
          await chrome.tabs.get(tab.id);
          return tab;
        } catch (error) {
          // 탭이 닫혔다면 풀에서 제거하고 새로 생성
          await this.replaceClosedTab(tab);
        }
      }
    }

    return null;
  }

  // 닫힌 탭 교체
  async replaceClosedTab(oldTab) {
    const index = this.tabPool.findIndex(t => t.id === oldTab.id);
    if (index !== -1) {
      try {
        // 현재 활성 윈도우 확인
        const windows = await chrome.windows.getAll();
        const currentWindow = windows.find(w => w.focused) || windows[0];

        const newTab = await chrome.tabs.create({
          url: 'about:blank',
          active: false,
          windowId: currentWindow.id
        });

        this.tabPool[index] = newTab;
        this.tabStatus.delete(oldTab.id);
        this.tabStatus.set(newTab.id, { status: 'idle', jobId: null });

      } catch (error) {
        this.tabPool.splice(index, 1);
      }
    }
  }

  // 탭 해제 (다시 idle 상태로)
  async releaseTab(tabId) {
    const status = this.tabStatus.get(tabId);
    if (status) {
      status.status = 'idle';
      status.jobId = null;

      // 탭을 about:blank로 되돌리기 (메모리 정리)
      try {
        await chrome.tabs.update(tabId, { url: 'about:blank' });
      } catch (error) {
      }
    }
  }

  // 탭 로드 완료 대기
  async waitForTabLoad(tabId) {
    return new Promise((resolve) => {
      const checkTab = async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') {
            // 추가로 짧게 대기 (동적 컨텐츠 로드)
            setTimeout(resolve, 200);
          } else {
            setTimeout(checkTab, 100);
          }
        } catch (error) {
          resolve();
        }
      };

      checkTab();
    });
  }

  // Service Worker 종료 시 탭 정리
  async cleanup() {
    // 탭을 닫지 않고 Storage에서만 제거 (다음에 재사용 가능)
    await chrome.storage.local.remove('tabPoolIds');
    this.tabPool = [];
    this.tabStatus.clear();
  }

  // 탭 상태 모니터링 시작
  startTabMonitoring() {
    // 10초마다 탭 상태 확인
    setInterval(() => {
      this.checkTabHealth();
    }, 10000);
  }

  // 탭 건강 상태 확인
  async checkTabHealth() {
    const tabsToRemove = [];

    for (const tab of this.tabPool) {
      try {
        // 탭이 여전히 존재하는지 확인
        await chrome.tabs.get(tab.id);
      } catch (error) {
        // 탭이 닫혔음
        tabsToRemove.push(tab);
        this.tabStatus.delete(tab.id);
      }
    }

    // 닫힌 탭들을 풀에서 제거
    for (const tab of tabsToRemove) {
      const index = this.tabPool.findIndex(t => t.id === tab.id);
      if (index !== -1) {
        this.tabPool.splice(index, 1);
      }
    }

    // 탭이 부족하면 채우기
    const missingTabs = this.tabPoolSize - this.tabPool.length;
    if (missingTabs > 0) {
      await this.replenishTabs(missingTabs);
    }
  }

  // 부족한 탭 보충
  async replenishTabs(count) {
    const windows = await chrome.windows.getAll();
    const currentWindow = windows.find(w => w.focused) || windows[0];

    for (let i = 0; i < count; i++) {
      try {
        const tab = await chrome.tabs.create({
          url: 'about:blank',
          active: false,
          windowId: currentWindow.id
        });

        this.tabPool.push(tab);
        this.tabStatus.set(tab.id, { status: 'idle', jobId: null });
      } catch (error) {
      }
    }

    // Storage 업데이트
    const newTabIds = this.tabPool.map(tab => tab.id);
    await chrome.storage.local.set({ tabPoolIds: newTabIds });
  }
}

// 에이전트 인스턴스 생성
const agent = new DistributedCrawlingAgent();

// 서비스 워커 이벤트 처리
chrome.runtime.onInstalled.addListener(() => {
});

chrome.runtime.onStartup.addListener(() => {
});

// 탭 업데이트 이벤트 (페이지 로드 완료 감지)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // 현재 진행 중인 작업이 있는지 확인
    const job = Array.from(agent.currentJobs.values()).find(j => j.tabId === tabId);
    if (job) {
    }
  }
});

// 전역 에러 핸들러
chrome.runtime.onSuspend.addListener(async () => {
  if (agent.pollTimer) {
    clearInterval(agent.pollTimer);
  }
  // 탭 풀 정리
  await agent.cleanup();
});