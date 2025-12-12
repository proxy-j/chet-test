// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const ADMIN_PASS = 'nimda-1818'; // CHANGE THIS IN PRODUCTION
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
const users = new Map(); // ws -> { username, id, ip, isAdmin, isMuted }
const userSocketMap = new Map(); // username -> ws

// IP Banning Storage
// Map of IP Address -> Last Known Username (for display purposes)
const bannedIPs = new Map(); 

const mutedUsers = new Map(); // username -> expirationTimestamp
const privateChats = new Map();

// WebSocket connection handler
// We add 'req' here to get the IP address
wss.on('connection', (ws, req) => {
    // 1. Get IP Address
    // Handles proxies (x-forwarded-for) or direct connections
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // 2. Immediate Ban Check
    if (bannedIPs.has(ip)) {
        console.log(`Blocked connection from banned IP: ${ip}`);
        ws.send(JSON.stringify({ type: 'kick', url: KICK_URL, reason: 'Your IP is permanently banned.' }));
        ws.close();
        return;
    }

    console.log(`New client connected from ${ip}`);
    
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to server'
    }));
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            // Pass IP to handlers if needed
            handleMessage(ws, message, ip);
        } catch (error) {
            console.error('Error parsing message:', error);
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
});

// Helper function to check if a user is currently muted
function isUserMuted(username) {
    const expires = mutedUsers.get(username);
    if (!expires) return false;
    
    if (expires > Date.now()) {
        return true;
    } else {
        mutedUsers.delete(username);
        return false;
    }
}

function handleMessage(ws, message, ip) {
    switch (message.type) {
        case 'join':
            handleJoin(ws, message, ip);
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
    }
}

// --- Admin Handlers ---

function handleAdminLogin(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    if (message.password === ADMIN_PASS) {
        user.isAdmin = true;
        ws.send(JSON.stringify({
            type: 'adminStatus',
            isAdmin: true,
            username: user.username
        }));
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
    if (!adminUser || !adminUser.isAdmin) return;

    const { targetUsername, action, duration } = message;
    
    // Find the target user's socket and data
    const targetWs = userSocketMap.get(targetUsername);
    const targetUser = targetWs ? users.get(targetWs) : null;

    // For unbanning, we might not have a live socket
    if (!targetUser && action !== 'unban') {
        ws.send(JSON.stringify({ type: 'error', message: 'User not found or offline.' }));
        return;
    }

    const broadcastMessage = {
        type: 'systemNotification',
        channel: adminUser.username,
        text: `${adminUser.username} performed action: ${action} on ${targetUsername}.`
    };
    broadcast(broadcastMessage);

    switch (action) {
        case 'kick':
            if (targetWs) {
                targetWs.send(JSON.stringify({ type: 'kick', url: KICK_URL }));
                targetWs.close(1000, 'Kicked by admin');
            }
            break;

        case 'ban':
            if (targetUser) {
                // ADD IP TO BAN LIST
                bannedIPs.set(targetUser.ip, targetUser.username);
                console.log(`Banning IP: ${targetUser.ip} (User: ${targetUsername})`);

                targetWs.send(JSON.stringify({ type: 'kick', url: KICK_URL, reason: 'You have been permanently IP banned.' }));
                targetWs.close(1000, 'IP Banned');
            }
            break;
            
        case 'unban':
            // To unban, we need to find the IP associated with this username in our ban list
            let ipToRemove = null;
            for (const [ip, name] of bannedIPs.entries()) {
                if (name === targetUsername) {
                    ipToRemove = ip;
                    break;
                }
            }

            if (ipToRemove) {
                bannedIPs.delete(ipToRemove);
                console.log(`Unbanned IP: ${ipToRemove}`);
            }
            break;

        case 'mute':
            let durationMs = 0;
            switch (duration) {
                case '1m': durationMs = 60000; break;
                case '5m': durationMs = 300000; break;
                case 'forever': durationMs = Infinity; break;
            }
            if (durationMs > 0) {
                mutedUsers.set(targetUsername, durationMs === Infinity ? Infinity : Date.now() + durationMs);
                if (targetWs) targetWs.send(JSON.stringify({ type: 'muteStatus', isMuted: true, duration }));
            }
            break;

        case 'unmute':
            mutedUsers.delete(targetUsername);
            if (targetWs) targetWs.send(JSON.stringify({ type: 'muteStatus', isMuted: false }));
            break;
    }
    broadcastUserList();
}


// --- User Joins ---
function handleJoin(ws, message, ip) {
    const { username } = message;
    
    users.set(ws, {
        username,
        id: generateId(),
        ip: ip, // Store IP in user object
        isAdmin: false,
        isMuted: isUserMuted(username)
    });
    
    userSocketMap.set(username, ws);

    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels),
        isMuted: isUserMuted(username) 
    }));

    broadcastUserList();
}

// --- Chat Message Handlers ---
function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user || isUserMuted(user.username)) return;

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

function handleImageMessage(ws, message) {
    const user = users.get(ws);
    if (!user || isUserMuted(user.username)) return;

    const { channel, imageData, fileName } = message;
    const imageMessage = {
        id: generateId(),
        author: user.username,
        imageData,
        fileName,
        channel,
        timestamp: new Date().toISOString(),
        isImage: true
    };

    if (channels[channel]) {
        channels[channel].push(imageMessage);
        if (channels[channel].length > 100) channels[channel].shift();
    }

    broadcast({ type: 'message', message: imageMessage });
}

// ... Private Chat Handlers (No changes needed, kept for functionality) ...
function handlePrivateImageMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;
    const { chatId, imageData, fileName, targetUsername } = message;
    const imageMessage = { id: generateId(), author: sender.username, imageData, fileName, chatId, timestamp: new Date().toISOString(), isImage: true };
    if (!privateChats.has(chatId)) privateChats.set(chatId, []);
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(imageMessage);
    if (chatMessages.length > 100) chatMessages.shift();
    const targetWs = userSocketMap.get(targetUsername);
    const messageData = { type: 'privateMessage', message: imageMessage };
    ws.send(JSON.stringify(messageData));
    if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(JSON.stringify(messageData));
}

function handlePrivateChatRequest(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;
    const { targetUsername } = message;
    const targetWs = userSocketMap.get(targetUsername);
    if (!targetWs) return;
    targetWs.send(JSON.stringify({ type: 'privateChatRequest', from: sender.username }));
}

function handlePrivateChatResponse(ws, message) {
    const responder = users.get(ws);
    if (!responder) return;
    const { accepted, from } = message;
    const requesterWs = userSocketMap.get(from);
    if (!requesterWs) return;
    if (accepted) {
        const users = [from, responder.username].sort();
        const chatId = `private_${users[0]}_${users[1]}`;
        if (!privateChats.has(chatId)) privateChats.set(chatId, []);
        requesterWs.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: responder.username }));
        ws.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: from }));
    } else {
        requesterWs.send(JSON.stringify({ type: 'privateChatRejected', by: responder.username }));
    }
}

function handlePrivateMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;
    const { chatId, text, targetUsername } = message;
    const privateMessage = { id: generateId(), author: sender.username, text, chatId, timestamp: new Date().toISOString() };
    if (!privateChats.has(chatId)) privateChats.set(chatId, []);
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(privateMessage);
    if (chatMessages.length > 100) chatMessages.shift();
    const targetWs = userSocketMap.get(targetUsername);
    const messageData = { type: 'privateMessage', message: privateMessage };
    ws.send(JSON.stringify(messageData));
    if (targetWs && targetWs.readyState === WebSocket.OPEN) targetWs.send(JSON.stringify(messageData));
}

function handleGetPrivateHistory(ws, message) {
    ws.send(JSON.stringify({ type: 'privateHistory', chatId: message.chatId, messages: privateChats.get(message.chatId) || [] }));
}

function handleGetHistory(ws, message) {
    ws.send(JSON.stringify({ type: 'history', channel: message.channel, messages: channels[message.channel] || [] }));
}

function handleTyping(ws, message) {
    const user = users.get(ws);
    if (!user || (isUserMuted(user.username) && !message.isPrivate)) return;
    const { channel, isTyping, isPrivate, targetUsername } = message;
    if (isPrivate && targetUsername) {
        const targetWs = userSocketMap.get(targetUsername);
        if (targetWs) targetWs.send(JSON.stringify({ type: 'typing', username: user.username, channel, isTyping, isPrivate: true }));
    } else {
        broadcast({ type: 'typing', username: user.username, channel, isTyping }, ws);
    }
}

function broadcastUserList() {
    const onlineUsers = Array.from(users.values()).map(u => ({
        username: u.username,
        isAdmin: u.isAdmin || false,
        isMuted: isUserMuted(u.username)
    }));
    
    // Include Banned IPs in the list (mapped to last username) for Admin visibility
    const bannedList = Array.from(bannedIPs.values()).map(username => ({
        username,
        isAdmin: false,
        isMuted: false,
        isBanned: true
    }));

    // Filter duplicates (if a user was banned but the object is lingering in the online list for a split second)
    const allUsers = [...onlineUsers];
    bannedList.forEach(banned => {
        if (!allUsers.find(u => u.username === banned.username)) {
            allUsers.push(banned);
        }
    });
        
    const sortedList = allUsers.sort((a, b) => {
        if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
        return a.username.localeCompare(b.username);
    });

    broadcast({ type: 'userList', users: sortedList });
}

function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// REST APIs
app.get('/api/channels', (req, res) => res.json({ channels: Object.keys(channels) }));
app.get('/health', (req, res) => res.json({ status: 'ok', users: users.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Password: ${ADMIN_PASS}`);
});
