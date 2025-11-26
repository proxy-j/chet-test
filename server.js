const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

const channels = { general: [], random: [], gaming: [] };
const users = new Map();
const privateChats = new Map();
const userSocketMap = new Map();

const MESSAGE_LIMIT = 2000;
const USERNAME_LIMIT = 30;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function generateUUID() {
  return crypto.randomUUID();
}

function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function sendToUser(username, message) {
  const ws = userSocketMap.get(username);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastUserList() {
  const userList = Array.from(users.values()).map(u => ({ username: u.username }));
  broadcast({ type: 'userList', users: userList });
}

wss.on('connection', (ws) => {
  ws.on('message', data => {
    try {
      handleMessage(ws, JSON.parse(data.toString()));
    } catch (e) {
      console.error('Message error:', e);
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

function handleMessage(ws, msg) {
  const handlers = {
    join: handleJoin,
    message: handleChatMessage,
    getHistory: handleGetHistory,
    typing: handleTyping,
    privateChatRequest: handlePrivateChatRequest,
    privateChatResponse: handlePrivateChatResponse,
    privateMessage: handlePrivateMessage,
    getPrivateHistory: handleGetPrivateHistory,
    addReaction: handleAddReaction,
    removeReaction: handleRemoveReaction
  };

  if (handlers[msg.type]) {
    handlers[msg.type](ws, msg);
  }
}

function handleJoin(ws, msg) {
  let { username, uuid } = msg;
  
  if (!username) username = 'Guest' + Math.floor(Math.random() * 1000);
  username = username.slice(0, USERNAME_LIMIT).trim();
  
  if (!uuid) uuid = generateUUID();

  users.set(ws, { username, uuid, joinedAt: Date.now() });
  userSocketMap.set(username, ws);

  ws.send(JSON.stringify({
    type: 'joined',
    username,
    uuid,
    channels: Object.keys(channels)
  }));

  broadcastUserList();
}

function handleChatMessage(ws, msg) {
  const user = users.get(ws);
  if (!user) return;

  let { channel, text, replyTo } = msg;
  
  if (!channel || typeof text !== 'string' || !text.trim()) return;
  if (text.length > MESSAGE_LIMIT) {
    return ws.send(JSON.stringify({ type: 'error', message: 'Message too long' }));
  }

  const chatMsg = {
    id: generateId(),
    author: user.username,
    text,
    channel,
    timestamp: new Date().toISOString(),
    replyTo: replyTo || null,
    reactions: {}
  };

  if (channels[channel]) {
    channels[channel].push(chatMsg);
    if (channels[channel].length > 200) channels[channel].shift();
  }

  broadcast({ type: 'message', message: chatMsg });
}

function handleGetHistory(ws, msg) {
  ws.send(JSON.stringify({
    type: 'history',
    channel: msg.channel,
    messages: channels[msg.channel] || []
  }));
}

function handleTyping(ws, msg) {
  const user = users.get(ws);
  if (!user) return;

  if (msg.isPrivate) {
    sendToUser(msg.targetUsername, {
      type: 'typing',
      username: user.username,
      isTyping: msg.isTyping,
      isPrivate: true
    });
  } else {
    broadcast({
      type: 'typing',
      username: user.username,
      channel: msg.channel,
      isTyping: msg.isTyping
    }, ws);
  }
}

function handlePrivateChatRequest(ws, msg) {
  const sender = users.get(ws);
  if (sender) {
    sendToUser(msg.targetUsername, {
      type: 'privateChatRequest',
      from: sender.username
    });
  }
}

function handlePrivateChatResponse(ws, msg) {
  const responder = users.get(ws);
  if (!responder) return;

  const reqWs = userSocketMap.get(msg.from);
  if (!reqWs) return;

  if (msg.accepted) {
    const chatId = `dm_${[msg.from, responder.username].sort().join('_')}`;
    if (!privateChats.has(chatId)) {
      privateChats.set(chatId, []);
    }

    reqWs.send(JSON.stringify({
      type: 'privateChatAccepted',
      chatId,
      with: responder.username
    }));

    ws.send(JSON.stringify({
      type: 'privateChatAccepted',
      chatId,
      with: msg.from
    }));
  } else {
    reqWs.send(JSON.stringify({
      type: 'privateChatRejected',
      by: responder.username
    }));
  }
}

function handlePrivateMessage(ws, msg) {
  const sender = users.get(ws);
  if (!sender) return;

  const { chatId, text, targetUsername, replyTo } = msg;
  
  if (!chatId || !text?.trim()) return;
  if (text.length > MESSAGE_LIMIT) {
    return ws.send(JSON.stringify({ type: 'error', message: 'Message too long' }));
  }

  const pm = {
    id: generateId(),
    author: sender.username,
    text,
    chatId,
    timestamp: new Date().toISOString(),
    replyTo,
    reactions: {}
  };

  if (!privateChats.has(chatId)) {
    privateChats.set(chatId, []);
  }

  privateChats.get(chatId).push(pm);

  ws.send(JSON.stringify({ type: 'privateMessage', message: pm }));
  sendToUser(targetUsername, { type: 'privateMessage', message: pm });
}

function handleGetPrivateHistory(ws, msg) {
  ws.send(JSON.stringify({
    type: 'privateHistory',
    chatId: msg.chatId,
    messages: privateChats.get(msg.chatId) || []
  }));
}

function handleAddReaction(ws, msg) {
  const user = users.get(ws);
  if (!user) return;

  const { messageId, emoji, channel, isPrivate, chatId } = msg;
  const msgList = isPrivate ? privateChats.get(chatId) : channels[channel];
  const message = msgList?.find(m => m.id === messageId);

  if (!message) return;

  if (!message.reactions) message.reactions = {};
  if (!message.reactions[emoji]) message.reactions[emoji] = [];

  if (!message.reactions[emoji].includes(user.username)) {
    message.reactions[emoji].push(user.username);
    broadcast({
      type: 'reactionUpdate',
      messageId,
      reactions: message.reactions,
      channel,
      isPrivate,
      chatId
    });
  }
}

function handleRemoveReaction(ws, msg) {
  const user = users.get(ws);
  if (!user) return;

  const { messageId, emoji, channel, isPrivate, chatId } = msg;
  const msgList = isPrivate ? privateChats.get(chatId) : channels[channel];
  const message = msgList?.find(m => m.id === messageId);

  if (!message?.reactions?.[emoji]) return;

  message.reactions[emoji] = message.reactions[emoji].filter(u => u !== user.username);
  if (!message.reactions[emoji].length) delete message.reactions[emoji];

  broadcast({
    type: 'reactionUpdate',
    messageId,
    reactions: message.reactions,
    channel,
    isPrivate,
    chatId
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: users.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});
