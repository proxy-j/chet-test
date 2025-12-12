// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Admin Configuration
const ADMIN_PASSWORD = 'nimda-1818';

// In-memory storage
const channels = {
    general: [],
    random: [],
    gaming: [],
    memes: []
};

const users = new Map(); // ws -> { username, id, isAdmin }
const privateChats = new Map();
const userSocketMap = new Map(); // username -> ws

// NEW: Moderation Storage
const bannedIPs = new Set();
const mutedUsers = new Map(); // username -> mute_until_timestamp (or 'forever')


// Utility to get user IP
function getIpAddress(ws) {
    // NOTE: This is a simplification. In a real environment with reverse proxies (like Nginx), 
    // you'd use the 'x-forwarded-for' header on the HTTP request, which is not directly available 
    // on the WebSocket object itself. For local testing, this will likely return the local IP.
    return ws._socket.remoteAddress;
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const clientIp = getIpAddress(ws);

    if (bannedIPs.has(clientIp)) {
        console.log(`Banned IP ${clientIp} attempted to connect.`);
        ws.close(1008, 'Banned'); // 1008 is "Policy Violation"
        return;
    }

    console.log('New client connected', clientIp);
    
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

// Handle different message types
function handleMessage(ws, message) {
    const user = users.get(ws);
    
    // Check mute status before processing any message (except 'join' or 'adminLogin')
    if (user && user.username !== 'admin' && message.type !== 'join' && message.type !== 'adminLogin') {
        const muteInfo = mutedUsers.get(user.username);
        if (muteInfo) {
            if (muteInfo === 'forever' || muteInfo > Date.now()) {
                // User is still muted, ignore message and send mute warning if it's a message type
                if (['message', 'imageMessage', 'privateMessage', 'privateImageMessage'].includes(message.type)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are currently muted.' }));
                }
                return;
            } else {
                // Mute expired
                mutedUsers.delete(user.username);
                ws.send(JSON.stringify({ type: 'unmuted' }));
            }
        }
    }

    switch (message.type) {
        case 'join':
            handleJoin(ws, message);
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
        // NEW ADMIN LOGIC
        case 'adminLogin':
            handleAdminLogin(ws, message);
            break;
        case 'adminAction':
            handleAdminAction(ws, message);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// User joins
function handleJoin(ws, message) {
    const { username } = message;
    
    // Check for duplicate username
    if (userSocketMap.has(username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Username is already taken or still marked as online.' }));
        ws.close();
        return;
    }

    const clientIp = getIpAddress(ws);
    console.log(`User joining: ${username} from IP: ${clientIp}`);
    
    users.set(ws, {
        username,
        id: generateId(),
        ip: clientIp, // Store IP for banning
        isAdmin: false 
    });
    
    userSocketMap.set(username, ws);

    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels)
    }));

    // Check if the joining user is currently muted
    const muteInfo = mutedUsers.get(username);
    if (muteInfo && (muteInfo === 'forever' || muteInfo > Date.now())) {
        ws.send(JSON.stringify({ type: 'muted', duration: muteInfo }));
    } else if (muteInfo) {
        mutedUsers.delete(username); // Clear expired mute
    }

    broadcastUserList();
}

// Handle chat messages - simplified for brevity, similar to original
function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, text } = message;
    
    const chatMessage = {
        id: generateId(),
        author: user.username,
        text,
        channel,
        timestamp: new Date().toISOString()
    };

    if (channels[channel]) {
        channels[channel].push(chatMessage);
        if (channels[channel].length > 100) channels[channel].shift();
    }

    broadcast({ type: 'message', message: chatMessage });
}

// Handle image messages - simplified for brevity, similar to original
function handleImageMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, imageData, fileName } = message;
    
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
        if (channels[channel].length > 100) channels[channel].shift();
    }

    broadcast({ type: 'message', message: imageMessage });
}

// Handle private image messages - logic remains the same
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

    if (!privateChats.has(chatId)) privateChats.set(chatId, []);
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(imageMessage);
    if (chatMessages.length > 100) chatMessages.shift();

    const targetWs = userSocketMap.get(targetUsername);
    const messageData = { type: 'privateMessage', message: imageMessage };

    ws.send(JSON.stringify(messageData));
    if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(JSON.stringify(messageData));
}

// Handle private chat request - logic remains the same
function handlePrivateChatRequest(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    const { targetUsername } = message;
    const targetWs = userSocketMap.get(targetUsername);

    if (!targetWs) {
        ws.send(JSON.stringify({ type: 'error', message: 'User not found or offline' }));
        return;
    }

    targetWs.send(JSON.stringify({ type: 'privateChatRequest', from: sender.username, requestId: generateId() }));
}

// Handle private chat response - logic remains the same
function handlePrivateChatResponse(ws, message) {
    const responder = users.get(ws);
    if (!responder) return;

    const { accepted, from } = message;
    const requesterWs = userSocketMap.get(from);

    if (!requesterWs) {
        ws.send(JSON.stringify({ type: 'error', message: 'User no longer online' }));
        return;
    }

    if (accepted) {
        const users = [from, responder.username].sort();
        const chatId = `private_${users[0]}_${users[1]}`;

        if (!privateChats.has(chatId)) privateChats.set(chatId, []);

        const chatData = { type: 'privateChatAccepted', chatId: chatId, with: responder.username };

        requesterWs.send(JSON.stringify(chatData));
        ws.send(JSON.stringify({ type: 'privateChatAccepted', chatId: chatId, with: from }));
    } else {
        requesterWs.send(JSON.stringify({ type: 'privateChatRejected', by: responder.username }));
    }
}

// Handle private message - logic remains the same
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

    if (!privateChats.has(chatId)) privateChats.set(chatId, []);
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(privateMessage);
    if (chatMessages.length > 100) chatMessages.shift();

    const targetWs = userSocketMap.get(targetUsername);
    const messageData = { type: 'privateMessage', message: privateMessage };

    ws.send(JSON.stringify(messageData));
    if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(JSON.stringify(messageData));
}

// Get private chat history - logic remains the same
function handleGetPrivateHistory(ws, message) {
    const { chatId } = message;
    const messages = privateChats.get(chatId) || [];
    ws.send(JSON.stringify({ type: 'privateHistory', chatId, messages }));
}

// Get channel history - logic remains the same
function handleGetHistory(ws, message) {
    const { channel } = message;
    const messages = channels[channel] || [];
    ws.send(JSON.stringify({ type: 'history', channel, messages: messages }));
}

// Handle typing indicator - logic remains the same
function handleTyping(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, isTyping, isPrivate, targetUsername } = message;
    
    if (isPrivate && targetUsername) {
        const targetWs = userSocketMap.get(targetUsername);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ type: 'typing', username: user.username, channel, isTyping, isPrivate: true }));
        }
    } else {
        broadcast({ type: 'typing', username: user.username, channel, isTyping }, ws);
    }
}

// NEW: Admin Login Handler
function handleAdminLogin(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    if (message.password === ADMIN_PASSWORD) {
        user.isAdmin = true;
        ws.send(JSON.stringify({ type: 'adminStatus', isAdmin: true }));
        console.log(`ADMIN LOGIN SUCCESS: ${user.username}`);
    } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid Admin Password.' }));
    }
}

// NEW: Admin Action Handler
function handleAdminAction(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        ws.send(JSON.stringify({ type: 'error', message: 'Permission denied.' }));
        return;
    }

    const { action, targetUsername, duration } = message;
    const targetWs = userSocketMap.get(targetUsername);
    let targetUser = null;

    // Find the target user object to get their IP
    if (targetWs) {
        targetUser = users.get(targetWs);
    }

    if (!targetUser) {
        ws.send(JSON.stringify({ type: 'error', message: 'Target user not found or offline.' }));
        return;
    }

    console.log(`Admin ${admin.username} performing action: ${action} on ${targetUsername}`);

    switch (action) {
        case 'kick':
            targetWs.send(JSON.stringify({ type: 'kicked' }));
            targetWs.close();
            break;

        case 'ban':
            bannedIPs.add(targetUser.ip);
            targetWs.send(JSON.stringify({ type: 'error', message: 'You have been permanently IP banned.' }));
            targetWs.close();
            break;

        case 'mute':
            let muteUntil;
            if (duration === 'forever') {
                muteUntil = 'forever';
            } else {
                muteUntil = Date.now() + parseInt(duration);
            }
            mutedUsers.set(targetUsername, muteUntil);
            targetWs.send(JSON.stringify({ type: 'muted', duration: muteUntil }));
            break;
        default:
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown admin action.' }));
    }
    
    // Notify admin of successful action
    ws.send(JSON.stringify({ type: 'notification', message: `${targetUsername} has been ${action}ned/ed.` }));
}

// Broadcast user list
function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => u.username);
    broadcast({ type: 'userList', users: userList });
}

// Broadcast to all clients - logic remains the same
function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Generate unique ID - logic remains the same
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// REST API endpoints - logic remains the same
app.get('/api/channels', (req, res) => {
    res.json({ channels: Object.keys(channels) });
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
    if (!name || channels[name]) return res.status(400).json({ error: 'Invalid or duplicate channel name' });
    
    channels[name] = [];
    broadcast({ type: 'channelCreated', channel: name });
    res.json({ success: true, channel: name });
});

// Health check - logic remains the same
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        bannedIPs: bannedIPs.size,
        mutedUsers: mutedUsers.size
    });
});

// Start server - logic remains the same
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log(`Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`=================================`);
});

// Graceful shutdown - logic remains the same
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
