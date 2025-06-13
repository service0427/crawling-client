// popup.js - 크롤링 에이전트 팝업 로직

document.addEventListener('DOMContentLoaded', async () => {
    // UI 요소 참조
    const connectionStatusEl = document.getElementById('connectionStatus');
    const agentIdEl = document.getElementById('agentId');
    const aliasInput = document.getElementById('aliasInput');
    const saveButton = document.getElementById('saveButton');
    const messageEl = document.getElementById('message');
    const totalJobsEl = document.getElementById('totalJobs');
    const completedJobsEl = document.getElementById('completedJobs');
    const failedJobsEl = document.getElementById('failedJobs');
    const agentIdInput = document.getElementById('agentIdInput');
    const changeIdButton = document.getElementById('changeIdButton');

    // 현재 상태 로드
    async function loadCurrentStatus() {
        try {
            // Chrome Storage에서 데이터 로드
            const data = await chrome.storage.local.get([
                'agentId', 
                'agentAlias', 
                'connectionStatus', 
                'statistics'
            ]);

            // 연결 상태 표시
            if (data.connectionStatus === 'online') {
                connectionStatusEl.textContent = '🟢 온라인';
                connectionStatusEl.className = 'value online';
            } else {
                connectionStatusEl.textContent = '🔴 오프라인';
                connectionStatusEl.className = 'value offline';
            }

            // 에이전트 ID 표시
            if (data.agentId) {
                // 별칭이 있으면 별칭도 함께 표시
                if (data.agentAlias) {
                    agentIdEl.textContent = `${data.agentId}_${data.agentAlias}`;
                    aliasInput.value = data.agentAlias;
                } else {
                    agentIdEl.textContent = data.agentId;
                }
                // 현재 ID를 입력 필드에 표시
                agentIdInput.placeholder = data.agentId;
            } else {
                agentIdEl.textContent = '생성중...';
            }

            // 통계 표시
            if (data.statistics) {
                totalJobsEl.textContent = data.statistics.totalJobs || 0;
                completedJobsEl.textContent = data.statistics.completedJobs || 0;
                failedJobsEl.textContent = data.statistics.failedJobs || 0;
            }

        } catch (error) {
            console.error('상태 로드 실패:', error);
            messageEl.textContent = '상태를 불러올 수 없습니다.';
            messageEl.className = 'message error';
        }
    }

    // 별칭 저장 함수
    async function saveAlias() {
        const alias = aliasInput.value.trim();
        
        if (!alias) {
            showMessage('별칭을 입력해주세요.', 'error');
            return;
        }

        // 특수문자 제거 (영문, 숫자, 한글, 언더스코어, 하이픈만 허용)
        const cleanAlias = alias.replace(/[^a-zA-Z0-9가-힣_-]/g, '');
        
        if (cleanAlias !== alias) {
            showMessage('특수문자는 사용할 수 없습니다.', 'error');
            aliasInput.value = cleanAlias;
            return;
        }

        try {
            // Chrome Storage에 별칭 저장
            await chrome.storage.local.set({ agentAlias: cleanAlias });
            
            // Background script에 별칭 업데이트 알림
            const response = await chrome.runtime.sendMessage({
                type: 'UPDATE_AGENT_ALIAS',
                alias: cleanAlias
            });

            if (response && response.success) {
                showMessage('별칭이 저장되었습니다!', 'success');
                // 상태 다시 로드
                await loadCurrentStatus();
            } else {
                showMessage('저장에 실패했습니다.', 'error');
            }
        } catch (error) {
            console.error('별칭 저장 실패:', error);
            showMessage('저장 중 오류가 발생했습니다.', 'error');
        }
    }

    // 메시지 표시 함수
    function showMessage(text, type) {
        messageEl.textContent = text;
        messageEl.className = `message ${type}`;
        messageEl.style.display = 'block';
        
        // 3초 후 메시지 숨김
        setTimeout(() => {
            messageEl.style.display = 'none';
        }, 3000);
    }
    
    // Agent ID 변경 함수
    async function changeAgentId() {
        const newId = agentIdInput.value.trim();
        
        if (!newId) {
            showMessage('새로운 에이전트 ID를 입력해주세요.', 'error');
            return;
        }
        
        // ID 형식 검증 (영문, 숫자, 언더스코어, 하이픈만 허용)
        const idPattern = /^[a-zA-Z0-9_-]+$/;
        if (!idPattern.test(newId)) {
            showMessage('ID는 영문, 숫자, _, - 만 사용 가능합니다.', 'error');
            return;
        }
        
        // 확인 대화상자
        if (!confirm(`정말로 에이전트 ID를 "${newId}"로 변경하시겠습니까?\n\n주의: ID 변경 시 기존 작업 기록이 연결되지 않을 수 있습니다.`)) {
            return;
        }
        
        try {
            // 기존 별칭 가져오기
            const { agentAlias } = await chrome.storage.local.get('agentAlias');
            
            // Chrome Storage에 새 ID 저장
            await chrome.storage.local.set({ agentId: newId });
            
            // Background script에 ID 변경 알림
            const response = await chrome.runtime.sendMessage({
                type: 'CHANGE_AGENT_ID',
                newId: newId,
                alias: agentAlias || ''
            });
            
            if (response && response.success) {
                showMessage('에이전트 ID가 변경되었습니다!', 'success');
                agentIdInput.value = '';
                // 상태 다시 로드
                await loadCurrentStatus();
            } else {
                showMessage('ID 변경에 실패했습니다.', 'error');
            }
        } catch (error) {
            console.error('Agent ID 변경 실패:', error);
            showMessage('ID 변경 중 오류가 발생했습니다.', 'error');
        }
    }

    // 이벤트 리스너 설정
    saveButton.addEventListener('click', saveAlias);
    changeIdButton.addEventListener('click', changeAgentId);
    
    // Enter 키로도 저장 가능
    aliasInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveAlias();
        }
    });
    
    agentIdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            changeAgentId();
        }
    });

    // 초기 상태 로드
    await loadCurrentStatus();

    // 실시간 업데이트를 위한 스토리지 변경 감지
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            // 통계나 연결 상태가 변경되면 UI 업데이트
            if (changes.statistics || changes.connectionStatus) {
                loadCurrentStatus();
            }
        }
    });
});