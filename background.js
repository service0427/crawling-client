// 📁 extension/background.js - 분산 크롤링 에이전트 (Service Worker)

class DistributedCrawlingAgent {
  constructor() {
    this.agentId = null;
    this.serverId = null;
    this.websocket = null;
    this.isConnected = false;
    this.currentJobs = new Map();
    this.statistics = {
      completedJobs: 0,
      failedJobs: 0,
      totalJobs: 0
    };
    
    // 프로덕션 서버 URL
    this.SERVER_URL = 'wss://wapi.mkt-guide.com/ws';
    this.HTTP_SERVER = 'https://wapi.mkt-guide.com';
    
    // 개발 서버 URL (로컬 테스트용)
    // this.SERVER_URL = 'ws://localhost:8787/ws';
    // this.HTTP_SERVER = 'http://localhost:8787';
    
    this.reconnectInterval = 3000; // 3초로 단축
    this.heartbeatInterval = 30000;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 10;
    
    this.init();
  }

  async init() {
    console.log('🤖 분산 크롤링 에이전트 시작');
    console.log('🔗 서버 URL:', this.SERVER_URL);
    console.log('🔗 HTTP 서버:', this.HTTP_SERVER);
    
    // Chrome Storage에서 에이전트 ID 로드
    await this.loadAgentId();
    
    // 서버 상태 확인 후 연결 시도
    await this.checkServerAndConnect();
    
    // Chrome 메시지 리스너 설정
    this.setupMessageListeners();
  }

  async checkServerAndConnect() {
    try {
      console.log('🔍 서버 상태 확인 중...');
      
      // HTTP 서버 상태 확인
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.HTTP_SERVER + '/api/status', {
        signal: controller.signal,
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ HTTP 서버 연결 확인, 활성 에이전트:', data.agents.online);
        
        // 즉시 WebSocket 연결 시도
        this.connectToServer();
      } else {
        throw new Error(`HTTP 서버 응답 오류: ${response.status}`);
      }
    } catch (error) {
      console.error('❌ 서버 상태 확인 실패:', error.name, error.message);
      
      if (error.name === 'AbortError') {
        console.log('⏰ 서버 연결 타임아웃');
      }
      
      console.log('⏳ 3초 후 재시도...');
      setTimeout(() => {
        this.checkServerAndConnect();
      }, 3000);
    }
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

  connectToServer() {
    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      console.error('❌ 최대 연결 시도 횟수 초과');
      return;
    }
    
    this.connectionAttempts++;
    
    try {
      console.log(`🔌 서버 연결 시도 [${this.connectionAttempts}/${this.maxConnectionAttempts}]:`, this.SERVER_URL);
      
      // 기존 WebSocket 정리
      if (this.websocket) {
        this.websocket.close();
        this.websocket = null;
      }
      
      this.websocket = new WebSocket(this.SERVER_URL);
      
      this.websocket.onopen = () => {
        console.log('✅ WebSocket 연결 성공');
        this.isConnected = true;
        this.connectionAttempts = 0; // 성공 시 카운터 리셋
        this.registerAgent();
        this.updateConnectionStatus('online');
        this.startHeartbeat();
      };
      
      this.websocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleServerMessage(message);
        } catch (parseError) {
          console.error('❌ 메시지 파싱 오류:', parseError);
        }
      };
      
      this.websocket.onclose = (event) => {
        console.log('🔴 WebSocket 연결 해제:', event.code, event.reason);
        this.isConnected = false;
        this.updateConnectionStatus('offline');
        
        // 정상 종료가 아닌 경우에만 재연결
        if (event.code !== 1000) {
          setTimeout(() => {
            console.log(`🔄 재연결 시도... [${this.connectionAttempts}/${this.maxConnectionAttempts}]`);
            this.connectToServer();
          }, this.reconnectInterval);
        }
      };
      
      this.websocket.onerror = (error) => {
        console.error('❌ WebSocket 오류:', error);
        this.isConnected = false;
        this.updateConnectionStatus('error');
      };
      
      // 연결 타임아웃 설정
      setTimeout(() => {
        if (this.websocket && this.websocket.readyState === WebSocket.CONNECTING) {
          console.warn('⏰ WebSocket 연결 타임아웃');
          this.websocket.close();
        }
      }, 10000);
      
    } catch (error) {
      console.error('❌ 서버 연결 실패:', error);
      this.isConnected = false;
      this.updateConnectionStatus('offline');
      
      // 재연결 시도
      setTimeout(() => {
        this.connectToServer();
      }, this.reconnectInterval);
    }
  }

  registerAgent() {
    if (!this.isConnected) return;
    
    const registrationData = {
      type: 'AGENT_REGISTER',
      agentId: this.agentId,
      payload: {
        name: 'Chrome Extension Agent',
        capabilities: ['chrome_extension', 'naver_shopping'],
        maxConcurrentJobs: 3,
        supportedSites: ['naver.com', 'shopping.naver.com'],
        version: '2.0.0'
      },
      timestamp: Date.now()
    };
    
    this.websocket.send(JSON.stringify(registrationData));
    console.log('📝 에이전트 등록 요청 전송');
  }

  async handleServerMessage(message) {
    console.log('📩 서버 메시지 수신:', message);
    
    // 서버 응답 구조 확인
    if (message.response) {
      const response = message.response;
      switch (response.type) {
        case 'AGENT_REGISTERED':
          this.serverId = response.serverId;
          console.log('✅ 에이전트 등록 완료:', response.agentId, 'Server:', response.serverId);
          await this.updateStorageData();
          break;
          
        case 'JOB_ASSIGNED':
          await this.handleJobAssignment(response.payload);
          break;
          
        case 'JOB_CANCELLED':
          await this.handleJobCancellation(response.payload);
          break;
          
        case 'HEARTBEAT_ACK':
          // 하트비트 응답 처리
          break;
          
        default:
          console.log('❓ 알 수 없는 응답 타입:', response.type);
      }
    } else if (message.type) {
      // 직접 메시지 처리
      switch (message.type) {
        case 'JOB_ASSIGNED':
          await this.handleJobAssignment(message.payload);
          break;
          
        default:
          console.log('❓ 알 수 없는 메시지 타입:', message.type);
      }
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
    if (!this.isConnected) {
      console.warn('⚠️ 서버 연결 해제됨 - 결과 보고 불가');
      return;
    }
    
    const job = this.currentJobs.get(jobId);
    if (!job) {
      console.warn(`⚠️ 알 수 없는 작업 ID: ${jobId}`);
      return;
    }
    
    const resultMessage = {
      type: 'JOB_RESULT',
      agentId: this.agentId,
      payload: {
        jobId: jobId,
        success: success,
        result: result,
        error: error,
        processingTime: processingTime || (Date.now() - job.startTime),
        timestamp: Date.now()
      }
    };
    
    this.websocket.send(JSON.stringify(resultMessage));
    
    // 통계 업데이트
    if (success) {
      this.statistics.completedJobs++;
    } else {
      this.statistics.failedJobs++;
    }
    
    console.log(`📤 작업 결과 보고: ${jobId} - ${success ? '성공' : '실패'}`);
    await this.updateStorageData();
  }

  async handleJobCancellation(payload) {
    const { jobId, reason } = payload;
    console.log(`🚫 작업 취소: ${jobId} - ${reason}`);
    
    this.cleanupJob(jobId);
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

  startHeartbeat() {
    setInterval(() => {
      if (this.isConnected && this.websocket) {
        this.websocket.send(JSON.stringify({
          type: 'HEARTBEAT',
          agentId: this.agentId,
          timestamp: Date.now(),
          currentJobs: Array.from(this.currentJobs.keys()),
          statistics: this.statistics
        }));
      }
    }, this.heartbeatInterval);
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
      serverId: this.serverId,
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
            serverId: this.serverId,
            isConnected: this.isConnected,
            currentJobs: this.currentJobs.size,
            statistics: this.statistics
          });
          break;
          
        case 'FORCE_RECONNECT':
          console.log('🔄 강제 재연결 요청');
          if (this.websocket) {
            this.websocket.close();
          }
          setTimeout(() => this.connectToServer(), 1000);
          sendResponse({ success: true });
          break;
          
        default:
          console.log('❓ 알 수 없는 메시지 타입:', message.type);
      }
    });
  }

  // HTTP 백업 통신 (WebSocket 실패 시)
  async sendHttpBackup(data) {
    try {
      const response = await fetch(`${this.HTTP_SERVER}/api/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...data,
          agentId: this.agentId,
          backup: true
        })
      });
      
      if (response.ok) {
        console.log('📤 HTTP 백업 전송 성공');
        return true;
      }
    } catch (error) {
      console.error('❌ HTTP 백업 전송 실패:', error);
    }
    return false;
  }
}

// 에이전트 인스턴스 생성
console.log('🚀 분산 크롤링 에이전트 초기화');
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
  if (agent.websocket) {
    agent.websocket.close();
  }
});