// 全局变量
let currentTab = 'file';
let uploadedFiles = [];
let transferData = {};
let isOnlineMode = true;
let transferHistory = JSON.parse(localStorage.getItem('transferHistory') || '[]');
let socket = null;
let currentTransferCode = null;

// WebRTC P2P连接相关
let peerConnection = null;
let dataChannel = null;
let isInitiator = false;
let transferQueue = [];
let currentTransfer = null;
let receivedChunks = [];
let totalChunks = 0;
let receivedChunkCount = 0;
let waitingForReceiver = false;
let senderData = null;

// 传输控制相关
let activeTransfers = new Map(); // 存储活跃的传输
let transferControlPanelVisible = false;
let transferStartTime = null;
let transferPaused = false;

// API基础URL
const API_BASE = 'http://localhost:3000';

// WebRTC配置
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// 数据块大小 (16KB)
const CHUNK_SIZE = 16 * 1024;

// 初始化
document.addEventListener('DOMContentLoaded', function () {
    try {
        initializeTabs();
        initializeFileUpload();
        initializeVideoUpload();
        initializeModal();
        initializeDragAndDrop();
        initializeSocket();
        checkBrowserSupport();
    } catch (error) {
        console.error('初始化错误:', error);
    }
});

// 初始化Socket.IO连接
function initializeSocket() {
    try {
        if (typeof io === 'undefined') {
            console.error('Socket.IO库未加载');
            showMessage('Socket.IO库未加载，请刷新页面', 'error');
            return;
        }

        socket = io();

        socket.on('connect', () => {
            console.log('Socket连接成功');
        });

        socket.on('disconnect', () => {
            console.log('Socket连接断开');
            showMessage('连接断开，请刷新页面重试', 'error');
        });
    } catch (error) {
        console.error('Socket初始化失败:', error);
        showMessage('Socket初始化失败，请刷新页面', 'error');
    }

    // 接收方加入房间成功
    socket.on('receiver-joined', async (data) => {
        console.log('接收方已加入房间:', data);
        if (waitingForReceiver && senderData) {
            showMessage('接收方已连接，正在建立P2P连接...', 'info');
            await startP2PConnection();
        }
    });

    // 房间创建成功
    socket.on('room-created', (data) => {
        console.log('房间创建成功:', data);
    });

    // 加入房间成功
    socket.on('room-joined', (data) => {
        console.log('加入房间成功:', data);
        showMessage('已连接到发送方，等待建立P2P连接...', 'info');
    });

    // WebRTC信令处理
    socket.on('webrtc-offer', async (data) => {
        console.log('收到WebRTC Offer:', data);
        await handleWebRTCOffer(data);
    });

    socket.on('webrtc-answer', async (data) => {
        console.log('收到WebRTC Answer:', data);
        await handleWebRTCAnswer(data);
    });

    socket.on('webrtc-ice-candidate', async (data) => {
        console.log('收到ICE Candidate:', data);
        await handleICECandidate(data);
    });

    // 对方离开房间
    socket.on('peer-left', () => {
        console.log('对方已离开房间');
        showMessage('对方已断开连接', 'error');
        closePeerConnection();
        resetSenderState();
    });

    // 房间不存在
    socket.on('room-not-found', () => {
        showMessage('提取码无效或已过期', 'error');
        hideReceiveProgress();
        closeModal();
    });

    // 连接错误
    socket.on('connect_error', (error) => {
        console.error('Socket连接错误:', error);
        showMessage('连接服务器失败，请检查网络连接', 'error');
    });

    // 添加传输控制事件监听
    addTransferControlSocketEvents();
}

// 重置发送方状态
function resetSenderState() {
    waitingForReceiver = false;
    senderData = null;
    currentTransferCode = null;
}

// 创建WebRTC连接
async function createPeerConnection(roomId) {
    try {
        peerConnection = new RTCPeerConnection(rtcConfig);

        // ICE候选事件
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && socket && socket.connected) {
                socket.emit('webrtc-ice-candidate', {
                    roomId: roomId,
                    candidate: event.candidate
                });
            }
        };

        // 连接状态变化
        peerConnection.onconnectionstatechange = () => {
            console.log('连接状态:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                showMessage('P2P连接建立成功！', 'success');

                // 更新传输控制中心的状态
                updateTransferStatusByCode(currentTransferCode, 'connected');

                if (isInitiator && transferQueue.length > 0) {
                    setTimeout(startP2PTransfer, 500);
                }
            } else if (peerConnection.connectionState === 'disconnected') {
                showMessage('P2P连接已断开', 'error');
                updateTransferStatusByCode(currentTransferCode, 'disconnected');
            } else if (peerConnection.connectionState === 'failed') {
                showMessage('P2P连接失败，请重试', 'error');
                updateTransferStatusByCode(currentTransferCode, 'failed');
            }
        };

        // 数据通道事件（接收方）
        peerConnection.ondatachannel = (event) => {
            const channel = event.channel;
            setupDataChannel(channel);
        };

        return peerConnection;
    } catch (error) {
        console.error('创建WebRTC连接失败:', error);
        throw error;
    }
}

// 设置数据通道
function setupDataChannel(channel) {
    dataChannel = channel;

    dataChannel.onopen = () => {
        console.log('数据通道已打开');
        showMessage('数据通道已建立，开始传输...', 'success');
    };

    dataChannel.onclose = () => {
        console.log('数据通道已关闭');
    };

    dataChannel.onerror = (error) => {
        console.error('数据通道错误:', error);
        showMessage('数据传输出现错误', 'error');
    };

    dataChannel.onmessage = (event) => {
        handleDataChannelMessage(event.data);
    };
}

// 处理数据通道消息
function handleDataChannelMessage(data) {
    try {
        const message = JSON.parse(data);

        switch (message.type) {
            case 'transfer-start':
                handleTransferStart(message);
                break;
            case 'file-chunk':
                handleFileChunk(message);
                break;
            case 'transfer-complete':
                handleTransferComplete(message);
                break;
            case 'text-data':
                handleTextData(message);
                break;
        }
    } catch (error) {
        console.error('处理数据通道消息错误:', error);
    }
}

// 开始P2P连接（发送方）
async function startP2PConnection() {
    try {
        if (!socket || !socket.connected) {
            throw new Error('Socket连接未建立');
        }

        // 创建WebRTC连接
        await createPeerConnection(currentTransferCode);

        // 创建数据通道
        dataChannel = peerConnection.createDataChannel('fileTransfer', {
            ordered: true
        });
        setupDataChannel(dataChannel);

        // 创建Offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // 发送Offer
        socket.emit('webrtc-offer', {
            roomId: currentTransferCode,
            offer: offer
        });

        isInitiator = true;

        // 准备传输数据
        prepareTransferData(senderData);

    } catch (error) {
        showMessage('建立P2P连接失败: ' + error.message, 'error');
        console.error('P2P连接错误:', error);
    }
}

// 处理WebRTC Offer
async function handleWebRTCOffer(data) {
    try {
        await createPeerConnection(data.roomId);
        await peerConnection.setRemoteDescription(data.offer);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        if (socket && socket.connected) {
            socket.emit('webrtc-answer', {
                roomId: data.roomId,
                answer: answer
            });
        }

        isInitiator = false;
    } catch (error) {
        console.error('处理WebRTC Offer错误:', error);
        showMessage('建立连接失败', 'error');
    }
}

// 处理WebRTC Answer
async function handleWebRTCAnswer(data) {
    try {
        await peerConnection.setRemoteDescription(data.answer);
    } catch (error) {
        console.error('处理WebRTC Answer错误:', error);
        showMessage('建立连接失败', 'error');
    }
}

// 处理ICE Candidate
async function handleICECandidate(data) {
    try {
        if (peerConnection) {
            await peerConnection.addIceCandidate(data.candidate);
        }
    } catch (error) {
        console.error('处理ICE Candidate错误:', error);
    }
}

// 关闭P2P连接
function closePeerConnection() {
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    receivedChunks = [];
    totalChunks = 0;
    receivedChunkCount = 0;
    currentTransfer = null;
    transferQueue = [];
}

// 初始化选项卡
function initializeTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            const tabId = this.dataset.tab;

            // 移除所有活动状态
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // 添加活动状态
            this.classList.add('active');
            document.getElementById(tabId + '-tab').classList.add('active');

            currentTab = tabId;
        });
    });
}

// 初始化文件上传
function initializeFileUpload() {
    const fileInput = document.getElementById('fileInput');
    const uploadArea = document.getElementById('fileUploadArea');

    fileInput.addEventListener('change', handleFileSelect);

    uploadArea.addEventListener('click', function () {
        fileInput.click();
    });
}

// 初始化视频上传
function initializeVideoUpload() {
    const videoInput = document.getElementById('videoInput');
    const videoUploadArea = document.getElementById('videoUploadArea');

    videoInput.addEventListener('change', handleVideoSelect);

    videoUploadArea.addEventListener('click', function () {
        videoInput.click();
    });
}

// 初始化拖拽上传
function initializeDragAndDrop() {
    const uploadAreas = [
        document.getElementById('fileUploadArea'),
        document.getElementById('videoUploadArea')
    ];

    uploadAreas.forEach(area => {
        if (area) {
            area.addEventListener('dragover', handleDragOver);
            area.addEventListener('dragleave', handleDragLeave);
            area.addEventListener('drop', handleDrop);
        }
    });
}

// 处理拖拽悬停
function handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
}

// 处理拖拽离开
function handleDragLeave(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
}

// 处理文件拖放
function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');

    const files = Array.from(e.dataTransfer.files);

    if (e.currentTarget.id === 'fileUploadArea') {
        handleFiles(files);
    } else if (e.currentTarget.id === 'videoUploadArea') {
        const videoFiles = files.filter(file => file.type.startsWith('video/'));
        if (videoFiles.length > 0) {
            handleVideoFiles(videoFiles);
        }
    }
}

// 处理文件选择
function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    handleFiles(files);
}

// 处理视频选择
function handleVideoSelect(e) {
    const files = Array.from(e.target.files);
    handleVideoFiles(files);
}

// 处理文件
function handleFiles(files) {
    if (files.length > 10) {
        showMessage('单次最多只能上传10个文件', 'error');
        return;
    }

    files.forEach(file => {
        if (uploadedFiles.length < 10) {
            uploadedFiles.push({
                id: 'file_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                file: file,
                name: file.name,
                size: file.size,
                type: file.type
            });
        }
    });

    updateFileList();
}

// 处理视频文件
function handleVideoFiles(files) {
    const videoFile = files[0];
    const videoPreview = document.getElementById('videoPreview');

    if (videoFile.size > 100 * 1024 * 1024) { // 100MB限制
        showMessage('视频文件大小不能超过100MB', 'error');
        return;
    }

    const video = document.createElement('video');
    video.src = URL.createObjectURL(videoFile);
    video.controls = true;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '300px';

    videoPreview.innerHTML = '';
    videoPreview.appendChild(video);

    transferData.video = {
        file: videoFile,
        name: videoFile.name,
        size: videoFile.size
    };
}

// 更新文件列表
function updateFileList() {
    const uploadArea = document.getElementById('fileUploadArea');

    if (uploadedFiles.length === 0) {
        uploadArea.innerHTML = `
            <div class="upload-icon">
                <i class="fas fa-cloud-upload-alt"></i>
            </div>
            <p class="upload-text">点击添加文件 或 将文件（夹）拖放到这里（单次可发10个文件）</p>
            <div class="upload-actions">
                <button class="btn-outline" onclick="addMoreFiles(event)">添加文件</button>
                <button class="btn-outline" onclick="clearFiles(event)">清空</button>
            </div>
        `;
        return;
    }

    let fileListHTML = '<div class="file-list">';
    uploadedFiles.forEach(fileData => {
        const fileIcon = getFileIcon(fileData.type);
        const fileSize = formatFileSize(fileData.size);

        fileListHTML += `
            <div class="file-item">
                <div class="file-info">
                    <div class="file-icon">
                        <i class="${fileIcon}"></i>
                    </div>
                    <div class="file-details">
                        <div class="file-name">${fileData.name}</div>
                        <div class="file-size">${fileSize}</div>
                    </div>
                </div>
                <div class="file-actions">
                    <button class="btn-small btn-danger" onclick="removeFile('${fileData.id}', event)">删除</button>
                </div>
            </div>
        `;
    });
    fileListHTML += '</div>';

    fileListHTML += `
        <div class="upload-actions" style="margin-top: 20px;">
            <button class="btn-outline" onclick="addMoreFiles(event)">添加更多文件</button>
            <button class="btn-outline" onclick="clearFiles(event)">清空所有</button>
        </div>
    `;

    uploadArea.innerHTML = fileListHTML;
}

// 获取文件图标
function getFileIcon(fileType) {
    if (fileType.startsWith('image/')) return 'fas fa-image';
    if (fileType.startsWith('video/')) return 'fas fa-video';
    if (fileType.startsWith('audio/')) return 'fas fa-music';
    if (fileType.includes('pdf')) return 'fas fa-file-pdf';
    if (fileType.includes('word')) return 'fas fa-file-word';
    if (fileType.includes('excel') || fileType.includes('spreadsheet')) return 'fas fa-file-excel';
    if (fileType.includes('powerpoint') || fileType.includes('presentation')) return 'fas fa-file-powerpoint';
    if (fileType.includes('zip') || fileType.includes('rar') || fileType.includes('7z')) return 'fas fa-file-archive';
    return 'fas fa-file';
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 移除文件
function removeFile(fileId, event) {
    // 阻止事件冒泡和默认行为
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    console.log('删除文件ID:', fileId);
    uploadedFiles = uploadedFiles.filter(file => file.id !== fileId);
    updateFileList();
    showMessage('文件已删除', 'success');
}

// 添加更多文件
function addMoreFiles(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    // 尝试多种方式获取文件输入元素
    let fileInput = document.getElementById('fileInput');

    // 如果通过ID找不到，尝试通过选择器查找
    if (!fileInput) {
        fileInput = document.querySelector('input[type="file"][multiple]');
    }

    // 如果还是找不到，尝试在文件上传区域内查找
    if (!fileInput) {
        const uploadArea = document.getElementById('fileUploadArea');
        if (uploadArea) {
            fileInput = uploadArea.querySelector('input[type="file"]');
        }
    }

    // 如果仍然找不到，重新创建文件输入元素
    if (!fileInput) {
        console.warn('文件输入元素未找到，正在重新创建...');

        // 创建新的文件输入元素
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'fileInput';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', handleFileSelect);

        // 添加到文档中
        document.body.appendChild(fileInput);

        //showMessage('文件输入元素已重新创建', 'info');
    }

    // 触发文件选择
    try {
        fileInput.click();
    } catch (error) {
        console.error('触发文件选择失败:', error);
        showMessage('无法打开文件选择器，请刷新页面重试', 'error');
    }
}

// 清空文件
function clearFiles(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    uploadedFiles = [];
    updateFileList();
}

// 屏幕截图
async function captureScreen() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { mediaSource: 'screen' }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.play();

        video.addEventListener('loadedmetadata', () => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0);

            canvas.toBlob(blob => {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(blob);
                img.style.maxWidth = '100%';
                img.style.maxHeight = '400px';

                const screenPreview = document.getElementById('screenPreview');
                screenPreview.innerHTML = '';
                screenPreview.appendChild(img);

                transferData.screen = {
                    blob: blob,
                    name: `屏幕截图_${new Date().toLocaleString()}.png`,
                    size: blob.size
                };

                stream.getTracks().forEach(track => track.stop());
            }, 'image/png');
        });

    } catch (err) {
        showMessage('屏幕截图失败，请确保浏览器支持屏幕共享功能', 'error');
        console.error('屏幕截图错误:', err);
    }
}

// 窗口截图
async function captureWindow() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { mediaSource: 'window' }
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.play();

        video.addEventListener('loadedmetadata', () => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0);

            canvas.toBlob(blob => {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(blob);
                img.style.maxWidth = '100%';
                img.style.maxHeight = '400px';

                const screenPreview = document.getElementById('screenPreview');
                screenPreview.innerHTML = '';
                screenPreview.appendChild(img);

                transferData.screen = {
                    blob: blob,
                    name: `窗口截图_${new Date().toLocaleString()}.png`,
                    size: blob.size
                };

                stream.getTracks().forEach(track => track.stop());
            }, 'image/png');
        });

    } catch (err) {
        showMessage('窗口截图失败，请确保浏览器支持屏幕共享功能', 'error');
        console.error('窗口截图错误:', err);
    }
}

// 在线传输 - 生成提取码等待接收方
async function sendOnline() {
    const data = collectTransferData();
    if (!data) return;

    if (!socket || !socket.connected) {
        showMessage('Socket连接未建立，请刷新页面重试', 'error');
        return;
    }

    isOnlineMode = true;

    try {
        // 生成提取码
        const transferCode = generateTransferCode();
        currentTransferCode = transferCode;
        senderData = data;
        waitingForReceiver = true;

        // 创建房间等待接收方
        socket.emit('create-p2p-room', {
            roomId: transferCode,
            senderData: {
                type: data.type,
                fileCount: data.type === 'file' ? data.files.length : 1,
                totalSize: calculateTotalSize(data)
            }
        });

        // 显示等待界面
        showWaitingForReceiver(transferCode);

    } catch (error) {
        showMessage('创建传输失败: ' + error.message, 'error');
        console.error('在线传输错误:', error);
    }
}

// 计算总大小
function calculateTotalSize(data) {
    let totalSize = 0;
    if (data.type === 'file') {
        data.files.forEach(fileData => {
            totalSize += fileData.size;
        });
    } else if (data.type === 'screen') {
        totalSize = data.screen.size;
    } else if (data.type === 'video') {
        totalSize = data.video.size;
    } else if (data.type === 'text') {
        totalSize = new Blob([data.content]).size;
    }
    return totalSize;
}

// 显示等待接收方界面
function showWaitingForReceiver(transferCode) {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
        <div style="text-align: center;">
            <div style="font-size: 48px; color: #2196F3; margin-bottom: 20px;">
                <i class="fas fa-clock"></i>
            </div>
            <h2 id="senderTitle" style="color: #2196F3; margin-bottom: 20px;">等待接收方连接</h2>
            <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p style="font-size: 18px; margin-bottom: 10px;">请将提取码分享给接收方：</p>
                <div style="font-size: 32px; font-weight: bold; color: #2196F3; letter-spacing: 4px; margin: 15px 0;">
                    ${transferCode}
                </div>
                <button onclick="copyToClipboard('${transferCode}')" class="btn-outline">
                    <i class="fas fa-copy"></i> 复制提取码
                </button>
            </div>
            <div id="senderStatus" style="margin: 20px 0;">
                <div class="loading-spinner"></div>
                <p style="color: #666; margin-top: 10px;">等待接收方输入提取码...</p>
            </div>
            <div id="senderProgress" style="display: none; margin: 20px 0;">
                <div style="background: #f5f5f5; padding: 20px; border-radius: 8px;">
                    <div style="margin-bottom: 10px;">
                        <span id="senderFileName" style="font-weight: bold;"></span>
                        <span id="senderFileSize" style="color: #666; margin-left: 10px;"></span>
                    </div>
                    <div style="background: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0;">
                        <div id="senderProgressBar" style="background: #4CAF50; height: 100%; width: 0%; transition: width 0.3s ease;"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; color: #666;">
                        <span id="senderProgressText">0%</span>
                        <span id="senderSpeed"></span>
                    </div>
                </div>
            </div>
            <div style="margin-top: 20px;">
                <button id="senderCancelBtn" onclick="cancelWaiting()" class="btn-secondary">取消传输</button>
            </div>
        </div>
    `;
    showModal();
}

// 更新发送方进度界面
function updateSenderProgress() {
    const senderTitle = document.getElementById('senderTitle');
    const senderStatus = document.getElementById('senderStatus');
    const senderProgress = document.getElementById('senderProgress');
    const senderCancelBtn = document.getElementById('senderCancelBtn');

    if (senderTitle) {
        senderTitle.textContent = '正在传输文件';
        senderTitle.style.color = '#4CAF50';
    }

    if (senderStatus) {
        senderStatus.style.display = 'none';
    }

    if (senderProgress) {
        senderProgress.style.display = 'block';
    }

    if (senderCancelBtn) {
        senderCancelBtn.style.display = 'none';
    }
}

// 更新发送方文件进度
function updateSenderFileProgress(fileName, fileSize, percent) {
    const senderFileName = document.getElementById('senderFileName');
    const senderFileSize = document.getElementById('senderFileSize');
    const senderProgressBar = document.getElementById('senderProgressBar');
    const senderProgressText = document.getElementById('senderProgressText');

    if (senderFileName) {
        senderFileName.textContent = fileName;
    }

    if (senderFileSize) {
        senderFileSize.textContent = `(${formatFileSize(fileSize)})`;
    }

    if (senderProgressBar) {
        senderProgressBar.style.width = percent + '%';
    }

    if (senderProgressText) {
        senderProgressText.textContent = percent + '%';
    }
}

// 取消等待
function cancelWaiting() {
    if (socket && socket.connected && currentTransferCode) {
        socket.emit('cancel-transfer', { roomId: currentTransferCode });
    }
    resetSenderState();
    closeModal();
}

// 接收文件 - 输入提取码（使用类型检测API）
async function receiveFile() {
    const receiveCodeInput = document.getElementById('extractCode');
    if (!receiveCodeInput) {
        showMessage('页面元素未加载完成，请刷新页面', 'error');
        return;
    }

    const code = receiveCodeInput.value.trim().toUpperCase();

    if (!code) {
        showMessage('请输入提取码', 'error');
        return;
    }

    if (code.length !== 6) {
        showMessage('提取码格式错误', 'error');
        return;
    }

    // 显示接收进度界面
    showReceiveProgress();
    updateReceiveStatus('正在检测传输类型...');

    try {
        // 首先获取提取码类型信息
        const infoResponse = await fetch(`${API_BASE}/api/info/${code}`);
        const infoResult = await infoResponse.json();

        if (infoResult.success) {
            const transferType = infoResult.transferType;
            const transferData = infoResult.data;

            updateReceiveStatus(`检测到${transferType === 'online' ? '在线' : '离线'}传输 - ${getTypeDisplayName(transferData.type)}`);

            if (transferType === 'offline') {
                // 直接进行离线接收
                updateReceiveStatus('正在获取离线文件...');

                const response = await fetch(`${API_BASE}/api/receive/${code}`);
                const result = await response.json();

                if (result.success) {
                    updateReceiveStatus('文件信息获取成功');
                    handleOfflineReceive(result.data, code);
                } else {
                    throw new Error(result.message);
                }
            } else if (transferType === 'online') {
                // 进行在线接收
                if (!socket || !socket.connected) {
                    throw new Error('Socket连接未建立');
                }

                updateReceiveStatus('正在连接发送方...');

                // 尝试加入P2P房间
                socket.emit('join-p2p-room', {
                    roomId: code,
                    isReceiver: true
                });

                currentTransferCode = code;
                isInitiator = false;

                // 等待连接建立
                setTimeout(() => {
                    updateReceiveStatus('正在建立P2P连接...');
                }, 1000);

                // 设置超时机制
                setTimeout(() => {
                    if (currentTransferCode === code && (!peerConnection || peerConnection.connectionState !== 'connected')) {
                        hideReceiveProgress();
                        showMessage('连接超时，发送方可能已离线', 'error');
                        currentTransferCode = null;
                    }
                }, 15000); // 15秒超时
            }
        } else {
            // 提取码无效
            hideReceiveProgress();
            const errorMessage = getErrorMessage(infoResult.transferType, infoResult.message);
            showMessage(errorMessage, 'error');
        }

    } catch (error) {
        hideReceiveProgress();
        showMessage('接收失败: ' + error.message, 'error');
        console.error('接收失败:', error);
    }
}

// 处理离线接收
function handleOfflineReceive(data, code) {
    try {
        updateReceiveStatus('文件信息获取成功');

        const modalBody = document.getElementById('modalBody');
        let filesHTML = '';

        if (data.type === 'file' && data.files) {
            filesHTML = `
                <div style="text-align: center;">
                    <div style="font-size: 48px; color: #4CAF50; margin-bottom: 20px;">
                        <i class="fas fa-download"></i>
                    </div>
                    <h2 style="color: #4CAF50; margin-bottom: 20px;">文件接收成功</h2>
                    <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="font-size: 16px; margin-bottom: 15px;">共 ${data.files.length} 个文件：</p>
                        <div style="max-height: 300px; overflow-y: auto;">
            `;

            data.files.forEach(file => {
                const fileIcon = getFileIcon(file.mimetype);
                filesHTML += `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: white; margin: 5px 0; border-radius: 4px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <i class="${fileIcon}" style="color: #4A90E2;"></i>
                            <div>
                                <div style="font-weight: bold;">${file.originalName}</div>
                                <div style="font-size: 12px; color: #666;">${formatFileSize(file.size)}</div>
                            </div>
                        </div>
                        <a href="${file.downloadUrl}" download="${file.originalName}" class="btn-primary" style="text-decoration: none;">
                            <i class="fas fa-download"></i> 下载
                        </a>
                    </div>
                `;
            });

            filesHTML += `
                        </div>
                    </div>
                    <div style="margin-top: 20px;">
                        <button onclick="downloadAllFiles('${code}', '${transferId || ''}')" class="btn-primary" style="margin-right: 10px;">
                            <i class="fas fa-download"></i> 下载所有文件
                        </button>
                        <button onclick="closeModal()" class="btn-secondary">
                            <i class="fas fa-times"></i> 关闭
                        </button>
                    </div>
                </div>
            `;
        } else if (data.type === 'text') {
            filesHTML = `
                <div style="text-align: center;">
                    <div style="font-size: 48px; color: #4CAF50; margin-bottom: 20px;">
                        <i class="fas fa-font"></i>
                    </div>
                    <h2 style="color: #4CAF50; margin-bottom: 20px;">文本接收成功</h2>
                    <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <textarea readonly style="width: 100%; height: 200px; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace;">${data.textContent}</textarea>
                    </div>
                    <div style="margin-top: 20px;">
                        <button onclick="copyTextContent('${data.textContent.replace(/'/g, "\\'")}'); showMessage('文本已复制到剪贴板', 'success');" class="btn-primary" style="margin-right: 10px;">
                            <i class="fas fa-copy"></i> 复制文本
                        </button>
                        <button onclick="closeModal()" class="btn-secondary">
                            <i class="fas fa-times"></i> 关闭
                        </button>
                    </div>
                </div>
            `;
        }

        modalBody.innerHTML = filesHTML;

        // 保存到传输历史
        saveTransferToHistory({
            code: code,
            name: data.type === 'file' ? `${data.files.length} 个文件` : '文本内容',
            type: 'receiving',
            dataType: data.type,
            size: data.type === 'file' ? data.files.reduce((sum, f) => sum + f.size, 0) : data.textContent.length,
            status: 'completed',
            completed: true
        });

    } catch (error) {
        console.error('处理离线接收错误:', error);
        showMessage('处理接收数据失败', 'error');
        closeModal();
    }
}

// 下载所有文件
async function downloadAllFiles(code, transferId = null) {
    try {
        const response = await fetch(`${API_BASE}/api/receive/${code}`);
        const result = await response.json();

        if (result.success && result.data.files) {
            showMessage('开始下载所有文件...', 'info');

            // 更新传输状态为正在下载
            if (transferId) {
                updateTransferStatus(transferId, 'downloading');
            }

            // 显示下载进度界面
            showDownloadProgress(result.data.files, transferId);

            // 逐个下载文件并更新进度
            for (let i = 0; i < result.data.files.length; i++) {
                const file = result.data.files[i];

                // 更新当前文件下载状态
                updateFileDownloadStatus(i, 'downloading', file.originalName);

                try {
                    // 使用fetch下载文件以便监控进度
                    await downloadFileWithProgress(file, i);

                    // 标记文件下载完成
                    updateFileDownloadStatus(i, 'completed', file.originalName);

                } catch (error) {
                    console.error(`下载文件 ${file.originalName} 失败:`, error);
                    updateFileDownloadStatus(i, 'failed', file.originalName);
                }

                // 更新总体进度
                const overallProgress = Math.round(((i + 1) / result.data.files.length) * 100);
                if (transferId) {
                    updateTransferProgress(transferId, overallProgress);
                }

                // 更新界面中的总体进度
                const overallProgressBar = document.getElementById('overallProgressBar');
                const overallProgressText = document.getElementById('overallProgressText');
                if (overallProgressBar) {
                    overallProgressBar.style.width = overallProgress + '%';
                }
                if (overallProgressText) {
                    overallProgressText.textContent = overallProgress + '%';
                }

                // 添加延迟避免浏览器阻止多个下载
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // 所有文件下载完成
            showMessage('所有文件下载完成', 'success');

            // 更新传输状态为完成
            if (transferId) {
                updateTransferStatus(transferId, 'completed');
            }

            // 延迟关闭进度界面
            setTimeout(() => {
                closeModal();
            }, 2000);

        }
    } catch (error) {
        console.error('批量下载错误:', error);
        showMessage('批量下载失败', 'error');
        if (transferId) {
            updateTransferStatus(transferId, 'failed');
        }
    }
}

// 复制文本内容
function copyTextContent(text) {
    copyToClipboard(text);
}

// 完成离线接收
function completeOfflineReceive(transferId) {
    if (transferId) {
        updateTransferStatus(transferId, 'completed');
        showMessage('接收已完成', 'success');
    }
    closeModal();
}

// 显示下载进度界面
function showDownloadProgress(files, transferId) {
    const modalBody = document.getElementById('modalBody');

    let filesHTML = `
        <div style="text-align: center;">
            <div style="font-size: 48px; color: #2196F3; margin-bottom: 20px;">
                <i class="fas fa-download"></i>
            </div>
            <h2 style="color: #2196F3; margin-bottom: 20px;">正在下载文件</h2>
            
            <!-- 总体进度 -->
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <div style="margin-bottom: 15px;">
                    <span style="font-weight: bold;">总体进度</span>
                    <span id="overallProgressText" style="float: right;">0%</span>
                </div>
                <div style="background: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0;">
                    <div id="overallProgressBar" style="background: #4CAF50; height: 100%; width: 0%; transition: width 0.3s ease;"></div>
                </div>
            </div>
            
            <!-- 文件列表 -->
            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 20px 0; max-height: 300px; overflow-y: auto;">
                <h4 style="margin-top: 0; margin-bottom: 15px;">文件下载状态</h4>
                <div id="fileProgressList">
    `;

    // 为每个文件创建进度项
    files.forEach((file, index) => {
        const fileIcon = getFileIcon(file.mimetype);
        filesHTML += `
            <div class="file-progress-item" id="fileProgress_${index}" style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: white; margin: 5px 0; border-radius: 4px; border-left: 4px solid #ddd;">
                <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
                    <i class="${fileIcon}" style="color: #4A90E2;"></i>
                    <div style="flex: 1;">
                        <div style="font-weight: bold; font-size: 14px;">${file.originalName}</div>
                        <div style="font-size: 12px; color: #666;">${formatFileSize(file.size)}</div>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div class="file-progress-bar" style="width: 100px; background: #e0e0e0; height: 8px; border-radius: 4px; overflow: hidden;">
                        <div id="fileProgressBar_${index}" style="background: #2196F3; height: 100%; width: 0%; transition: width 0.3s ease;"></div>
                    </div>
                    <span id="fileStatus_${index}" class="file-status" style="font-size: 12px; color: #666; min-width: 60px;">等待中</span>
                </div>
            </div>
        `;
    });

    filesHTML += `
                </div>
            </div>
            
            <!-- 控制按钮 -->
            <div style="margin-top: 20px;">
                ${transferId ? `
                <button onclick="cancelDownload('${transferId}')" class="btn-secondary" style="margin-right: 10px;">
                    <i class="fas fa-times"></i> 取消下载
                </button>
                ` : ''}
                <button onclick="toggleControlPanel()" class="btn-outline">
                    <i class="fas fa-cog"></i> 传输控制
                </button>
            </div>
        </div>
    `;

    modalBody.innerHTML = filesHTML;
    showModal();
}

// 更新文件下载状态
function updateFileDownloadStatus(fileIndex, status, fileName) {
    const fileItem = document.getElementById(`fileProgress_${fileIndex}`);
    const fileStatus = document.getElementById(`fileStatus_${fileIndex}`);
    const fileProgressBar = document.getElementById(`fileProgressBar_${fileIndex}`);

    if (!fileItem || !fileStatus || !fileProgressBar) return;

    const statusConfig = {
        'waiting': { text: '等待中', color: '#666', borderColor: '#ddd', progress: 0 },
        'downloading': { text: '下载中', color: '#2196F3', borderColor: '#2196F3', progress: 50 },
        'completed': { text: '已完成', color: '#4CAF50', borderColor: '#4CAF50', progress: 100 },
        'failed': { text: '失败', color: '#f44336', borderColor: '#f44336', progress: 0 }
    };

    const config = statusConfig[status] || statusConfig['waiting'];

    // 更新状态文本和颜色
    fileStatus.textContent = config.text;
    fileStatus.style.color = config.color;

    // 更新边框颜色
    fileItem.style.borderLeftColor = config.borderColor;

    // 更新进度条
    fileProgressBar.style.width = config.progress + '%';
    fileProgressBar.style.background = config.color;

    // 添加图标
    if (status === 'completed') {
        fileStatus.innerHTML = '<i class="fas fa-check"></i> 已完成';
    } else if (status === 'failed') {
        fileStatus.innerHTML = '<i class="fas fa-times"></i> 失败';
    } else if (status === 'downloading') {
        fileStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 下载中';
    }
}

// 使用fetch下载文件并监控进度
async function downloadFileWithProgress(file, fileIndex) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await fetch(file.downloadUrl);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const contentLength = response.headers.get('content-length');
            const total = parseInt(contentLength, 10);
            let loaded = 0;

            const reader = response.body.getReader();
            const chunks = [];

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                chunks.push(value);
                loaded += value.length;

                // 更新文件进度
                if (total > 0) {
                    const progress = Math.round((loaded / total) * 100);
                    const fileProgressBar = document.getElementById(`fileProgressBar_${fileIndex}`);
                    if (fileProgressBar) {
                        fileProgressBar.style.width = progress + '%';
                    }
                }
            }

            // 创建blob并下载
            const blob = new Blob(chunks);
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = file.originalName;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);

            resolve();

        } catch (error) {
            reject(error);
        }
    });
}

// 取消下载
function cancelDownload(transferId) {
    if (confirm('确定要取消下载吗？已下载的文件将保留。')) {
        if (transferId) {
            updateTransferStatus(transferId, 'cancelled');
        }
        closeModal();
        showMessage('下载已取消', 'info');
    }
}

// 准备传输数据
function prepareTransferData(data) {
    transferQueue = [];

    if (data.type === 'file') {
        data.files.forEach(fileData => {
            transferQueue.push({
                type: 'file',
                name: fileData.name,
                size: fileData.size,
                mimeType: fileData.type,
                data: fileData.file
            });
        });
    } else if (data.type === 'text') {
        transferQueue.push({
            type: 'text',
            content: data.content
        });
    } else if (data.type === 'screen') {
        transferQueue.push({
            type: 'file',
            name: data.screen.name,
            size: data.screen.size,
            mimeType: 'image/png',
            data: data.screen.blob
        });
    } else if (data.type === 'video') {
        transferQueue.push({
            type: 'file',
            name: data.video.name,
            size: data.video.size,
            mimeType: data.video.file.type,
            data: data.video.file
        });
    }
}

// 开始P2P传输
async function startP2PTransfer() {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        showMessage('数据通道未就绪，请稍后重试', 'error');
        return;
    }

    if (transferQueue.length === 0) {
        showMessage('没有要传输的数据', 'error');
        return;
    }

    // 更新发送方界面显示正在传输
    updateSenderProgress();

    currentTransfer = transferQueue.shift();

    try {
        if (currentTransfer.type === 'text') {
            // 发送文本数据
            const message = {
                type: 'text-data',
                content: currentTransfer.content
            };
            await sendDataChannelMessage(JSON.stringify(message));
            showMessage('文本传输完成！', 'success');

            // 继续下一个传输
            if (transferQueue.length > 0) {
                setTimeout(startP2PTransfer, 100);
            } else {
                // 所有传输完成，更新状态并关闭发送方界面
                if (currentTransferCode) {
                    updateTransferStatusByCode(currentTransferCode, 'completed');
                }
                setTimeout(() => {
                    closeModal();
                    showMessage('所有文件传输完成！', 'success');
                }, 1000);
            }
        } else if (currentTransfer.type === 'file') {
            // 发送文件数据
            await sendFileViaP2P(currentTransfer);
        }
    } catch (error) {
        console.error('传输错误:', error);
        showMessage('传输失败: ' + error.message, 'error');
    }
}

// 通过P2P发送文件
async function sendFileViaP2P(fileTransfer) {
    try {
        const file = fileTransfer.data;
        const chunks = Math.ceil(file.size / CHUNK_SIZE);

        // 更新发送方界面显示当前文件信息
        updateSenderFileProgress(fileTransfer.name, fileTransfer.size, 0);

        // 发送传输开始信号
        const startMessage = {
            type: 'transfer-start',
            fileName: fileTransfer.name,
            fileSize: fileTransfer.size,
            mimeType: fileTransfer.mimeType,
            totalChunks: chunks
        };

        await sendDataChannelMessage(JSON.stringify(startMessage));

        // 分块发送文件
        for (let i = 0; i < chunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);

            const arrayBuffer = await chunk.arrayBuffer();
            const chunkMessage = {
                type: 'file-chunk',
                chunkIndex: i,
                totalChunks: chunks,
                data: Array.from(new Uint8Array(arrayBuffer))
            };

            // 使用流控制发送数据块
            await sendDataChannelMessage(JSON.stringify(chunkMessage));

            // 更新发送方进度
            const progress = Math.round(((i + 1) / chunks) * 100);
            updateSenderFileProgress(fileTransfer.name, fileTransfer.size, progress);
        }

        // 发送传输完成信号
        const completeMessage = {
            type: 'transfer-complete',
            fileName: fileTransfer.name
        };
        await sendDataChannelMessage(JSON.stringify(completeMessage));

        showMessage(`文件 ${fileTransfer.name} 传输完成！`, 'success');

        // 继续下一个传输
        if (transferQueue.length > 0) {
            setTimeout(startP2PTransfer, 100);
        } else {
            // 所有传输完成，更新状态并关闭发送方界面
            if (currentTransferCode) {
                updateTransferStatusByCode(currentTransferCode, 'completed');
            }
            setTimeout(() => {
                closeModal();
                showMessage('所有文件传输完成！', 'success');
            }, 1000);
        }

    } catch (error) {
        console.error('文件传输错误:', error);
        showMessage('文件传输失败: ' + error.message, 'error');
    }
}

// 带流控制的数据通道发送函数
async function sendDataChannelMessage(message) {
    return new Promise((resolve, reject) => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
            reject(new Error('数据通道未就绪'));
            return;
        }

        // 更小的缓冲区限制，更频繁的检查
        const maxBufferSize = 1 * 1024 * 1024; // 1MB
        let retryCount = 0;
        const maxRetries = 1000; // 最大重试次数

        function trySend() {
            try {
                // 检查重试次数
                if (retryCount >= maxRetries) {
                    reject(new Error('发送超时，缓冲区持续满载'));
                    return;
                }

                // 检查数据通道状态
                if (dataChannel.readyState !== 'open') {
                    reject(new Error('数据通道已关闭'));
                    return;
                }

                // 检查缓冲区
                if (dataChannel.bufferedAmount < maxBufferSize) {
                    dataChannel.send(message);
                    resolve();
                } else {
                    // 缓冲区满了，等待更短时间后重试
                    retryCount++;
                    setTimeout(trySend, 10);
                }
            } catch (error) {
                console.error('发送数据时出错:', error);
                reject(error);
            }
        }

        trySend();
    });
}

// 处理传输开始
function handleTransferStart(message) {
    console.log('开始接收文件:', message.fileName);
    currentTransfer = {
        fileName: message.fileName,
        fileSize: message.fileSize,
        mimeType: message.mimeType,
        totalChunks: message.totalChunks,
        startTime: Date.now()
    };

    receivedChunks = new Array(message.totalChunks);
    totalChunks = message.totalChunks;
    receivedChunkCount = 0;

    updateReceiveStatus(`正在接收文件: ${message.fileName}`);
    updateReceiveProgress(message.fileName, message.fileSize, 0);
}

// 处理文件块
function handleFileChunk(message) {
    if (!currentTransfer) return;

    receivedChunks[message.chunkIndex] = new Uint8Array(message.data);
    receivedChunkCount++;

    // 计算进度
    const progress = Math.round((receivedChunkCount / totalChunks) * 100);

    // 计算传输速度
    const elapsed = (Date.now() - currentTransfer.startTime) / 1000;
    const bytesReceived = receivedChunkCount * CHUNK_SIZE;
    const speed = elapsed > 0 ? formatSpeed(bytesReceived / elapsed) : '';

    // 更新接收进度
    updateReceiveProgress(
        currentTransfer.fileName,
        currentTransfer.fileSize,
        progress,
        speed
    );
}

// 处理传输完成
function handleTransferComplete(message) {
    if (!currentTransfer) return;

    try {
        // 合并所有块
        const totalSize = receivedChunks.reduce((size, chunk) => size + chunk.length, 0);
        const mergedArray = new Uint8Array(totalSize);
        let offset = 0;

        for (const chunk of receivedChunks) {
            mergedArray.set(chunk, offset);
            offset += chunk.length;
        }

        // 创建Blob并下载
        const blob = new Blob([mergedArray], { type: currentTransfer.mimeType });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = currentTransfer.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        URL.revokeObjectURL(url);

        // 显示完成状态
        updateReceiveProgress(currentTransfer.fileName, currentTransfer.fileSize, 100);
        updateReceiveStatus(`文件 ${currentTransfer.fileName} 接收完成！`);

        // 延迟关闭进度界面
        setTimeout(() => {
            hideReceiveProgress();
            if (currentTransfer && currentTransfer.fileName) {
                showMessage(`文件 ${currentTransfer.fileName} 接收完成！`, 'success');
            } else {
                // 更新传输控制中心的状态为完成
                if (currentTransferCode) {
                    updateTransferStatusByCode(currentTransferCode, 'completed');
                }
                showMessage('文件接收完成！', 'success');
            }
        }, 2000);

        // 重置状态
        currentTransfer = null;
        receivedChunks = [];
        totalChunks = 0;
        receivedChunkCount = 0;

    } catch (error) {
        console.error('文件合并错误:', error);
        hideReceiveProgress();
        showMessage('文件接收失败', 'error');

        // 更新传输状态为失败
        if (currentTransferCode) {
            updateTransferStatusByCode(currentTransferCode, 'failed');
        }
    }
}

// 格式化传输速度
function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) {
        return bytesPerSecond.toFixed(0) + ' B/s';
    } else if (bytesPerSecond < 1024 * 1024) {
        return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
    } else {
        return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
    }
}

// 处理文本数据
function handleTextData(message) {
    // 先更新接收状态
    updateReceiveStatus('文本接收完成！');

    // 更新传输控制中心的状态为完成
    if (currentTransferCode) {
        updateTransferStatusByCode(currentTransferCode, 'completed');
    }

    // 延迟显示文本内容
    setTimeout(() => {
        const modalBody = document.getElementById('modalBody');
        modalBody.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 48px; color: #4CAF50; margin-bottom: 20px;">
                    <i class="fas fa-file-text"></i>
                </div>
                <h2 style="color: #4CAF50; margin-bottom: 20px;">文本接收成功！</h2>
                <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0; max-height: 300px; overflow-y: auto; text-align: left;">
                    <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0;">${message.content}</pre>
                </div>
                <div style="margin: 20px 0;">
                    <button onclick="copyToClipboard('${message.content.replace(/'/g, "\\'")}'); showMessage('文本已复制到剪贴板', 'success');" class="btn-outline">
                        <i class="fas fa-copy"></i> 复制文本
                    </button>
                </div>
                <div style="margin-top: 20px;">
                    <button onclick="closeModal()" class="btn-secondary">关闭</button>
                </div>
            </div>
        `;
        showMessage('文本接收完成！', 'success');
    }, 1000);
}

// 离线传输
async function sendOffline() {
    const data = collectTransferData();
    if (!data) return;

    isOnlineMode = false;
    showProgress();

    try {
        const formData = new FormData();
        formData.append('type', data.type);
        formData.append('isOnline', 'false');

        if (data.type === 'file') {
            data.files.forEach(fileData => {
                formData.append('files', fileData.file);
            });
        } else if (data.type === 'text') {
            formData.append('textContent', data.content);
        } else if (data.type === 'screen') {
            formData.append('files', data.screen.blob, data.screen.name);
        } else if (data.type === 'video') {
            formData.append('files', data.video.file);
        }

        const response = await fetch(`${API_BASE}/api/upload`, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            hideProgress();
            showTransferSuccess(result.code, false);
            saveTransferHistory(data, result.code, false);
        } else {
            throw new Error(result.message);
        }

    } catch (error) {
        hideProgress();
        showMessage('离线传输失败: ' + error.message, 'error');
    }
}

// 收集传输数据
function collectTransferData() {
    let data = {};

    switch (currentTab) {
        case 'file':
            if (uploadedFiles.length === 0) {
                showMessage('请先选择要传输的文件', 'error');
                return null;
            }
            data.type = 'file';
            data.files = uploadedFiles;
            break;

        case 'text':
            const textContent = document.getElementById('textContent').value.trim();
            if (!textContent) {
                showMessage('请输入要传输的文本内容', 'error');
                return null;
            }
            data.type = 'text';
            data.content = textContent;
            break;

        case 'screen':
            if (!transferData.screen) {
                showMessage('请先截取屏幕', 'error');
                return null;
            }
            data.type = 'screen';
            data.screen = transferData.screen;
            break;

        case 'video':
            if (!transferData.video) {
                showMessage('请先选择视频文件', 'error');
                return null;
            }
            data.type = 'video';
            data.video = transferData.video;
            break;

        default:
            showMessage('请选择传输类型', 'error');
            return null;
    }

    return data;
}

// 生成传输码
function generateTransferCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 显示传输成功
function showTransferSuccess(code, isOnline) {
    const modalBody = document.getElementById('modalBody');
    const modeText = isOnline ? '在线传输' : '离线传输';
    const instructionText = isOnline ?
        '请将提取码分享给接收方，接收方输入提取码后即可开始传输' :
        '请将提取码分享给接收方，接收方可随时使用提取码接收文件';

    modalBody.innerHTML = `
        <div style="text-align: center;">
            <div style="font-size: 48px; color: #4CAF50; margin-bottom: 20px;">
                <i class="fas fa-check-circle"></i>
            </div>
            <h2 style="color: #4CAF50; margin-bottom: 20px;">${modeText}创建成功！</h2>
            <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p style="font-size: 16px; margin-bottom: 15px;">${instructionText}</p>
                <div style="font-size: 32px; font-weight: bold; color: #2196F3; letter-spacing: 4px; margin: 15px 0;">
                    ${code}
                </div>
                <button onclick="copyToClipboard('${code}')" class="btn-outline">
                    <i class="fas fa-copy"></i> 复制提取码
                </button>
            </div>
            <div style="margin-top: 20px;">
                <button onclick="closeModal()" class="btn-secondary">关闭</button>
            </div>
        </div>
    `;
    showModal();
}

// 保存传输历史
function saveTransferHistory(data, code, isOnline) {
    const historyItem = {
        id: Date.now(),
        code: code,
        type: data.type,
        isOnline: isOnline,
        timestamp: new Date().toLocaleString(),
        fileCount: data.type === 'file' ? data.files.length : 1
    };

    transferHistory.unshift(historyItem);
    if (transferHistory.length > 10) {
        transferHistory = transferHistory.slice(0, 10);
    }

    localStorage.setItem('transferHistory', JSON.stringify(transferHistory));
}

// 显示进度
function showProgress() {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
        <div style="text-align: center;">
            <div style="font-size: 48px; color: #4A90E2; margin-bottom: 20px;">
                <i class="fas fa-cloud-upload-alt"></i>
            </div>
            <h2 style="color: #4A90E2; margin-bottom: 20px;">正在上传文件</h2>
            <div style="margin: 20px 0;">
                <div class="loading-spinner"></div>
                <p style="color: #666; margin-top: 10px;">请稍候，正在处理您的文件...</p>
            </div>
        </div>
    `;
    showModal();
}

// 隐藏进度
function hideProgress() {
    closeModal();
}

// 更新进度
function updateProgress(percent) {
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    if (progressBar) {
        progressBar.style.width = percent + '%';
    }
    if (progressText) {
        progressText.textContent = percent + '%';
    }
}

// 显示接收进度界面
function showReceiveProgress() {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
        <div style="text-align: center;">
            <div style="font-size: 48px; color: #2196F3; margin-bottom: 20px;">
                <i class="fas fa-download"></i>
            </div>
            <h2 style="color: #2196F3; margin-bottom: 20px;">正在接收文件</h2>
            <div id="receiveStatus" style="margin: 20px 0; color: #666;">
                正在连接发送方...
            </div>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <div id="receiveProgressContainer" style="display: none;">
                    <div style="margin-bottom: 10px;">
                        <span id="receiveFileName" style="font-weight: bold;"></span>
                        <span id="receiveFileSize" style="color: #666; margin-left: 10px;"></span>
                    </div>
                    <div style="background: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0;">
                        <div id="receiveProgressBar" style="background: #4CAF50; height: 100%; width: 0%; transition: width 0.3s ease;"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; color: #666;">
                        <span id="receiveProgressText">0%</span>
                        <span id="receiveSpeed"></span>
                    </div>
                </div>
                <div id="receiveWaiting" class="loading-spinner" style="margin: 20px 0;"></div>
            </div>
            <div style="margin-top: 20px;">
                <button onclick="cancelReceive()" class="btn-secondary" style="margin-right: 10px;">
                    <i class="fas fa-times"></i> 停止接收
                </button>
                <button onclick="toggleControlPanel()" class="btn-outline">
                    <i class="fas fa-cog"></i> 传输控制
                </button>
            </div>
        </div>
    `;
    showModal();
}

// 隐藏接收进度界面
function hideReceiveProgress() {
    closeModal();
}

// 更新接收状态
function updateReceiveStatus(status) {
    const statusElement = document.getElementById('receiveStatus');
    if (statusElement) {
        statusElement.textContent = status;
    }
}

// 更新接收进度
function updateReceiveProgress(fileName, fileSize, percent, speed) {
    const progressContainer = document.getElementById('receiveProgressContainer');
    const waitingElement = document.getElementById('receiveWaiting');
    const fileNameElement = document.getElementById('receiveFileName');
    const fileSizeElement = document.getElementById('receiveFileSize');
    const progressBar = document.getElementById('receiveProgressBar');
    const progressText = document.getElementById('receiveProgressText');
    const speedElement = document.getElementById('receiveSpeed');

    if (progressContainer && waitingElement) {
        progressContainer.style.display = 'block';
        waitingElement.style.display = 'none';
    }

    if (fileNameElement) {
        fileNameElement.textContent = fileName;
    }

    if (fileSizeElement) {
        fileSizeElement.textContent = `(${formatFileSize(fileSize)})`;
    }

    if (progressBar) {
        progressBar.style.width = percent + '%';
    }

    if (progressText) {
        progressText.textContent = percent + '%';
    }

    if (speedElement && speed) {
        speedElement.textContent = speed;
    }
}

// 取消接收
function cancelReceive() {
    if (socket && socket.connected && currentTransferCode) {
        // 使用新的停止传输事件
        socket.emit('stop-transfer', {
            roomId: currentTransferCode,
            reason: 'receiver_cancelled',
            transferType: 'receiving'
        });
    }

    // 关闭连接和清理状态
    closePeerConnection();
    currentTransferCode = null;

    // 清理接收相关的全局变量
    receivedChunks = [];
    totalChunks = 0;
    receivedChunkCount = 0;
    currentTransfer = null;

    // 更新传输控制中心中的状态
    for (const [transferId, transfer] of activeTransfers.entries()) {
        if (transfer.code === currentTransferCode && transfer.type === 'receiving') {
            updateTransferStatus(transferId, 'cancelled');
            break;
        }
    }

    hideReceiveProgress();
    showMessage('接收已停止', 'info');
}

// 显示消息
function showMessage(message, type = 'info') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    messageDiv.textContent = message;

    document.body.appendChild(messageDiv);

    setTimeout(() => {
        messageDiv.classList.add('show');
    }, 100);

    setTimeout(() => {
        messageDiv.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(messageDiv);
        }, 300);
    }, 3000);
}

// 初始化模态框
function initializeModal() {
    const modal = document.getElementById('modal');
    const closeBtn = document.querySelector('.close');

    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    if (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === modal) {
                closeModal();
            }
        });
    }
}

// 显示模态框
function showModal() {
    const modal = document.getElementById('modal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

// 关闭模态框
function closeModal() {
    const modal = document.getElementById('modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// 复制到剪贴板
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showMessage('提取码已复制到剪贴板', 'success');
    }).catch(() => {
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showMessage('提取码已复制到剪贴板', 'success');
    });
}

// 显示在线/离线区别说明
function showRegion() {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
        <div style="max-width: 700px; margin: 0 auto; padding: 20px;">
            <!-- 标题区域 -->
            <div style="text-align: center; margin-bottom: 40px;">
                <div style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                           width: 80px; height: 80px; border-radius: 50%; display: flex; align-items: center; 
                           justify-content: center; margin-bottom: 20px; box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);">
                    <i class="fas fa-exchange-alt" style="font-size: 32px; color: white;"></i>
                </div>
                <h2 style="color: #2c3e50; margin: 0; font-size: 28px; font-weight: 600;">
                    传输方式对比
                </h2>
                <p style="color: #7f8c8d; margin: 10px 0 0 0; font-size: 16px;">选择最适合您需求的传输方式</p>
            </div>
            
            <!-- 对比卡片容器 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 25px; margin-bottom: 30px;">
                
                <!-- 在线传输卡片 -->
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                           border-radius: 16px; padding: 25px; color: white; position: relative; 
                           box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3); overflow: hidden;">
                    <div style="position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; 
                               background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
                    <div style="position: relative; z-index: 2;">
                        <div style="display: flex; align-items: center; margin-bottom: 20px;">
                            <div style="background: rgba(255,255,255,0.2); width: 50px; height: 50px; 
                                       border-radius: 12px; display: flex; align-items: center; justify-content: center; margin-right: 15px;">
                                <i class="fas fa-wifi" style="font-size: 20px;"></i>
                            </div>
                            <div>
                                <h3 style="margin: 0; font-size: 20px; font-weight: 600;">在线传输</h3>
                                <span style="background: rgba(76, 175, 80, 0.9); padding: 4px 12px; 
                                           border-radius: 20px; font-size: 12px; font-weight: 500;">免费</span>
                            </div>
                        </div>
                        <div style="space-y: 12px;">
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-bolt" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">实时P2P直连传输</span>
                            </div>
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-infinity" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">无文件大小限制</span>
                            </div>
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-shield-alt" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">端到端加密安全</span>
                            </div>
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-rocket" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">传输速度超快</span>
                            </div>
                            <div style="display: flex; align-items: center;">
                                <i class="fas fa-users" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">需双方同时在线</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 离线传输卡片 -->
                <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); 
                           border-radius: 16px; padding: 25px; color: white; position: relative; 
                           box-shadow: 0 10px 30px rgba(245, 87, 108, 0.3); overflow: hidden;">
                    <div style="position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; 
                               background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
                    <div style="position: relative; z-index: 2;">
                        <div style="display: flex; align-items: center; margin-bottom: 20px;">
                            <div style="background: rgba(255,255,255,0.2); width: 50px; height: 50px; 
                                       border-radius: 12px; display: flex; align-items: center; justify-content: center; margin-right: 15px;">
                                <i class="fas fa-cloud" style="font-size: 20px;"></i>
                            </div>
                            <div>
                                <h3 style="margin: 0; font-size: 20px; font-weight: 600;">离线传输</h3>
                                <span style="background: rgba(255, 193, 7, 0.9); padding: 4px 12px; 
                                           border-radius: 20px; font-size: 12px; font-weight: 500; color: #333;">VIP</span>
                            </div>
                        </div>
                        <div style="space-y: 12px;">
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-clock" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">异步传输随时接收</span>
                            </div>
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-database" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">云端存储24小时</span>
                            </div>
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-weight-hanging" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">最大支持10GB文件</span>
                            </div>
                            <div style="display: flex; align-items: center; margin-bottom: 12px;">
                                <i class="fas fa-share-alt" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">支持多人下载</span>
                            </div>
                            <div style="display: flex; align-items: center;">
                                <i class="fas fa-globe" style="width: 20px; margin-right: 10px; color: #ffd700;"></i>
                                <span style="font-size: 14px;">跨时区文件分享</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 关闭按钮 -->
            <div style="text-align: center;">
                <button onclick="closeModal()" 
                        style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                               color: white; border: none; padding: 15px 40px; border-radius: 25px; 
                               font-size: 16px; font-weight: 600; cursor: pointer; 
                               box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3); 
                               transition: all 0.3s ease; min-width: 120px;"
                        onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 12px 35px rgba(102, 126, 234, 0.4)'"
                        onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 8px 25px rgba(102, 126, 234, 0.3)'">
                    <i class="fas fa-check" style="margin-right: 8px;"></i>我知道了
                </button>
            </div>
        </div>
    `;
    showModal();
}

// 检查浏览器支持
function checkBrowserSupport() {
    if (!window.RTCPeerConnection) {
        showMessage('您的浏览器不支持WebRTC，无法使用在线传输功能', 'error');
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        console.warn('浏览器不支持屏幕截图功能');
    }
}

// ==================== 传输控制功能 ====================

// 切换传输控制面板显示/隐藏
function toggleControlPanel() {
    const panel = document.getElementById('transferControlPanel');
    if (!panel) return;

    transferControlPanelVisible = !transferControlPanelVisible;

    if (transferControlPanelVisible) {
        panel.style.display = 'block';
        updateActiveTransfersList();
        // 添加动画效果
        setTimeout(() => {
            panel.classList.add('fade-in');
        }, 10);
    } else {
        panel.style.display = 'none';
        panel.classList.remove('fade-in');
    }
}

// 更新活跃传输列表
function updateActiveTransfersList() {
    const container = document.getElementById('activeTransfers');
    if (!container) return;

    if (activeTransfers.size === 0) {
        container.innerHTML = `
            <div class="empty-transfers">
                <i class="fas fa-inbox"></i>
                <p>暂无活跃传输</p>
                <small>开始传输后，这里将显示传输状态</small>
            </div>
        `;
        return;
    }

    let html = '';
    for (const [transferId, transfer] of activeTransfers.entries()) {
        const statusClass = getTransferStatusClass(transfer.status);
        const statusText = getTransferStatusText(transfer.status);
        const progressPercent = transfer.progress || 0;

        html += `
            <div class="transfer-item ${transfer.type}">
                <div class="transfer-info">
                    <div class="transfer-title">
                        <i class="${getTransferIcon(transfer.dataType)}"></i>
                        ${transfer.name}
                        <span class="transfer-status ${statusClass}">
                            <i class="fas fa-circle"></i>
                            ${statusText}
                        </span>
                    </div>
                    <div class="transfer-details">
                        <span><i class="fas fa-code"></i> ${transfer.code}</span>
                        <span><i class="fas fa-hdd"></i> ${formatFileSize(transfer.size)}</span>
                        <span><i class="fas fa-clock"></i> ${getTransferDuration(transfer.startTime)}</span>
                        ${transfer.speed ? `<span><i class="fas fa-tachometer-alt"></i> ${transfer.speed}</span>` : ''}
                    </div>
                    ${transfer.status === 'sending' || transfer.status === 'receiving' ? `
                        <div class="transfer-progress">
                            <div class="progress-bar-mini">
                                <div class="progress-fill-mini" style="width: ${progressPercent}%"></div>
                            </div>
                            <div class="progress-text-mini">${progressPercent}%</div>
                        </div>
                    ` : ''}
                </div>
                <div class="transfer-actions">
                    ${getTransferActionButtons(transferId, transfer)}
                </div>
            </div>
        `;
    }

    container.innerHTML = html;
}

// 获取传输状态样式类
function getTransferStatusClass(status) {
    const statusMap = {
        'waiting': 'status-waiting',
        'connecting': 'status-waiting',
        'connected': 'status-sending',
        'sending': 'status-sending',
        'receiving': 'status-receiving',
        'downloading': 'status-receiving',
        'ready': 'status-completed',
        'completed': 'status-completed',
        'failed': 'status-failed',
        'cancelled': 'status-failed',
        'disconnected': 'status-failed'
    };
    return statusMap[status] || 'status-waiting';
}

// 获取传输状态文本
function getTransferStatusText(status) {
    const statusMap = {
        'waiting': '等待连接',
        'connecting': '正在连接',
        'connected': '已连接',
        'sending': '正在发送',
        'receiving': '正在接收',
        'downloading': '正在下载',
        'ready': '准备就绪',
        'completed': '传输完成',
        'failed': '传输失败',
        'cancelled': '已取消',
        'disconnected': '连接断开'
    };
    return statusMap[status] || '未知状态';
}

// 获取传输图标
function getTransferIcon(dataType) {
    const iconMap = {
        'file': 'fas fa-file',
        'text': 'fas fa-font',
        'screen': 'fas fa-desktop',
        'video': 'fas fa-video'
    };
    return iconMap[dataType] || 'fas fa-exchange-alt';
}

// 获取传输持续时间
function getTransferDuration(startTime) {
    if (!startTime) return '00:00';

    const duration = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// 获取传输操作按钮
function getTransferActionButtons(transferId, transfer) {
    let buttons = '';

    // 检查传输状态是否允许显示操作按钮
    if (transfer.type === 'waiting' || transfer.type === 'sending' || transfer.type === 'receiving' ||
        transfer.type === 'downloading' || transfer.type === 'ready' || transfer.type === 'connecting') {

        // 根据传输类型显示不同的停止按钮文本和图标
        const isReceiving = transfer.type === 'receiving';
        const stopText = isReceiving ? '停止接收' : '停止发送';
        const stopIcon = isReceiving ? 'fa-times-circle' : 'fa-stop-circle';
        const stopClass = isReceiving ? 'btn-stop-receive' : 'btn-stop-send';

        buttons += `
            <button class="btn-transfer-action btn-stop ${stopClass}" onclick="stopTransfer('${transferId}')">
                <i class="fas ${stopIcon}"></i> ${stopText}
            </button>
        `;

        // 只有在发送或接收状态下才显示暂停/恢复按钮
        if (transfer.type === 'sending' || transfer.type === 'receiving') {
            if (transferPaused) {
                buttons += `
                    <button class="btn-transfer-action btn-resume" onclick="resumeTransfer('${transferId}')">
                        <i class="fas fa-play"></i> 继续
                    </button>
                `;
            } else {
                buttons += `
                    <button class="btn-transfer-action btn-pause" onclick="pauseTransfer('${transferId}')">
                        <i class="fas fa-pause"></i> 暂停
                    </button>
                `;
            }
        }
    }

    return buttons;
}

// 添加传输到活跃列表
function addActiveTransfer(transferId, transferInfo) {
    activeTransfers.set(transferId, {
        ...transferInfo,
        startTime: Date.now(),
        progress: 0
    });

    if (transferControlPanelVisible) {
        updateActiveTransfersList();
    }

    // 保存到历史记录
    saveTransferToHistory(transferInfo);
}

// 更新传输进度
function updateTransferProgress(transferId, progress, speed = null) {
    const transfer = activeTransfers.get(transferId);
    if (transfer) {
        transfer.progress = Math.round(progress);
        if (speed) {
            transfer.speed = speed;
        }

        if (transferControlPanelVisible) {
            updateActiveTransfersList();
        }
    }
}

// 更新传输状态
function updateTransferStatus(transferId, status) {
    const transfer = activeTransfers.get(transferId);
    if (transfer) {
        transfer.status = status;

        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            // 延迟移除已完成的传输
            setTimeout(() => {
                activeTransfers.delete(transferId);
                if (transferControlPanelVisible) {
                    updateActiveTransfersList();
                }
            }, 3000);
        }

        if (transferControlPanelVisible) {
            updateActiveTransfersList();
        }
    }
}

// 根据提取码更新传输状态
function updateTransferStatusByCode(code, status) {
    if (!code) return;

    // 查找对应的传输
    for (const [transferId, transfer] of activeTransfers.entries()) {
        if (transfer.code === code) {
            updateTransferStatus(transferId, status);
            break;
        }
    }
}

// 停止指定传输
function stopTransfer(transferId) {
    const transfer = activeTransfers.get(transferId);
    if (!transfer) return;

    const isReceiving = transfer.type === 'receiving';
    const confirmMessage = isReceiving ?
        '确定要停止接收这个传输吗？这将中断文件下载。' :
        '确定要停止发送这个传输吗？';

    if (confirm(confirmMessage)) {
        // 发送停止信号
        if (socket && socket.connected && transfer.code) {
            socket.emit('stop-transfer', {
                roomId: transfer.code,
                reason: isReceiving ? 'receiver_cancelled' : 'sender_cancelled',
                transferType: transfer.type
            });
        }

        // 如果是当前传输，关闭连接和界面
        if (transfer.code === currentTransferCode) {
            if (isReceiving) {
                // 接收方停止：关闭接收界面和连接
                hideReceiveProgress();
                closeModal();
                closePeerConnection();
                currentTransferCode = null;

                // 清理接收相关的全局变量
                receivedChunks = [];
                totalChunks = 0;
                receivedChunkCount = 0;
                currentTransfer = null;
            } else {
                // 发送方停止：关闭发送界面和连接
                closePeerConnection();
                resetSenderState();
                closeModal();
            }
        }

        updateTransferStatus(transferId, 'cancelled');

        const successMessage = isReceiving ?
            '接收已停止，文件下载已中断' :
            '发送已停止，传输已取消';
        showMessage(successMessage, 'info');
    }
}

// 暂停传输
function pauseTransfer(transferId) {
    const transfer = activeTransfers.get(transferId);
    if (!transfer) return;

    transferPaused = true;

    // 发送暂停信号
    if (socket && socket.connected && transfer.code) {
        socket.emit('pause-transfer', { roomId: transfer.code });
    }

    showMessage('传输已暂停', 'info');
    updateActiveTransfersList();
}

// 恢复传输
function resumeTransfer(transferId) {
    const transfer = activeTransfers.get(transferId);
    if (!transfer) return;

    transferPaused = false;

    // 发送恢复信号
    if (socket && socket.connected && transfer.code) {
        socket.emit('resume-transfer', { roomId: transfer.code });
    }

    showMessage('传输已恢复', 'info');
    updateActiveTransfersList();
}

// 断开所有传输
function disconnectAllTransfers() {
    if (activeTransfers.size === 0) {
        showMessage('当前没有活跃的传输', 'info');
        return;
    }

    if (confirm(`确定要断开所有 ${activeTransfers.size} 个传输吗？`)) {
        // 发送断开所有传输的信号
        for (const [transferId, transfer] of activeTransfers.entries()) {
            if (socket && socket.connected && transfer.code) {
                socket.emit('stop-transfer', {
                    roomId: transfer.code,
                    reason: 'disconnect_all'
                });
            }
        }

        // 关闭当前连接
        closePeerConnection();
        resetSenderState();
        closeModal();

        // 清空活跃传输列表
        activeTransfers.clear();
        updateActiveTransfersList();

        showMessage('所有传输已断开', 'success');
    }
}

// 保存传输到历史记录
function saveTransferToHistory(transferInfo) {
    const historyItem = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        ...transferInfo,
        timestamp: new Date().toISOString(),
        completed: false
    };

    transferHistory.unshift(historyItem);

    // 限制历史记录数量
    if (transferHistory.length > 50) {
        transferHistory = transferHistory.slice(0, 50);
    }

    localStorage.setItem('transferHistory', JSON.stringify(transferHistory));
}

// 显示传输历史
function showTransferHistory() {
    const modalBody = document.getElementById('modalBody');

    let historyHTML = `
        <div class="history-modal">
            <div class="history-header-fixed">
                <h2 style="margin: 0 0 20px 0; color: #333; display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-history"></i>
                    传输历史
                    <span style="font-size: 14px; font-weight: normal; color: #666; margin-left: auto;">
                        共 ${transferHistory.length} 条记录
                    </span>
                </h2>
            </div>
            <div class="history-list-container">
    `;

    if (transferHistory.length === 0) {
        historyHTML += `
                <div class="empty-transfers">
                    <i class="fas fa-history"></i>
                    <p>暂无传输历史</p>
                    <small>完成传输后，历史记录将显示在这里</small>
                </div>
        `;
    } else {
        transferHistory.forEach(item => {
            const date = new Date(item.timestamp);
            const timeStr = date.toLocaleString('zh-CN');

            historyHTML += `
                <div class="history-item ${item.completed ? '' : 'failed'}">
                    <div class="history-header">
                        <div class="history-title">
                            <i class="${getTransferIcon(item.dataType)}"></i>
                            ${item.name}
                        </div>
                        <div class="history-time">${timeStr}</div>
                    </div>
                    <div class="history-details">
                        <span><i class="fas fa-code"></i> ${item.code}</span>
                        <span><i class="fas fa-hdd"></i> ${formatFileSize(item.size)}</span>
                        <span><i class="fas fa-exchange-alt"></i> ${item.type === 'sending' ? '发送' : '接收'}</span>
                        <span><i class="fas fa-${item.completed ? 'check-circle' : 'times-circle'}"></i> ${item.completed ? '成功' : '失败'}</span>
                    </div>
                </div>
            `;
        });
    }

    historyHTML += `
            </div>
            <div class="history-footer-fixed">
                <div style="text-align: center; padding-top: 15px; border-top: 1px solid #e0e0e0;">
                    <button onclick="clearTransferHistory()" class="btn-outline" style="margin-right: 10px;">
                        <i class="fas fa-trash"></i> 清空历史
                    </button>
                    <button onclick="closeModal()" class="btn-primary">
                        <i class="fas fa-times"></i> 关闭
                    </button>
                </div>
            </div>
        </div>
    `;

    modalBody.innerHTML = historyHTML;
    showModal();
}

// 清空传输历史
function clearTransferHistory() {
    if (confirm('确定要清空所有传输历史吗？')) {
        transferHistory = [];
        localStorage.setItem('transferHistory', JSON.stringify(transferHistory));
        showTransferHistory(); // 刷新显示
        showMessage('传输历史已清空', 'success');
    }
}

// 格式化传输速度
function formatTransferSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) {
        return bytesPerSecond.toFixed(0) + ' B/s';
    } else if (bytesPerSecond < 1024 * 1024) {
        return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
    } else if (bytesPerSecond < 1024 * 1024 * 1024) {
        return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
    } else {
        return (bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1) + ' GB/s';
    }
}

// ==================== 增强的传输功能 ====================

// 增强的发送在线功能 - 重写sendOnline函数
async function sendOnlineEnhanced() {
    const data = collectTransferData();
    if (!data) return;

    if (!socket || !socket.connected) {
        showMessage('Socket连接未建立，请刷新页面重试', 'error');
        return;
    }

    isOnlineMode = true;

    try {
        // 生成传输码
        const transferCode = generateTransferCode();
        const transferId = 'transfer_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        currentTransferCode = transferCode;
        senderData = data;
        waitingForReceiver = true;

        // 添加到活跃传输列表
        addActiveTransfer(transferId, {
            id: transferId,
            code: transferCode,
            name: getTransferName(data),
            type: 'sending',
            dataType: data.type,
            size: calculateTotalSize(data),
            status: 'waiting'
        });

        // 创建房间等待接收方
        socket.emit('create-p2p-room', {
            roomId: transferCode,
            senderData: {
                type: data.type,
                fileCount: data.type === 'file' ? data.files.length : 1,
                totalSize: calculateTotalSize(data)
            }
        });

        // 显示等待界面
        showWaitingForReceiver(transferCode);

    } catch (error) {
        showMessage('创建传输失败: ' + error.message, 'error');
        console.error('在线传输错误:', error);
    }
}

// 增强的接收文件功能 - 使用类型检测API
async function receiveFileEnhanced() {
    const receiveCodeInput = document.getElementById('extractCode');
    if (!receiveCodeInput) {
        showMessage('页面元素未加载完成，请刷新页面', 'error');
        return;
    }

    const code = receiveCodeInput.value.trim().toUpperCase();

    if (!code) {
        showMessage('请输入提取码', 'error');
        return;
    }

    if (code.length !== 6) {
        showMessage('提取码格式错误', 'error');
        return;
    }

    // 生成传输ID
    const transferId = 'receive_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // 显示接收进度界面
    showReceiveProgress();
    updateReceiveStatus('正在检测传输类型...');

    try {
        // 首先获取提取码类型信息
        const infoResponse = await fetch(`${API_BASE}/api/info/${code}`);
        const infoResult = await infoResponse.json();

        if (infoResult.success) {
            const transferType = infoResult.transferType;
            const transferData = infoResult.data;

            updateReceiveStatus(`检测到${transferType === 'online' ? '在线' : '离线'}传输 - ${getTypeDisplayName(transferData.type)}`);

            // 添加到活跃传输列表
            addActiveTransfer(transferId, {
                id: transferId,
                code: code,
                name: getTransferDisplayName(transferData),
                type: 'receiving',
                dataType: transferData.type,
                size: transferData.totalSize || transferData.textLength || 0,
                status: transferType === 'online' ? 'waiting' : 'receiving'
            });

            if (transferType === 'offline') {
                // 直接进行离线接收
                await handleOfflineTransfer(code, transferId);
            } else if (transferType === 'online') {
                // 进行在线接收
                await handleOnlineTransfer(code, transferId, transferData);
            }
        } else {
            // 提取码无效
            hideReceiveProgress();
            const errorMessage = getErrorMessage(infoResult.transferType, infoResult.message);
            showMessage(errorMessage, 'error');
        }

    } catch (error) {
        hideReceiveProgress();
        showMessage('检测传输类型失败: ' + error.message, 'error');
        console.error('接收失败:', error);
    }
}

// 处理离线传输
async function handleOfflineTransfer(code, transferId) {
    try {
        updateReceiveStatus('正在获取离线文件...');

        const response = await fetch(`${API_BASE}/api/receive/${code}`);
        const result = await response.json();

        if (result.success) {
            updateReceiveStatus('文件信息获取成功');
            updateTransferStatus(transferId, 'completed');
            handleOfflineReceive(result.data, code);
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        updateTransferStatus(transferId, 'failed');
        hideReceiveProgress();
        showMessage('离线接收失败: ' + error.message, 'error');
    }
}

// 处理在线传输
async function handleOnlineTransfer(code, transferId, transferData) {
    try {
        if (!socket || !socket.connected) {
            throw new Error('Socket连接未建立');
        }

        updateReceiveStatus('正在连接发送方...');
        updateTransferStatus(transferId, 'connecting');

        // 尝试加入P2P房间
        socket.emit('join-p2p-room', {
            roomId: code,
            isReceiver: true
        });

        currentTransferCode = code;
        isInitiator = false;

        // 等待连接建立
        setTimeout(() => {
            updateReceiveStatus('正在建立P2P连接...');
        }, 1000);

        // 设置超时机制
        setTimeout(() => {
            if (currentTransferCode === code && (!peerConnection || peerConnection.connectionState !== 'connected')) {
                updateTransferStatus(transferId, 'failed');
                hideReceiveProgress();
                showMessage('连接超时，发送方可能已离线', 'error');
                currentTransferCode = null;
            }
        }, 15000); // 15秒超时

    } catch (error) {
        updateTransferStatus(transferId, 'failed');
        hideReceiveProgress();
        showMessage('在线接收失败: ' + error.message, 'error');
    }
}

// 获取类型显示名称
function getTypeDisplayName(type) {
    const typeMap = {
        'file': '文件',
        'text': '文本',
        'screen': '屏幕截图',
        'video': '视频'
    };
    return typeMap[type] || '未知类型';
}

// 获取传输显示名称
function getTransferDisplayName(transferData) {
    if (transferData.type === 'file') {
        return transferData.fileCount ? `${transferData.fileCount} 个文件` : '文件';
    } else if (transferData.type === 'text') {
        return transferData.textLength ? `文本 (${transferData.textLength}字符)` : '文本内容';
    } else if (transferData.type === 'screen') {
        return '屏幕截图';
    } else if (transferData.type === 'video') {
        return '视频文件';
    }
    return '未知内容';
}

// 获取错误信息
function getErrorMessage(transferType, originalMessage) {
    const errorMap = {
        'unknown': '提取码不存在，请检查提取码是否正确',
        'expired': '提取码已过期，请重新获取',
        'exhausted': '下载次数已达上限，无法继续下载',
        'error': '服务器错误，请稍后重试'
    };
    return errorMap[transferType] || originalMessage || '未知错误';
}

// 获取传输名称
function getTransferName(data) {
    if (data.type === 'file') {
        if (data.files.length === 1) {
            return data.files[0].name;
        } else {
            return `${data.files.length} 个文件`;
        }
    } else if (data.type === 'text') {
        return '文本内容';
    } else if (data.type === 'screen') {
        return data.screen.name;
    } else if (data.type === 'video') {
        return data.video.name;
    }
    return '未知内容';
}

// ==================== Socket事件增强 ====================

// 添加传输控制事件监听到现有的Socket初始化中
function addTransferControlSocketEvents() {
    if (!socket) return;

    // 监听传输停止事件
    socket.on('transfer-stopped', (data) => {
        console.log('传输被停止:', data);
        const { roomId, reason, stoppedBy, transferType } = data;

        // 查找对应的传输
        for (const [transferId, transfer] of activeTransfers.entries()) {
            if (transfer.code === roomId) {
                updateTransferStatus(transferId, 'cancelled');
                break;
            }
        }

        if (roomId === currentTransferCode) {
            // 根据停止的角色进行不同的处理
            if (stoppedBy === 'receiver') {
                // 接收方停止了传输
                if (transferType !== 'receiving') {
                    // 我是发送方，接收方停止了接收
                    closePeerConnection();
                    resetSenderState();
                    closeModal();
                }
            } else if (stoppedBy === 'sender') {
                // 发送方停止了传输
                if (transferType === 'receiving') {
                    // 我是接收方，发送方停止了发送
                    hideReceiveProgress();
                    closeModal();
                    closePeerConnection();
                    currentTransferCode = null;
                }
            } else {
                // 通用处理
                closePeerConnection();
                resetSenderState();
                closeModal();
                hideReceiveProgress();
                currentTransferCode = null;
            }
        }

        // 根据停止原因显示不同的消息
        let reasonText;
        switch (reason) {
            case 'disconnect_all':
                reasonText = '所有传输已断开';
                break;
            case 'receiver_cancelled':
                reasonText = stoppedBy === 'receiver' ? '接收已停止' : '对方已停止接收';
                break;
            case 'sender_cancelled':
                reasonText = stoppedBy === 'sender' ? '发送已停止' : '对方已停止发送';
                break;
            case 'user_cancelled':
                reasonText = '传输已被取消';
                break;
            default:
                reasonText = '传输已停止';
        }

        showMessage(reasonText, 'info');
    });

    // 监听传输暂停事件
    socket.on('transfer-paused', (data) => {
        console.log('传输被暂停:', data);
        transferPaused = true;
        showMessage('传输已被暂停', 'info');
        updateActiveTransfersList();
    });

    // 监听传输恢复事件
    socket.on('transfer-resumed', (data) => {
        console.log('传输已恢复:', data);
        transferPaused = false;
        showMessage('传输已恢复', 'info');
        updateActiveTransfersList();
    });
}

// 页面加载完成后初始化传输控制面板
document.addEventListener('DOMContentLoaded', function () {
    // 定期更新活跃传输列表
    setInterval(() => {
        if (transferControlPanelVisible && activeTransfers.size > 0) {
            updateActiveTransfersList();
        }
    }, 1000);
});

console.log('传输控制功能已加载');
// ==================== 缺失的辅助函数 ====================

// 复制到剪贴板
function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showMessage('提取码已复制到剪贴板', 'success');
        }).catch(err => {
            console.error('复制失败:', err);
            fallbackCopyTextToClipboard(text);
        });
    } else {
        fallbackCopyTextToClipboard(text);
    }
}

// 备用复制方法
function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showMessage('提取码已复制到剪贴板', 'success');
        } else {
            showMessage('复制失败，请手动复制', 'error');
        }
    } catch (err) {
        console.error('复制失败:', err);
        showMessage('复制失败，请手动复制', 'error');
    }

    document.body.removeChild(textArea);
}

// 检查浏览器支持
function checkBrowserSupport() {
    const features = {
        webrtc: !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection),
        websocket: !!window.WebSocket,
        fileapi: !!(window.File && window.FileReader && window.FileList && window.Blob),
        getusermedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    };

    const unsupported = [];
    for (const [feature, supported] of Object.entries(features)) {
        if (!supported) {
            unsupported.push(feature);
        }
    }

    if (unsupported.length > 0) {
        console.warn('不支持的功能:', unsupported);
        showMessage('您的浏览器可能不支持某些功能，建议使用最新版Chrome或Firefox', 'warning');
    }

    return features;
}

// 初始化模态框
function initializeModal() {
    const modal = document.getElementById('modal');
    const closeBtn = modal.querySelector('.close');

    if (closeBtn) {
        closeBtn.onclick = closeModal;
    }

    // 点击模态框外部关闭
    window.onclick = function (event) {
        if (event.target === modal) {
            closeModal();
        }
    };
}

// 显示VIP区别信息
function showRegion() {
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
        <div style="text-align: center;">
            <h2 style="color: #4A90E2; margin-bottom: 20px;">
                <i class="fas fa-crown" style="color: #ffd700;"></i>
                VIP功能区别
            </h2>
            <div style="display: flex; gap: 20px; justify-content: center; flex-wrap: wrap;">
                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; flex: 1; min-width: 200px;">
                    <h3 style="color: #e91e63; margin-bottom: 15px;">
                        <i class="fas fa-wifi"></i> 在线传输
                    </h3>
                    <ul style="text-align: left; color: #666; line-height: 1.6;">
                        <li>实时P2P传输</li>
                        <li>传输速度更快</li>
                        <li>无文件大小限制</li>
                        <li>需要双方同时在线</li>
                        <li>传输完成即删除</li>
                    </ul>
                </div>
                <div style="background: #f0f8ff; padding: 20px; border-radius: 8px; flex: 1; min-width: 200px; border: 2px solid #4CAF50;">
                    <h3 style="color: #4CAF50; margin-bottom: 15px;">
                        <i class="fas fa-cloud"></i> 离线传输 (VIP)
                    </h3>
                    <ul style="text-align: left; color: #666; line-height: 1.6;">
                        <li>云端中转存储</li>
                        <li>支持异地传输</li>
                        <li>24小时有效期</li>
                        <li>最多10次下载</li>
                        <li>单次最大10GB</li>
                    </ul>
                </div>
            </div>
            <div style="margin-top: 20px;">
                <button onclick="closeModal()" class="btn-primary">
                    <i class="fas fa-times"></i> 关闭
                </button>
            </div>
        </div>
    `;
    showModal();
}

// 页面初始化完成后的额外设置
document.addEventListener('DOMContentLoaded', function () {
    // 定期更新活跃传输列表
    setInterval(() => {
        if (transferControlPanelVisible && activeTransfers.size > 0) {
            updateActiveTransfersList();
        }
    }, 1000);

    // 添加键盘快捷键
    document.addEventListener('keydown', function (e) {
        // Ctrl+Shift+C 打开传输控制面板
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
            e.preventDefault();
            toggleControlPanel();
        }

        // ESC 关闭模态框
        if (e.key === 'Escape') {
            closeModal();
            if (transferControlPanelVisible) {
                toggleControlPanel();
            }
        }
    });

    console.log('轻松互传系统已加载完成');
    console.log('快捷键: Ctrl+Shift+C 打开传输控制面板');
});