// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const ADMIN_PASS = 'nimda-1818';
const ADMIN_USERNAME = 'Admin';
const KICK_URL = 'https://www.google.com';

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// In-memory storage
const channels = {
    general: [],
    random: [],
    gaming: [],
    memes: []
};

// User/Moderation State
const users = new Map(); // ws -> { username, id, isAdmin, isMuted, muteExpires }
const userSocketMap = new Map(); // username -> ws

const bannedUsers = new Set(); // Stores usernames of permanently banned users
const mutedUsers = new Map(); // Stores username -> expirationTimestamp (Date.now() + duration)
const privateChats = new Map();

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to server'
    }));
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Error parsing message'
            }));
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            userSocketMap.delete(user.username);
            users.delete(ws);
            broadcastUserList();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Helper function to check if a user is currently muted
function isUserMuted(username) {
    const expires = mutedUsers.get(username);
    if (!expires) return false;
    
    if (expires > Date.now()) {
        return true;
    } else {
        // Mute expired, clean up
        mutedUsers.delete(username);
        return false;
    }
}

// Handle different message types
function handleMessage(ws, message) {
    console.log('Handling message type:', message.type);
    
    switch (message.type) {
        case 'join':
            handleJoin(ws, message);
            break;
        case 'adminLogin':
            handleAdminLogin(ws, message);
            break;
        case 'adminAction':
            handleAdminAction(ws, message);
            break;
        case 'message':
            handleChatMessage(ws, message);
            break;
        case 'imageMessage':
            handleImageMessage(ws, message);
            break;
        case 'getHistory':
            handleGetHistory(ws, message);
            break;
        case 'typing':
            handleTyping(ws, message);
            break;
        case 'privateChatRequest':
            handlePrivateChatRequest(ws, message);
            break;
        case 'privateChatResponse':
            handlePrivateChatResponse(ws, message);
            break;
        case 'privateMessage':
            handlePrivateMessage(ws, message);
            break;
        case 'privateImageMessage':
            handlePrivateImageMessage(ws, message);
            break;
        case 'getPrivateHistory':
            handleGetPrivateHistory(ws, message);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// --- Admin Handlers ---

function handleAdminLogin(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    if (message.password === ADMIN_PASS) {
        user.isAdmin = true;
        console.log(`${user.username} logged in as Admin.`);
        ws.send(JSON.stringify({
            type: 'adminStatus',
            isAdmin: true,
            username: user.username
        }));
        // Update user list to show admin status
        broadcastUserList();
    } else {
        ws.send(JSON.stringify({
            type: 'adminStatus',
            isAdmin: false,
            message: 'Incorrect password'
        }));
    }
}

function handleAdminAction(ws, message) {
    const adminUser = users.get(ws);
    if (!adminUser || !adminUser.isAdmin) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized action.' }));
        return;
    }

    const { targetUsername, action, duration } = message;
    const targetWs = userSocketMap.get(targetUsername);
    const targetUser = targetWs ? users.get(targetWs) : null;

    if (!targetUser && action !== 'unban') {
        ws.send(JSON.stringify({ type: 'error', message: `User ${targetUsername} not found or offline.` }));
        return;
    }
    
    const broadcastMessage = {
        type: 'systemNotification',
        channel: adminUser.username, // Use admin name as context
        text: `${adminUser.username} performed action: ${action} on ${targetUsername}.`
    };
    broadcast(broadcastMessage);

    switch (action) {
        case 'kick':
            if (targetWs) {
                targetWs.send(JSON.stringify({ type: 'kick', url: KICK_URL }));
                targetWs.close(1000, 'Kicked by admin');
                console.log(`Admin kicked ${targetUsername}`);
            }
            break;

        case 'ban':
            bannedUsers.add(targetUsername);
            if (targetWs) {
                targetWs.send(JSON.stringify({ type: 'kick', url: KICK_URL, reason: 'You have been permanently banned.' }));
                targetWs.close(1000, 'Permanently banned');
            }
            console.log(`Admin permanently banned ${targetUsername}`);
            break;
            
        case 'unban':
            bannedUsers.delete(targetUsername);
            console.log(`Admin unbanned ${targetUsername}`);
            break;

        case 'mute':
            let durationMs = 0;
            switch (duration) {
                case '1m': durationMs = 60000; break;
                case '5m': durationMs = 300000; break;
                case 'forever': durationMs = Infinity; break;
                default: durationMs = 0;
            }
            
            if (durationMs > 0) {
                const expiration = durationMs === Infinity ? Infinity : Date.now() + durationMs;
                mutedUsers.set(targetUsername, expiration);
                if (targetWs) {
                    targetWs.send(JSON.stringify({ type: 'muteStatus', isMuted: true, duration }));
                }
                console.log(`Admin muted ${targetUsername} for ${duration}`);
            }
            break;

        case 'unmute':
            mutedUsers.delete(targetUsername);
            if (targetWs) {
                targetWs.send(JSON.stringify({ type: 'muteStatus', isMuted: false }));
            }
            console.log(`Admin unmuted ${targetUsername}`);
            break;
            
        default:
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid admin action.' }));
    }
    broadcastUserList(); // Update user list for new mute/ban statuses
}


// --- User Joins ---
function handleJoin(ws, message) {
    const { username } = message;
    
    // 1. Check if user is banned
    if (bannedUsers.has(username)) {
        ws.send(JSON.stringify({ type: 'kick', url: KICK_URL, reason: 'You are permanently banned.' }));
        ws.close(1000, 'Banned');
        return;
    }
    
    // 2. Initial Setup
    users.set(ws, {
        username,
        id: generateId(),
        isAdmin: false,
        isMuted: isUserMuted(username)
    });
    
    userSocketMap.set(username, ws);

    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels),
        // Send initial mute status
        isMuted: isUserMuted(username) 
    }));

    broadcastUserList();
    console.log(`User ${username} joined. Total users: ${users.size}`);
}

// --- Chat Message Handlers (Modified for Mute Check) ---
function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;
    
    if (isUserMuted(user.username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You are currently muted and cannot send public messages.' }));
        return;
    }

    const { channel, text } = message;
    // ... rest of handleChatMessage implementation (unchanged) ...
    
    const chatMessage = {
        id: generateId(),
        author: user.username,
        text,
        channel,
        timestamp: new Date().toISOString()
    };

    if (channels[channel]) {
        channels[channel].push(chatMessage);
        
        if (channels[channel].length > 100) {
            channels[channel].shift();
        }
    }

    broadcast({
        type: 'message',
        message: chatMessage
    });
}

function handleImageMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;
    
    if (isUserMuted(user.username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You are currently muted and cannot send public messages.' }));
        return;
    }

    const { channel, imageData, fileName } = message;
    // ... rest of handleImageMessage implementation (unchanged) ...

    const imageMessage = {
        id: generateId(),
        author: user.username,
        imageData: imageData,
        fileName: fileName,
        channel: channel,
        timestamp: new Date().toISOString(),
        isImage: true
    };

    if (channels[channel]) {
        channels[channel].push(imageMessage);
        
        if (channels[channel].length > 100) {
            channels[channel].shift();
        }
    }

    const broadcastData = {
        type: 'message',
        message: imageMessage
    };
    
    broadcast(broadcastData);
}

// Private chat messages are typically allowed even when muted, 
// so no mute check is added here.

function handlePrivateImageMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    const { chatId, imageData, fileName, targetUsername } = message;
    
    const imageMessage = {
        id: generateId(),
        author: sender.username,
        imageData,
        fileName,
        chatId,
        timestamp: new Date().toISOString(),
        isImage: true
    };

    if (!privateChats.has(chatId)) {
        privateChats.set(chatId, []);
    }
    
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(imageMessage);

    if (chatMessages.length > 100) {
        chatMessages.shift();
    }

    const targetWs = userSocketMap.get(targetUsername);
    
    const messageData = {
        type: 'privateMessage',
        message: imageMessage
    };

    ws.send(JSON.stringify(messageData));

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(messageData));
    }
}

function handlePrivateChatRequest(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    const { targetUsername } = message;
    const targetWs = userSocketMap.get(targetUsername);

    if (!targetWs) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'User not found or offline'
        }));
        return;
    }

    console.log(`Private chat request from ${sender.username} to ${targetUsername}`);

    targetWs.send(JSON.stringify({
        type: 'privateChatRequest',
        from: sender.username,
        requestId: generateId()
    }));
}

function handlePrivateChatResponse(ws, message) {
    const responder = users.get(ws);
    if (!responder) return;

    const { accepted, from } = message;
    const requesterWs = userSocketMap.get(from);

    if (!requesterWs) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'User no longer online'
        }));
        return;
    }

    if (accepted) {
        const users = [from, responder.username].sort();
        const chatId = `private_${users[0]}_${users[1]}`;

        if (!privateChats.has(chatId)) {
            privateChats.set(chatId, []);
        }

        const chatData = {
            type: 'privateChatAccepted',
            chatId: chatId,
            with: responder.username
        };

        requesterWs.send(JSON.stringify(chatData));

        ws.send(JSON.stringify({
            type: 'privateChatAccepted',
            chatId: chatId,
            with: from
        }));
    } else {
        requesterWs.send(JSON.stringify({
            type: 'privateChatRejected',
            by: responder.username
        }));
    }
}

function handlePrivateMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    const { chatId, text, targetUsername } = message;
    
    const privateMessage = {
        id: generateId(),
        author: sender.username,
        text,
        chatId,
        timestamp: new Date().toISOString()
    };

    if (!privateChats.has(chatId)) {
        privateChats.set(chatId, []);
    }
    
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(privateMessage);

    if (chatMessages.length > 100) {
        chatMessages.shift();
    }

    const targetWs = userSocketMap.get(targetUsername);
    
    const messageData = {
        type: 'privateMessage',
        message: privateMessage
    };

    ws.send(JSON.stringify(messageData));

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(messageData));
    }
}

function handleGetPrivateHistory(ws, message) {
    const { chatId } = message;
    
    const messages = privateChats.get(chatId) || [];
    
    ws.send(JSON.stringify({
        type: 'privateHistory',
        chatId,
        messages
    }));
}

function handleGetHistory(ws, message) {
    const { channel } = message;
    
    if (channels[channel]) {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: channels[channel]
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: []
        }));
    }
}

function handleTyping(ws, message) {
    const user = users.get(ws);
    if (!user) return;
    
    if (isUserMuted(user.username) && !message.isPrivate) {
        return; // Muted users cannot send public typing indicators
    }

    const { channel, isTyping, isPrivate, targetUsername } = message;
    
    if (isPrivate && targetUsername) {
        const targetWs = userSocketMap.get(targetUsername);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
                type: 'typing',
                username: user.username,
                channel,
                isTyping,
                isPrivate: true
            }));
        }
    } else {
        broadcast({
            type: 'typing',
            username: user.username,
            channel,
            isTyping
        }, ws);
    }
}

// Broadcast user list (Modified to include admin/mute status)
function broadcastUserList() {
    // Collect all online users with status
    const onlineUsers = Array.from(users.values()).map(u => ({
        username: u.username,
        isAdmin: u.isAdmin || false,
        isMuted: isUserMuted(u.username)
    }));
    
    // Include permanently banned users who are currently offline for Admin visibility
    const offlineBanned = Array.from(bannedUsers)
        .filter(bannedName => !userSocketMap.has(bannedName))
        .map(username => ({
            username,
            isAdmin: false,
            isMuted: false, // Banned status trumps muted status
            isBanned: true
        }));
        
    const userList = [...onlineUsers, ...offlineBanned].sort((a, b) => {
        if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
        return a.username.localeCompare(b.username);
    });

    broadcast({
        type: 'userList',
        users: userList
    });
}

// Broadcast to all clients
function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// REST API endpoints (unchanged)
app.get('/api/channels', (req, res) => {
    res.json({
        channels: Object.keys(channels)
    });
});

app.get('/api/channels/:channel/messages', (req, res) => {
    const { channel } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    if (channels[channel]) {
        const messages = channels[channel].slice(-limit);
        res.json({ messages });
    } else {
        res.status(404).json({ error: 'Channel not found' });
    }
});

app.post('/api/channels', (req, res) => {
    const { name } = req.body;
    
    if (!name || channels[name]) {
        return res.status(400).json({ error: 'Invalid or duplicate channel name' });
    }
    
    channels[name] = [];
    
    broadcast({
        type: 'channelCreated',
        channel: name
    });
    
    res.json({ success: true, channel: name });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length,
        privateChats: privateChats.size
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log(`Admin Password: ${ADMIN_PASS}`);
    console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
