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
    
    this.pollInterval = 3000; // 3초마다 작업 확인
    this.pollTimer = null;
    
    this.init();
  }

  async init() {
    console.log('🤖 분산 크롤링 에이전트 시작 (HTTP 모드)');
    console.log('🔗 서버:', this.HTTP_SERVER);
    
    // Chrome Storage에서 에이전트 ID 로드
    await this.loadAgentId();
    
    // 에이전트 등록
    await this.registerAgent();
    
    // Chrome 메시지 리스너 설정
    this.setupMessageListeners();
  }

  async loadAgentId() {
    const result = await chrome.storage.local.get(['agentId']);
    if (result.agentId) {
      this.agentId = result.agentId;
      console.log('📋 기존 에이전트 ID 로드:', this.agentId);
    } else {
      this.agentId = this.generateAgentId();
      await chrome.storage.local.set({ agentId: this.agentId });
      console.log('🆕 새 에이전트 ID 생성:', this.agentId);
    }
  }

  generateAgentId() {
    return `agent_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  }

  async registerAgent() {
    try {
      console.log('📝 에이전트 등록 시도...');
      
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

      console.log('📡 등록 응답 상태:', response.status, 'OK:', response.ok);
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ 에이전트 등록 성공:', data);
        this.isConnected = true;
        this.updateConnectionStatus('online');
        
        // 작업 폴링 시작
        this.startPolling();
      } else {
        const errorText = await response.text();
        console.error('❌ 등록 실패 응답:', errorText);
        throw new Error(`Registration failed: ${response.status}`);
      }
    } catch (error) {
      console.error('❌ 에이전트 등록 실패:', error);
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
        const response = await fetch(`${this.HTTP_SERVER}/api/agent/poll`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            agentId: this.agentId,
            currentJobs: Array.from(this.currentJobs.keys())
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.jobs && data.jobs.length > 0) {
            for (const job of data.jobs) {
              await this.handleJobAssignment(job);
            }
          }
          
          // 하트비트 전송
          this.sendHeartbeat();
        }
      } catch (error) {
        console.error('❌ 폴링 오류:', error);
      }
    }, this.pollInterval);
  }

  async sendHeartbeat() {
    try {
      await fetch(`${this.HTTP_SERVER}/api/agent/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          agentId: this.agentId,
          timestamp: Date.now(),
          currentJobs: Array.from(this.currentJobs.keys()),
          statistics: this.statistics
        })
      });
    } catch (error) {
      console.error('❌ 하트비트 전송 실패:', error);
    }
  }

  async handleJobAssignment(payload) {
    const { jobId, query, options } = payload;
    
    console.log(`📋 작업 할당 받음: ${jobId} - ${query}`);
    
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
      console.error(`❌ 작업 실행 실패: ${jobId}`, error);
      await this.reportJobResult(jobId, false, null, error.message);
    }
    
    await this.updateStorageData();
  }

  async executeJob(job) {
    console.log(`🔄 작업 실행 시작: ${job.id}`);
    
    try {
      // 검색 URL 생성
      const searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(job.query)}`;
      
      // 새 탭 생성
      const tab = await chrome.tabs.create({
        url: searchUrl,
        active: false
      });
      
      job.tabId = tab.id;
      job.status = 'executing';
      
      // 타임아웃 설정
      const timeoutId = setTimeout(async () => {
        console.log(`⏰ 작업 타임아웃: ${job.id}`);
        await this.reportJobResult(job.id, false, null, 'timeout');
        this.cleanupJob(job.id);
      }, job.timeout);
      
      job.timeoutId = timeoutId;
      
      // Content script 주입 대기
      setTimeout(async () => {
        try {
          // Content script에게 데이터 수집 요청
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'COLLECT_PAGE_DATA',
            jobId: job.id
          });
          
          if (response && response.success) {
            const processingTime = Date.now() - job.startTime;
            console.log(`✅ 작업 완료: ${job.id} (${processingTime}ms)`);
            
            await this.reportJobResult(job.id, true, response.data, null, processingTime);
          } else {
            throw new Error('Content script 응답 없음');
          }
          
        } catch (error) {
          console.error(`❌ Content script 통신 실패: ${job.id}`, error);
          await this.reportJobResult(job.id, false, null, error.message);
        }
        
        this.cleanupJob(job.id);
      }, 3000); // 3초 후 데이터 수집
      
    } catch (error) {
      console.error(`❌ 탭 생성 실패: ${job.id}`, error);
      await this.reportJobResult(job.id, false, null, error.message);
      this.cleanupJob(job.id);
    }
  }

  async reportJobResult(jobId, success, result, error, processingTime) {
    const job = this.currentJobs.get(jobId);
    if (!job) {
      console.warn(`⚠️ 알 수 없는 작업 ID: ${jobId}`);
      return;
    }
    
    try {
      const response = await fetch(`${this.HTTP_SERVER}/api/agent/job-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          agentId: this.agentId,
          jobId: jobId,
          success: success,
          result: result,
          error: error,
          processingTime: processingTime || (Date.now() - job.startTime),
          timestamp: Date.now()
        })
      });

      if (response.ok) {
        // 통계 업데이트
        if (success) {
          this.statistics.completedJobs++;
        } else {
          this.statistics.failedJobs++;
        }
        
        console.log(`📤 작업 결과 보고: ${jobId} - ${success ? '성공' : '실패'}`);
      }
    } catch (error) {
      console.error('❌ 작업 결과 보고 실패:', error);
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
    
    // 탭 닫기
    if (job.tabId) {
      chrome.tabs.remove(job.tabId).catch(() => {
        // 탭이 이미 닫혔을 수 있음
      });
    }
    
    this.currentJobs.delete(jobId);
    console.log(`🧹 작업 정리 완료: ${jobId}`);
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
          console.log('🔄 강제 재연결 요청');
          this.registerAgent();
          sendResponse({ success: true });
          break;
          
        default:
          console.log('❓ 알 수 없는 메시지 타입:', message.type);
      }
    });
  }
}

// 에이전트 인스턴스 생성
console.log('🚀 분산 크롤링 에이전트 초기화 (HTTP 모드)');
const agent = new DistributedCrawlingAgent();

// 서비스 워커 이벤트 처리
chrome.runtime.onInstalled.addListener(() => {
  console.log('🎯 확장 프로그램 설치/업데이트 완료');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('🔄 브라우저 시작 - 에이전트 재시작');
});

// 탭 업데이트 이벤트 (페이지 로드 완료 감지)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // 현재 진행 중인 작업이 있는지 확인
    const job = Array.from(agent.currentJobs.values()).find(j => j.tabId === tabId);
    if (job) {
      console.log(`📄 페이지 로드 완료: ${job.id} - ${tab.url}`);
    }
  }
});

// 전역 에러 핸들러
chrome.runtime.onSuspend.addListener(() => {
  console.log('😴 서비스 워커 일시중지');
  if (agent.pollTimer) {
    clearInterval(agent.pollTimer);
  }
});