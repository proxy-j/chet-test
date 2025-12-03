const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const users = new Map();
const messages = {
  general: [],
  gaming: [],
  memes: []
};
const dms = new Map();
const timeouts = new Map();
const mutes = new Map();
const bans = new Set();

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let username = null;
  let role = 'user';

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'join':
          if (bans.has(ip)) {
            ws.send(JSON.stringify({ type: 'error', message: 'You are banned' }));
            ws.close();
            return;
          }

          username = message.username;
          role = message.role || 'user';
          
          users.set(ws, { username, role, ip });
          
          // Send current users list to all clients
          broadcastUsers();
          
          // Send message history
          Object.keys(messages).forEach(channel => {
            messages[channel].forEach(msg => {
              ws.send(JSON.stringify(msg));
            });
          });
          break;

        case 'message':
          if (!username) return;
          
          // Check if user is timed out
          if (timeouts.has(username)) {
            const timeoutEnd = timeouts.get(username);
            if (Date.now() < timeoutEnd) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'You are timed out'
              }));
              return;
            } else {
              timeouts.delete(username);
            }
          }

          // Check if user is muted
          if (mutes.has(username)) {
            const muteEnd = mutes.get(username);
            if (Date.now() < muteEnd) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'You are muted'
              }));
              return;
            } else {
              mutes.delete(username);
            }
          }

          const msgData = {
            type: 'message',
            username,
            message: message.message,
            timestamp: Date.now(),
            channel: message.channel,
            from: username,
            to: message.to
          };

          if (message.channel) {
            // Channel message
            if (!messages[message.channel]) {
              messages[message.channel] = [];
            }
            messages[message.channel].push(msgData);
            
            // Broadcast to all users
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(msgData));
              }
            });
          } else if (message.to) {
            // Direct message
            const dmKey = [username, message.to].sort().join('-');
            if (!dms.has(dmKey)) {
              dms.set(dmKey, []);
            }
            dms.get(dmKey).push(msgData);

            // Send to recipient
            wss.clients.forEach(client => {
              const user = users.get(client);
              if (user && (user.username === message.to || user.username === username)) {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(msgData));
                }
              }
            });
          }
          break;

        case 'timeout':
          if (role !== 'admin' && role !== 'owner') return;
          
          const timeoutDuration = message.duration * 1000;
          timeouts.set(message.username, Date.now() + timeoutDuration);
          
          // Notify the timed out user
          wss.clients.forEach(client => {
            const user = users.get(client);
            if (user && user.username === message.username) {
              client.send(JSON.stringify({
                type: 'timeout',
                duration: message.duration
              }));
            }
          });
          break;

        case 'mute':
          if (role !== 'admin' && role !== 'owner') return;
          
          const target = message.target;
          const targetUser = Array.from(users.values()).find(u => u.username === target);
          
          if (targetUser && targetUser.role === 'owner') {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Cannot mute the owner'
            }));
            return;
          }
          
          const muteDuration = message.duration * 1000;
          const muteEnd = Date.now() + muteDuration;
          mutes.set(target, muteEnd);
          
          // Notify all users
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'mute',
                username: target,
                until: muteEnd
              }));
            }
          });
          break;

        case 'ban':
          if (role !== 'admin' && role !== 'owner') return;
          
          const banTarget = message.target;
          const banTargetUser = Array.from(users.values()).find(u => u.username === banTarget);
          
          if (banTargetUser && banTargetUser.role === 'owner') {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Cannot ban the owner'
            }));
            return;
          }
          
          if (banTargetUser) {
            bans.add(banTargetUser.ip);
            
            // Disconnect the banned user
            wss.clients.forEach(client => {
              const user = users.get(client);
              if (user && user.username === banTarget) {
                client.send(JSON.stringify({
                  type: 'banned',
                  message: 'You have been banned'
                }));
                client.close();
              }
            });
          }
          break;

        case 'join-voice':
          // WebRTC signaling would go here
          // This is a simplified version
          break;
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    users.delete(ws);
    broadcastUsers();
  });
});

function broadcastUsers() {
  const userList = Array.from(users.values()).map(u => ({
    username: u.username,
    role: u.role
  }));

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'users',
        users: userList
      }));
    }
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Discord Clone Server running on port ${PORT}`);
});
