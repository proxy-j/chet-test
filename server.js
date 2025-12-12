// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public')); // Ensure index.html is in a 'public' folder
app.use(express.json({ limit: '10mb' }));

// --- Storage ---
const channels = { general: [], random: [], gaming: [], memes: [] };
const users = new Map();         // ws -> { username, ip, isAdmin }
const userSocketMap = new Map(); // username -> ws
const privateChats = new Map();  // chatId -> [messages]

// Admin Storage
const bannedIPs = new Set();
const mutedUsers = new Map(); // username -> expiration timestamp (Date.now() + ms)

const ADMIN_PASS = 'nimda-1818';

// --- Utils ---
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}
function broadcastUserList() {
    const list = Array.from(users.values()).map(u => u.username);
    broadcast({ type: 'userList', users: list });
}
function sendError(ws, msg) {
    ws.send(JSON.stringify({ type: 'error', message: msg }));
}

// --- WebSocket Logic ---
wss.on('connection', (ws, req) => {
    // 1. IP Ban Check
    const ip = req.socket.remoteAddress;
    
    // Simple check if IP is in banned list
    if (bannedIPs.has(ip)) {
        ws.send(JSON.stringify({ type: 'kicked' })); // Force redirect immediately
        ws.close();
        return;
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const user = users.get(ws);

            // 2. Mute Check (for chatting)
            if (['message', 'imageMessage', 'privateMessage'].includes(data.type)) {
                if (user && isMuted(user.username)) {
                    return sendError(ws, `You are muted. Wait for the timer to expire.`);
                }
            }

            handleMessage(ws, data, ip);
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            userSocketMap.delete(user.username);
            users.delete(ws);
            broadcastUserList();
        }
    });
});

function isMuted(username) {
    if (!mutedUsers.has(username)) return false;
    const expires = mutedUsers.get(username);
    if (Date.now() > expires) {
        mutedUsers.delete(username); // Expired
        return false;
    }
    return true;
}

function handleMessage(ws, data, ip) {
    const user = users.get(ws);

    switch (data.type) {
        case 'join':
            // Basic unique name check
            let name = data.username.substring(0, 20); // Limit length
            if (userSocketMap.has(name)) name += Math.floor(Math.random()*100);
            
            users.set(ws, { username: name, ip: ip, isAdmin: false });
            userSocketMap.set(name, ws);
            ws.send(JSON.stringify({ type: 'history', messages: channels['general'] || [] }));
            broadcastUserList();
            break;

        case 'message':
            if (!user) return;
            const msg = {
                author: user.username,
                text: data.text,
                channel: data.channel,
                timestamp: Date.now()
            };
            if (channels[data.channel]) {
                channels[data.channel].push(msg);
                if (channels[data.channel].length > 50) channels[data.channel].shift();
                broadcast({ type: 'message', message: msg });
            }
            break;

        case 'imageMessage':
            if (!user) return;
            const imgMsg = {
                author: user.username,
                imageData: data.imageData,
                channel: data.channel,
                timestamp: Date.now(),
                isImage: true
            };
            if (channels[data.channel]) channels[data.channel].push(imgMsg);
            broadcast({ type: 'message', message: imgMsg });
            break;

        // --- Admin Commands ---
        case 'adminLogin':
            if (data.password === ADMIN_PASS) {
                if(user) user.isAdmin = true;
                ws.send(JSON.stringify({ type: 'adminSuccess' }));
            } else {
                sendError(ws, 'Incorrect Password');
            }
            break;

        case 'adminAction':
            if (!user || !user.isAdmin) return sendError(ws, "Unauthorized");
            handleAdminAction(data);
            break;

        // --- Private Chat Handlers ---
        case 'privateChatRequest':
            const targetWs = userSocketMap.get(data.targetUsername);
            if (targetWs) {
                targetWs.send(JSON.stringify({ 
                    type: 'privateChatRequest', 
                    from: user.username 
                }));
            }
            break;
            
        case 'privateChatResponse':
            const reqWs = userSocketMap.get(data.from);
            if (reqWs && data.accepted) {
                const chatId = `dm_${[user.username, data.from].sort().join('_')}`;
                const payload = { type: 'privateChatAccepted', chatId, with: user.username };
                reqWs.send(JSON.stringify(payload)); // Tell requester
                
                // Tell responder (current user)
                ws.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: data.from }));
            }
            break;

        case 'privateMessage':
            // Check mute again specifically for DMs if desired
            if(isMuted(user.username)) return sendError(ws, "You are muted.");
            
            const dmTarget = userSocketMap.get(data.targetUsername);
            const dmMsg = {
                author: user.username,
                text: data.text,
                chatId: data.chatId,
                timestamp: Date.now()
            };
            ws.send(JSON.stringify({ type: 'privateMessage', message: dmMsg })); // Send to self
            if(dmTarget) dmTarget.send(JSON.stringify({ type: 'privateMessage', message: dmMsg })); // Send to target
            break;
    }
}

function handleAdminAction(data) {
    const { action, target, duration } = data;
    const targetSocket = userSocketMap.get(target);

    // Get target's data if they are online
    let targetIP = null;
    if (targetSocket) {
        const u = users.get(targetSocket);
        if (u) targetIP = u.ip;
    }

    console.log(`Admin Action: ${action} on ${target}`);

    if (action === 'kick') {
        if (targetSocket) {
            targetSocket.send(JSON.stringify({ type: 'kicked' }));
            targetSocket.close();
        }
    } 
    else if (action === 'ban') {
        if (targetIP) {
            bannedIPs.add(targetIP); // Add IP to ban list
            if (targetSocket) {
                targetSocket.send(JSON.stringify({ type: 'kicked' }));
                targetSocket.close();
            }
        }
    } 
    else if (action === 'mute') {
        // duration is in minutes, calculate ms
        const ms = duration * 60 * 1000;
        mutedUsers.set(target, Date.now() + ms);
        
        if (targetSocket) {
            sendError(targetSocket, `You have been muted for ${duration} minutes.`);
        }
    }
}

const PORT = 3000;
server.listen(PORT, () => console.log(`The Chet running on port ${PORT}`));
