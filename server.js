const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static('.'));

// 创建上传目录
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置multer用于文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 * 1024 // 10GB限制
    }
});

// 存储传输数据
const transfers = new Map();
const p2pRooms = new Map(); // P2P房间管理

// 生成传输码
function generateTransferCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 清理过期传输
function cleanupExpiredTransfers() {
    const now = Date.now();
    for (const [code, transfer] of transfers.entries()) {
        if (transfer.expiresAt && now > transfer.expiresAt) {
            // 删除文件
            if (transfer.files) {
                transfer.files.forEach(file => {
                    if (fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                    }
                });
            }
            transfers.delete(code);
        }
    }
}

// 每小时清理一次过期传输
setInterval(cleanupExpiredTransfers, 60 * 60 * 1000);

// API路由

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: '轻松互传服务器运行正常',
        timestamp: new Date().toISOString(),
        features: {
            webrtc: true,
            offline: true,
            fileTypes: ['file', 'text', 'screen', 'video']
        }
    });
});

// 上传文件接口
app.post('/api/upload', upload.array('files', 10), (req, res) => {
    try {
        const { type, isOnline, textContent } = req.body;
        const transferCode = generateTransferCode();
        
        const transferData = {
            id: Date.now(),
            code: transferCode,
            type: type,
            isOnline: isOnline === 'true',
            timestamp: new Date().toISOString(),
            expiresAt: isOnline === 'true' ? null : Date.now() + 24 * 60 * 60 * 1000,
            downloadCount: 0,
            maxDownloads: 10
        };

        if (type === 'file' && req.files) {
            transferData.files = req.files.map(file => ({
                originalName: file.originalname,
                filename: file.filename,
                path: file.path,
                size: file.size,
                mimetype: file.mimetype
            }));
        } else if (type === 'text') {
            transferData.textContent = textContent;
        }

        transfers.set(transferCode, transferData);

        res.json({
            success: true,
            code: transferCode,
            message: '上传成功'
        });

    } catch (error) {
        console.error('上传错误:', error);
        res.status(500).json({
            success: false,
            message: '上传失败'
        });
    }
});

// 接收文件接口
app.get('/api/receive/:code', (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const transfer = transfers.get(code);

        if (!transfer) {
            return res.status(404).json({
                success: false,
                message: '提取码不存在或已过期'
            });
        }

        // 检查是否过期
        if (transfer.expiresAt && Date.now() > transfer.expiresAt) {
            transfers.delete(code);
            return res.status(404).json({
                success: false,
                message: '提取码已过期'
            });
        }

        // 检查下载次数
        if (transfer.downloadCount >= transfer.maxDownloads) {
            return res.status(403).json({
                success: false,
                message: '下载次数已达上限'
            });
        }

        // 增加下载次数
        transfer.downloadCount++;

        // 返回传输信息（不包含文件路径）
        const responseData = {
            success: true,
            data: {
                type: transfer.type,
                timestamp: transfer.timestamp,
                isOnline: transfer.isOnline
            }
        };

        if (transfer.type === 'file') {
            responseData.data.files = transfer.files.map(file => ({
                originalName: file.originalName,
                size: file.size,
                mimetype: file.mimetype,
                downloadUrl: `/api/download/${code}/${file.filename}`
            }));
        } else if (transfer.type === 'text') {
            responseData.data.textContent = transfer.textContent;
        }

        res.json(responseData);

    } catch (error) {
        console.error('接收错误:', error);
        res.status(500).json({
            success: false,
            message: '接收失败'
        });
    }
});

// 下载文件接口
app.get('/api/download/:code/:filename', (req, res) => {
    try {
        const { code, filename } = req.params;
        const transfer = transfers.get(code.toUpperCase());

        if (!transfer || !transfer.files) {
            return res.status(404).json({
                success: false,
                message: '文件不存在'
            });
        }

        const file = transfer.files.find(f => f.filename === filename);
        if (!file) {
            return res.status(404).json({
                success: false,
                message: '文件不存在'
            });
        }

        const filePath = file.path;
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                message: '文件已被删除'
            });
        }

        // 设置下载头
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
        res.setHeader('Content-Type', file.mimetype);

        // 发送文件
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);

    } catch (error) {
        console.error('下载错误:', error);
        res.status(500).json({
            success: false,
            message: '下载失败'
        });
    }
});

// 获取提取码类型信息
app.get('/api/info/:code', (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        
        // 首先检查离线传输
        const transfer = transfers.get(code);
        if (transfer) {
            // 检查是否过期
            if (transfer.expiresAt && Date.now() > transfer.expiresAt) {
                transfers.delete(code);
                return res.status(404).json({
                    success: false,
                    message: '提取码已过期',
                    transferType: 'expired'
                });
            }

            // 检查下载次数
            if (transfer.downloadCount >= transfer.maxDownloads) {
                return res.status(403).json({
                    success: false,
                    message: '下载次数已达上限',
                    transferType: 'exhausted'
                });
            }

            // 返回离线传输类型信息
            const responseData = {
                success: true,
                transferType: 'offline',
                data: {
                    code: transfer.code,
                    type: transfer.type,
                    isOnline: false,
                    timestamp: transfer.timestamp,
                    downloadCount: transfer.downloadCount,
                    maxDownloads: transfer.maxDownloads,
                    expiresAt: transfer.expiresAt
                }
            };

            // 添加内容概要信息
            if (transfer.type === 'file' && transfer.files) {
                responseData.data.fileCount = transfer.files.length;
                responseData.data.totalSize = transfer.files.reduce((sum, file) => sum + file.size, 0);
                responseData.data.fileNames = transfer.files.map(file => file.originalName);
            } else if (transfer.type === 'text') {
                responseData.data.textLength = transfer.textContent ? transfer.textContent.length : 0;
                responseData.data.textPreview = transfer.textContent ? transfer.textContent.substring(0, 100) : '';
            }

            return res.json(responseData);
        }

        // 检查在线传输（P2P房间）
        const room = p2pRooms.get(code);
        if (room) {
            // 检查房间是否过期（30分钟）
            const roomAge = Date.now() - room.created;
            if (roomAge > 30 * 60 * 1000) {
                p2pRooms.delete(code);
                return res.status(404).json({
                    success: false,
                    message: '在线传输已过期',
                    transferType: 'expired'
                });
            }

            // 返回在线传输类型信息
            const responseData = {
                success: true,
                transferType: 'online',
                data: {
                    code: code,
                    type: room.type || room.senderData?.type || 'file',
                    isOnline: true,
                    timestamp: new Date(room.created).toISOString(),
                    senderConnected: !!room.sender,
                    receiverConnected: !!room.receiver,
                    roomAge: Math.floor(roomAge / 1000) // 秒
                }
            };

            // 添加发送方数据概要
            if (room.senderData) {
                responseData.data.fileCount = room.senderData.fileCount || 0;
                responseData.data.totalSize = room.senderData.totalSize || 0;
                if (room.senderData.content) {
                    responseData.data.textLength = room.senderData.content.length;
                    responseData.data.textPreview = room.senderData.content.substring(0, 100);
                }
            }

            return res.json(responseData);
        }

        // 提取码不存在
        return res.status(404).json({
            success: false,
            message: '提取码不存在',
            transferType: 'unknown'
        });

    } catch (error) {
        console.error('获取提取码信息错误:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误',
            transferType: 'error'
        });
    }
});

// 获取传输状态
app.get('/api/status/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    const transfer = transfers.get(code);

    if (!transfer) {
        return res.status(404).json({
            success: false,
            message: '传输不存在'
        });
    }

    res.json({
        success: true,
        data: {
            code: transfer.code,
            type: transfer.type,
            isOnline: transfer.isOnline,
            downloadCount: transfer.downloadCount,
            maxDownloads: transfer.maxDownloads,
            expiresAt: transfer.expiresAt,
            timestamp: transfer.timestamp
        }
    });
});

// Socket.IO P2P传输处理
io.on('connection', (socket) => {
    console.log('用户连接:', socket.id);

    // 创建P2P房间
    socket.on('create-p2p-room', (data) => {
        const { roomId, senderData } = data;
        
        if (p2pRooms.has(roomId)) {
            socket.emit('room-exists');
            return;
        }
        
        // 创建房间
        p2pRooms.set(roomId, {
            sender: socket.id,
            receiver: null,
            senderData: senderData,
            created: Date.now(),
            isOnline: true,
            type: senderData.type || 'file'
        });
        
        socket.join(roomId);
        socket.emit('room-created', { roomId });
        
        console.log(`房间 ${roomId} 创建成功，发送方: ${socket.id}，类型: ${senderData.type}`);
    });

    // 加入P2P房间
    socket.on('join-p2p-room', (data) => {
        const { roomId, isReceiver } = data;
        const room = p2pRooms.get(roomId);
        
        if (!room) {
            socket.emit('room-not-found');
            return;
        }
        
        if (isReceiver && !room.receiver) {
            room.receiver = socket.id;
            socket.join(roomId);
            socket.emit('room-joined', { roomId });
            
            // 通知发送方接收方已加入
            io.to(room.sender).emit('receiver-joined', { roomId });
            
            console.log(`接收方 ${socket.id} 加入房间 ${roomId}`);
        } else {
            socket.emit('room-full');
        }
    });

    // WebRTC信令处理
    socket.on('webrtc-offer', (data) => {
        const { roomId, offer } = data;
        const room = p2pRooms.get(roomId);
        
        if (room && room.receiver) {
            io.to(room.receiver).emit('webrtc-offer', { roomId, offer });
            console.log(`转发WebRTC Offer到房间 ${roomId}`);
        }
    });

    socket.on('webrtc-answer', (data) => {
        const { roomId, answer } = data;
        const room = p2pRooms.get(roomId);
        
        if (room && room.sender) {
            io.to(room.sender).emit('webrtc-answer', { roomId, answer });
            console.log(`转发WebRTC Answer到房间 ${roomId}`);
        }
    });

    socket.on('webrtc-ice-candidate', (data) => {
        const { roomId, candidate } = data;
        const room = p2pRooms.get(roomId);
        
        if (room) {
            // 转发给房间内的其他用户
            socket.to(roomId).emit('webrtc-ice-candidate', { roomId, candidate });
        }
    });

    // 取消传输
    socket.on('cancel-transfer', (data) => {
        const { roomId } = data;
        const room = p2pRooms.get(roomId);
        
        if (room) {
            // 通知房间内其他用户
            socket.to(roomId).emit('transfer-cancelled');
            p2pRooms.delete(roomId);
            console.log(`房间 ${roomId} 已取消`);
        }
    });

    // 停止传输
    socket.on('stop-transfer', (data) => {
        const { roomId, reason, transferType } = data;
        const room = p2pRooms.get(roomId);
        
        if (room) {
            // 确定停止的角色
            const stoppedBy = transferType === 'receiving' ? 'receiver' : 'sender';
            const isReceiver = socket.id === room.receiver;
            const isSender = socket.id === room.sender;
            
            // 通知房间内其他用户传输被停止
            socket.to(roomId).emit('transfer-stopped', { 
                roomId, 
                reason, 
                stoppedBy,
                transferType: transferType || 'unknown'
            });
            
            // 清理房间
            p2pRooms.delete(roomId);
            
            // 记录日志
            const roleText = isReceiver ? '接收方' : isSender ? '发送方' : '未知用户';
            console.log(`房间 ${roomId} 传输被${roleText}停止，原因: ${reason}`);
        }
    });

    // 暂停传输
    socket.on('pause-transfer', (data) => {
        const { roomId } = data;
        const room = p2pRooms.get(roomId);
        
        if (room) {
            // 通知房间内其他用户传输被暂停
            socket.to(roomId).emit('transfer-paused', { roomId });
            console.log(`房间 ${roomId} 传输被暂停`);
        }
    });

    // 恢复传输
    socket.on('resume-transfer', (data) => {
        const { roomId } = data;
        const room = p2pRooms.get(roomId);
        
        if (room) {
            // 通知房间内其他用户传输已恢复
            socket.to(roomId).emit('transfer-resumed', { roomId });
            console.log(`房间 ${roomId} 传输已恢复`);
        }
    });

    // 用户断开连接
    socket.on('disconnect', () => {
        console.log('用户断开连接:', socket.id);
        
        // 清理P2P房间
        for (const [roomId, room] of p2pRooms.entries()) {
            if (room.sender === socket.id || room.receiver === socket.id) {
                // 通知另一方用户已断开
                socket.to(roomId).emit('peer-left');
                p2pRooms.delete(roomId);
                console.log(`房间 ${roomId} 因用户断开而清理`);
                break;
            }
        }
    });
});

// 定期清理过期的P2P房间
setInterval(() => {
    const now = Date.now();
    const expireTime = 30 * 60 * 1000; // 30分钟过期
    
    for (const [roomId, room] of p2pRooms.entries()) {
        if (now - room.created > expireTime) {
            p2pRooms.delete(roomId);
            console.log(`房间 ${roomId} 因过期而清理`);
        }
    }
}, 5 * 60 * 1000); // 每5分钟检查一次

// 错误处理
app.use((error, req, res, next) => {
    console.error('服务器错误:', error);
    res.status(500).json({
        success: false,
        message: '服务器内部错误'
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('轻松互传服务器启动成功！');
    console.log(`访问地址: http://localhost:${PORT}`);
    console.log(`API文档: http://localhost:${PORT}/api/health`);
    console.log('支持功能:');
    console.log('- WebRTC P2P在线传输');
    console.log('- 云端离线传输');
    console.log('- 文件、文本、屏幕、视频传输');
    console.log('- 提取码系统');
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('收到SIGINT信号，正在关闭服务器...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});