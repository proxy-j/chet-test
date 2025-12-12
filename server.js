// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Initialize App
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from the 'public' folder
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// --- Data Storage (In-Memory) ---
const channels = {
    general: [],
    random: [],
    gaming: [],
    memes: []
};

// Map: ws -> { username, ip, isAdmin, color }
const users = new Map();
// Map: username -> ws
const userSocketMap = new Map();
// Map: chatId -> [messages] (Not fully persistent in this basic version, but structure exists)
const privateChats = new Map();

// --- Admin & Security Storage ---
const bannedIPs = new Set();
const mutedUsers = new Map(); // username -> expiration timestamp (ms)
const ADMIN_PASS = 'nimda-1818';

// --- Helper Functions ---

// 1. Get Real IP (Works on Render/Heroku/Glitch)
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

// 2. Broadcast to all connected clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// 3. Update User List for UI
function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        isAdmin: u.isAdmin
    }));
    broadcast({ type: 'userList', users: userList });
}

// 4. Send Error to specific client
function sendError(ws, message) {
    ws.send(JSON.stringify({ type: 'error', message }));
}

// 5. Check if user is muted
function isMuted(username) {
    if (!mutedUsers.has(username)) return false;
    
    // Check if time has expired
    if (Date.now() > mutedUsers.get(username)) {
        mutedUsers.delete(username); // Remove expired mute
        return false;
    }
    return true;
}

// --- WebSocket Connection Logic ---
wss.on('connection', (ws, req) => {
    // Security: Check IP immediately on connection
    const ip = getClientIp(req);
    
    if (bannedIPs.has(ip)) {
        console.log(`Blocked connection from banned IP: ${ip}`);
        ws.send(JSON.stringify({ type: 'kicked' }));
        ws.close();
        return;
    }

    console.log(`New connection from IP: ${ip}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const user = users.get(ws);

            // Mute Check: Prevent messaging if muted
            const msgTypes = ['message', 'imageMessage', 'privateMessage', 'privateImageMessage'];
            if (msgTypes.includes(data.type)) {
                if (user && isMuted(user.username)) {
                    const expiry = mutedUsers.get(user.username);
                    const remainingMins = Math.ceil((expiry - Date.now()) / 60000);
                    return sendError(ws, `You are muted for ${remainingMins} more minutes.`);
                }
            }

            handleMessage(ws, data, ip);
        } catch (e) {
            console.error('Error handling message:', e);
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`${user.username} disconnected.`);
            userSocketMap.delete(user.username);
            users.delete(ws);
            broadcastUserList();
        }
    });
});

// --- Message Router ---
function handleMessage(ws, data, ip) {
    const user = users.get(ws);

    switch (data.type) {
        case 'join':
            // 1. Assign Name & Color
            let safeName = (data.username || "User").substring(0, 20).replace(/[^a-zA-Z0-9_-]/g, "");
            if (!safeName) safeName = "Anon";
            
            // Prevent duplicate names
            if (userSocketMap.has(safeName)) {
                safeName += Math.floor(Math.random() * 1000);
            }

            // Assign random avatar color
            const colors = ['#5865F2', '#EB459E', '#F2A900', '#3BA55D', '#ED4245', '#747f8d'];
            const userColor = colors[Math.floor(Math.random() * colors.length)];

            // Save user
            users.set(ws, { username: safeName, ip: ip, isAdmin: false, color: userColor });
            userSocketMap.set(safeName, ws);

            // Send success & history
            ws.send(JSON.stringify({
                type: 'history',
                messages: channels['general'] || [],
                username: safeName // Confirm final name to client
            }));
            
            broadcastUserList();
            break;

        case 'message':
            if (!user) return;
            const msg = {
                author: user.username,
                text: data.text,
                color: user.color,
                channel: data.channel,
                timestamp: Date.now()
            };
            
            if (channels[data.channel]) {
                channels[data.channel].push(msg);
                // Keep history limited to 50
                if (channels[data.channel].length > 50) channels[data.channel].shift();
                broadcast({ type: 'message', message: msg });
            }
            break;

        case 'imageMessage':
            if (!user) return;
            const imgMsg = {
                author: user.username,
                imageData: data.imageData,
                color: user.color,
                channel: data.channel,
                timestamp: Date.now(),
                isImage: true
            };
            if (channels[data.channel]) channels[data.channel].push(imgMsg);
            broadcast({ type: 'message', message: imgMsg });
            break;

        // --- ADMIN Logic ---
        case 'adminLogin':
            if (data.password === ADMIN_PASS) {
                if (user) user.isAdmin = true;
                ws.send(JSON.stringify({ type: 'adminSuccess' }));
                broadcastUserList(); // Refresh list so crown icons appear
            } else {
                sendError(ws, "Incorrect Password");
            }
            break;

        case 'adminAction':
            // Verify admin status
            if (!user || !user.isAdmin) return sendError(ws, "Unauthorized: You are not an admin.");

            const targetName = data.target;
            const targetWs = userSocketMap.get(targetName);
            const action = data.action; 
            const duration = data.duration || 0;

            console.log(`ADMIN ACTION: ${user.username} did ${action} to ${targetName}`);

            if (action === 'kick') {
                if (targetWs) {
                    targetWs.send(JSON.stringify({ type: 'kicked' })); // Client redirects to Google
                    targetWs.close();
                }
            } 
            else if (action === 'ban') {
                // Get IP of target
                let targetIp = null;
                if (targetWs) {
                    const tUser = users.get(targetWs);
                    if (tUser) targetIp = tUser.ip;
                }

                if (targetIp) {
                    bannedIPs.add(targetIp);
                    if (targetWs) {
                        targetWs.send(JSON.stringify({ type: 'kicked' }));
                        targetWs.close();
                    }
                    ws.send(JSON.stringify({ type: 'info', message: `IP ${targetIp} has been permanently banned.` }));
                } else {
                    sendError(ws, "Could not find target IP (user might be offline).");
                }
            } 
            else if (action === 'mute') {
                const ms = duration * 60 * 1000;
                mutedUsers.set(targetName, Date.now() + ms);
                
                if (targetWs) {
                    targetWs.send(JSON.stringify({ type: 'info', message: `You have been muted for ${duration} minutes.` }));
                }
                ws.send(JSON.stringify({ type: 'info', message: `User ${targetName} muted for ${duration} mins.` }));
            }
            break;

        // --- Private Chat Logic ---
        case 'privateChatRequest':
            const target = userSocketMap.get(data.targetUsername);
            if (target) {
                target.send(JSON.stringify({ 
                    type: 'privateChatRequest', 
                    from: user.username 
                }));
            } else {
                sendError(ws, "User is offline or not found.");
            }
            break;

        case 'privateChatResponse':
            const requester = userSocketMap.get(data.from);
            if (requester && data.accepted) {
                const chatId = `dm_${[user.username, data.from].sort().join('_')}`;
                
                // Notify requester
                requester.send(JSON.stringify({ 
                    type: 'privateChatAccepted', 
                    chatId: chatId, 
                    with: user.username 
                }));
                
                // Notify acceptor (self)
                ws.send(JSON.stringify({ 
                    type: 'privateChatAccepted', 
                    chatId: chatId, 
                    with: data.from 
                }));
            }
            break;

        case 'privateMessage':
            // Logic to send message to specific target
            // Note: In this simple version, client sends targetUsername
            // A more robust version would map chatId to users.
            const recipient = userSocketMap.get(data.targetUsername);
            
            const dmMsg = {
                chatId: data.chatId,
                author: user.username,
                text: data.text,
                color: user.color,
                timestamp: Date.now()
            };

            // Send to self
            ws.send(JSON.stringify({ type: 'privateMessage', message: dmMsg }));
            
            // Send to recipient
            if (recipient) {
                recipient.send(JSON.stringify({ type: 'privateMessage', message: dmMsg }));
            }
            break;
    }
}

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`The Chet Server running on port ${PORT}`);
});
