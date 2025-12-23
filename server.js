const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve frontend files from the 'public' folder
app.use(express.static('public'));

// --- DATA STORAGE ---
// 1. THE FIX: Define userProfiles so the server doesn't crash
const userProfiles = {}; 

const history = {
    general: [],
    gaming: [],
    memes: []
};
const dmHistory = {}; // Key: chatId (sorted usernames), Value: Array of messages
const bannedIPs = new Set();
const bannedUsers = new Set();

// Track connected clients
// We store objects: { ws, username, uuid, ip, isAdmin, isVIP, isOwner, voiceChannel }
let clients = []; 

// Voice channel state: { general: ['User1'], gaming: [] }
const voiceChannels = {
    general: [],
    chill: [],
    gaming: []
};

// --- HELPER FUNCTIONS ---

function broadcast(data) {
    const msg = JSON.stringify(data);
    clients.forEach(c => {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    });
}

function broadcastToChannel(channel, data) {
    // In this simple app, we broadcast to everyone, but the frontend filters by UI.
    // For a real app, you'd filter by who is "in" the channel.
    broadcast(data);
}

function sendToUser(username, data) {
    const client = clients.find(c => c.username === username);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(data));
    }
}

function getChatId(user1, user2) {
    return [user1, user2].sort().join('-');
}

// --- WEBSOCKET CONNECTION ---

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Check Bans
    if (bannedIPs.has(ip)) {
        ws.send(JSON.stringify({ type: 'banned', message: 'Your IP is banned.' }));
        ws.close();
        return;
    }

    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data, ip);
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        const client = clients.find(c => c.ws === ws);
        if (client) {
            // Remove from voice if active
            if (client.voiceChannel) {
                handleLeaveVoice(ws, { channel: client.voiceChannel });
            }
            
            clients = clients.filter(c => c.ws !== ws);
            broadcast({ type: 'userList', users: getPublicUserList() });
        }
    });
});

// --- CORE MESSAGE HANDLER ---

function handleMessage(ws, data, ip) {
    // Basic Rate limiting could go here

    switch (data.type) {
        case 'join':
            handleJoin(ws, data, ip);
            break;
            
        case 'message':
            handleChannelMessage(ws, data);
            break;

        case 'privateMessage':
            handlePrivateMessage(ws, data);
            break;

        case 'updateProfile':
            // SAVE PROFILE COLOR
            if (ws.username) {
                userProfiles[ws.username] = data.profileColor;
            }
            break;

        case 'getHistory':
            if (history[data.channel]) {
                ws.send(JSON.stringify({ type: 'history', channel: data.channel, messages: history[data.channel] }));
            }
            break;

        case 'getPrivateHistory':
            if (dmHistory[data.chatId]) {
                ws.send(JSON.stringify({ type: 'privateHistory', chatId: data.chatId, messages: dmHistory[data.chatId] }));
            }
            break;
        
        // --- REACTIONS ---
        case 'addReaction':
        case 'removeReaction':
            handleReaction(ws, data);
            break;

        // --- DM REQUESTS ---
        case 'privateChatRequest':
            // Relay request to target
            sendToUser(data.targetUsername, { 
                type: 'privateChatRequest', 
                from: ws.username 
            });
            break;

        case 'privateChatResponse':
            // Create the chat ID and notify both
            if (data.accepted) {
                const chatId = getChatId(ws.username, data.from);
                // Notify sender (the one who accepted)
                ws.send(JSON.stringify({ type: 'privateChatAccepted', with: data.from, chatId }));
                // Notify requester
                sendToUser(data.from, { type: 'privateChatAccepted', with: ws.username, chatId });
            } else {
                sendToUser(data.from, { type: 'privateChatRejected', by: ws.username });
            }
            break;

        // --- VOICE CHAT ---
        case 'joinVoice':
            handleJoinVoice(ws, data);
            break;
        case 'leaveVoice':
            handleLeaveVoice(ws, data);
            break;
        case 'voiceOffer':
        case 'voiceAnswer':
        case 'voiceIceCandidate':
            // Signaling: just forward to the specific user
            if (data.to) {
                sendToUser(data.to, { ...data, from: ws.username });
            }
            break;

        // --- ADMIN COMMANDS ---
        default:
            if (data.type.startsWith('admin')) {
                handleAdminCommand(ws, data);
            }
            break;
    }
}

// --- SPECIFIC HANDLERS ---

function handleJoin(ws, data, ip) {
    if (!data.username) return;
    
    // Check if user is banned
    if (bannedUsers.has(data.username)) {
        ws.send(JSON.stringify({ type: 'banned', message: 'This username is banned.' }));
        ws.close();
        return;
    }

    // Sanitize username
    const username = data.username.slice(0, 30);
    
    // Handle Roles
    let isAdmin = false;
    let isOwner = false;
    let isVIP = false;

    if (data.ownerPassword === '10owna12') { isOwner = true; isAdmin = true; }
    else if (data.adminPassword === 'mod-is-rly-awesome') { isAdmin = true; }
    else if (data.vipPassword === 'very-important-person') { isVIP = true; }

    // Store Client
    ws.username = username;
    ws.uuid = data.uuid || Date.now().toString(); // Simple UUID if none
    ws.isAdmin = isAdmin;
    ws.isOwner = isOwner;
    ws.isVIP = isVIP;

    // Check for existing connection with same username and remove it (kick old session)
    clients = clients.filter(c => c.username !== username);
    
    clients.push({ ws, username, uuid: ws.uuid, ip, isAdmin, isVIP, isOwner });

    // Send success packet
    ws.send(JSON.stringify({ 
        type: 'joined', 
        uuid: ws.uuid, 
        isAdmin, 
        isVIP, 
        isOwner 
    }));

    // Broadcast updated user list
    broadcast({ type: 'userList', users: getPublicUserList() });
    
    // Announce
    broadcast({ type: 'message', message: {
        id: Date.now(),
        channel: 'general',
        text: `${username} has joined the server.`,
        author: 'System',
        isSystem: true,
        timestamp: Date.now()
    }});
}

function handleChannelMessage(ws, data) {
    if (!ws.username) return;

    // Rate limit or validations could go here

    const message = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        channel: data.channel,
        text: data.text,
        author: ws.username,
        timestamp: Date.now(),
        // THE FIX IS HERE: Safe access to userProfiles
        profileColor: userProfiles[ws.username] || 'default',
        isAdmin: ws.isAdmin || false,
        isVIP: ws.isVIP || false,
        isOwner: ws.isOwner || false,
        replyTo: data.replyTo,
        imageUrl: data.imageUrl,
        reactions: {}
    };

    if (!history[data.channel]) history[data.channel] = [];
    history[data.channel].push(message);
    
    // Keep history manageable (last 50 messages)
    if (history[data.channel].length > 50) history[data.channel].shift();

    broadcast({ type: 'message', message });
}

function handlePrivateMessage(ws, data) {
    const chatId = data.chatId;
    const message = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        chatId: chatId,
        text: data.text,
        author: ws.username,
        timestamp: Date.now(),
        profileColor: userProfiles[ws.username] || 'default',
        replyTo: data.replyTo,
        imageUrl: data.imageUrl,
        reactions: {}
    };

    if (!dmHistory[chatId]) dmHistory[chatId] = [];
    dmHistory[chatId].push(message);

    // Send to Sender
    ws.send(JSON.stringify({ type: 'privateMessage', message }));
    // Send to Receiver
    sendToUser(data.targetUsername, { type: 'privateMessage', message });
}

function handleReaction(ws, data) {
    // Find message in history
    let msgList;
    if (data.isPrivate) {
        msgList = dmHistory[data.chatId];
    } else {
        msgList = history[data.channel];
    }

    if (!msgList) return;
    const msg = msgList.find(m => m.id === data.messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[data.emoji]) msg.reactions[data.emoji] = [];

    if (data.type === 'addReaction') {
        if (!msg.reactions[data.emoji].includes(ws.username)) {
            msg.reactions[data.emoji].push(ws.username);
        }
    } else {
        msg.reactions[data.emoji] = msg.reactions[data.emoji].filter(u => u !== ws.username);
        if (msg.reactions[data.emoji].length === 0) delete msg.reactions[data.emoji];
    }

    // Broadcast update
    if (data.isPrivate) {
         // Notify both participants of the DM
         const partner = data.chatId.replace(ws.username, '').replace('-', ''); // Rough way to find partner
         ws.send(JSON.stringify({ type: 'reactionUpdate', ...data, reactions: msg.reactions }));
         sendToUser(partner, { type: 'reactionUpdate', ...data, reactions: msg.reactions });
    } else {
        broadcast({ type: 'reactionUpdate', ...data, reactions: msg.reactions });
    }
}

// --- VOICE LOGIC ---

function handleJoinVoice(ws, data) {
    const { channel } = data;
    if (!voiceChannels[channel]) voiceChannels[channel] = [];
    
    // Add to channel if not there
    if (!voiceChannels[channel].includes(ws.username)) {
        voiceChannels[channel].push(ws.username);
    }
    
    // Update client state
    const client = clients.find(c => c.ws === ws);
    if (client) client.voiceChannel = channel;

    // Broadcast new user list for this voice channel
    broadcast({ type: 'voiceUsers', channel, users: voiceChannels[channel] });
}

function handleLeaveVoice(ws, data) {
    const { channel } = data;
    if (!voiceChannels[channel]) return;

    voiceChannels[channel] = voiceChannels[channel].filter(u => u !== ws.username);
    
    const client = clients.find(c => c.ws === ws);
    if (client) client.voiceChannel = null;

    broadcast({ type: 'voiceUsers', channel, users: voiceChannels[channel] });
    broadcast({ type: 'voiceUserLeft', username: ws.username });
}

// --- ADMIN LOGIC ---

function handleAdminCommand(ws, data) {
    if (!ws.isAdmin && !ws.isOwner) return;

    const target = data.targetUsername;

    switch (data.type) {
        case 'adminKick':
            sendToUser(target, { type: 'kicked', message: data.reason || 'You have been kicked.' });
            // Close connection for target
            const targetClient = clients.find(c => c.username === target);
            if (targetClient) targetClient.ws.close();
            break;

        case 'adminBan':
            bannedUsers.add(target);
            if (data.banType === 'ip') {
                const tc = clients.find(c => c.username === target);
                if (tc) bannedIPs.add(tc.ip);
            }
            sendToUser(target, { type: 'banned', message: data.reason || 'You have been banned.' });
             const tcBan = clients.find(c => c.username === target);
            if (tcBan) tcBan.ws.close();
            break;

        case 'adminBroadcast':
            broadcast({ type: 'broadcast', message: data.message });
            break;

        case 'adminClearChat':
            if (history[data.channel]) history[data.channel] = [];
            broadcast({ type: 'chatCleared', channel: data.channel });
            break;
        
        case 'adminGetBanList':
            ws.send(JSON.stringify({ 
                type: 'banList', 
                bannedUsers: Array.from(bannedUsers), 
                bannedIPs: Array.from(bannedIPs) 
            }));
            break;

        case 'adminUnban':
            bannedUsers.delete(data.username);
            ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Unbanned ${data.username}` }));
            handleAdminCommand(ws, { type: 'adminGetBanList' }); // Refresh list
            break;
        
        // --- TROLL COMMANDS ---
        case 'adminSpinScreen':
        case 'adminShakeScreen':
        case 'adminFlipScreen':
        case 'adminInvertColors':
        case 'adminRainbow':
        case 'adminBlur':
        case 'adminMatrix':
        case 'adminEmojiSpam':
        case 'adminRickRoll':
        case 'adminForceDisconnect':
            // Send the exact same type back to the target client
            // The frontend has handlers for these type names (e.g., spinScreen)
            // We strip 'admin' from the start to match frontend handler keys usually,
            // OR we check the frontend code. 
            // Looking at frontend: it handles "spinScreen", "shakeScreen".
            // So we need to convert "adminSpinScreen" -> "spinScreen".
            
            const effectType = data.type.replace('admin', ''); // e.g. "SpinScreen"
            const effectCmd = effectType.charAt(0).toLowerCase() + effectType.slice(1); // "spinScreen"
            
            sendToUser(target, { type: effectCmd });
            break;

        case 'adminConfetti':
            broadcast({ type: 'confetti' });
            break;
            
        case 'adminForceMute':
            sendToUser(target, { type: 'forceMute', duration: data.duration });
            break;
            
        case 'adminTimeout':
             sendToUser(target, { type: 'timedOut', message: 'You have been timed out.' });
             // In a real app you'd prevent them from sending messages for X seconds here
             break;
    }
}

function getPublicUserList() {
    return clients.map(c => ({
        username: c.username,
        isAdmin: c.isAdmin,
        isVIP: c.isVIP,
        isOwner: c.isOwner
    }));
}

// --- KEEP ALIVE ---
const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`The Chet Server is running on port ${PORT}`);
});
