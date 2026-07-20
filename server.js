const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const LASTSEEN_FILE = path.join(DATA_DIR, 'lastseen.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, '{}');
if (!fs.existsSync(CONTACTS_FILE)) fs.writeFileSync(CONTACTS_FILE, '{}');
if (!fs.existsSync(LASTSEEN_FILE)) fs.writeFileSync(LASTSEEN_FILE, '{}');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function conversationId(idA, idB) {
  return [idA, idB].sort().join('__');
}

function addContact(ownerId, contact) {
  const contacts = readJSON(CONTACTS_FILE, {});
  if (!contacts[ownerId]) contacts[ownerId] = [];
  const existing = contacts[ownerId].find(c => c.id === contact.id);
  if (existing) {
    existing.name = contact.name;
  } else {
    contacts[ownerId].push(contact);
  }
  writeJSON(CONTACTS_FILE, contacts);
}

function setLastSeen(userId) {
  const lastSeen = readJSON(LASTSEEN_FILE, {});
  lastSeen[userId] = Date.now();
  writeJSON(LASTSEEN_FILE, lastSeen);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- REST: история переписки ----------

app.get('/api/conversations/:userId', (req, res) => {
  const contacts = readJSON(CONTACTS_FILE, {})[req.params.userId] || [];
  const messages = readJSON(MESSAGES_FILE, {});

  const list = contacts.map(c => {
    const convId = conversationId(req.params.userId, c.id);
    const msgs = (messages[convId] || []).filter(m => !m.deleted);
    const last = msgs[msgs.length - 1] || null;
    const unread = msgs.filter(m => m.from === c.id && m.status !== 'read').length;
    return {
      userId: c.id,
      name: c.name,
      lastMessage: last ? last.text : null,
      lastFromMe: last ? last.from === req.params.userId : false,
      lastStatus: last && last.from === req.params.userId ? last.status : null,
      lastAt: last ? last.createdAt : 0,
      unread
    };
  }).sort((a, b) => b.lastAt - a.lastAt);

  res.json(list);
});

app.get('/api/messages/:userA/:userB', (req, res) => {
  const convId = conversationId(req.params.userA, req.params.userB);
  const messages = readJSON(MESSAGES_FILE, {});
  res.json(messages[convId] || []);
});

app.get('/api/lastseen/:userId', (req, res) => {
  const lastSeen = readJSON(LASTSEEN_FILE, {});
  res.json({ userId: req.params.userId, lastSeen: lastSeen[req.params.userId] || null });
});

// ---------- ПРИСУТСТВИЕ И СИГНАЛИНГ ----------

const online = new Map(); // userId -> { socketId, name }
const socketToUser = new Map();
const typingTimers = new Map(); // ключ `${fromId}_${toId}` -> timeout

function broadcastPresence() {
  const list = Array.from(online.entries()).map(([userId, info]) => ({ userId, name: info.name }));
  io.emit('presence:list', list);
}

io.on('connection', (socket) => {
  let myUserId = null;

  socket.on('presence:hello', ({ userId, name }) => {
    if (!userId || !name) return;
    myUserId = userId;
    online.set(userId, { socketId: socket.id, name: name.slice(0, 30) });
    socketToUser.set(socket.id, userId);
    broadcastPresence();
  });

  socket.on('presence:rename', ({ userId, name }) => {
    if (online.has(userId)) {
      online.get(userId).name = (name || '').slice(0, 30);
      broadcastPresence();
    }
  });

  // ---------- Сообщения ----------
  socket.on('message:send', ({ fromId, fromName, toId, toName, text }) => {
    if (!fromId || !toId || !text || !text.toString().trim()) return;

    const convId = conversationId(fromId, toId);
    const messages = readJSON(MESSAGES_FILE, {});
    if (!messages[convId]) messages[convId] = [];

    const targetOnline = online.get(toId);

    const msg = {
      id: nanoid(10),
      from: fromId,
      fromName: (fromName || 'Гость').slice(0, 30),
      text: text.toString().slice(0, 2000),
      createdAt: Date.now(),
      status: targetOnline ? 'delivered' : 'sent',
      reactions: [],
      deleted: false
    };
    messages[convId].push(msg);
    messages[convId] = messages[convId].slice(-2000);
    writeJSON(MESSAGES_FILE, messages);

    addContact(fromId, { id: toId, name: toName || 'Собеседник' });
    addContact(toId, { id: fromId, name: msg.fromName });

    if (targetOnline) {
      io.to(targetOnline.socketId).emit('message:new', { convWith: fromId, message: msg });
    }
    socket.emit('message:sent', { convWith: toId, message: msg });
  });

  // Получатель открыл чат — помечаем его сообщения как прочитанные
  socket.on('message:read', ({ readerId, otherId }) => {
    if (!readerId || !otherId) return;
    const convId = conversationId(readerId, otherId);
    const messages = readJSON(MESSAGES_FILE, {});
    const list = messages[convId] || [];
    let changed = false;
    list.forEach(m => {
      if (m.from === otherId && m.status !== 'read') {
        m.status = 'read';
        changed = true;
      }
    });
    if (changed) {
      writeJSON(MESSAGES_FILE, messages);
      const sender = online.get(otherId);
      if (sender) {
        io.to(sender.socketId).emit('message:status-bulk', { convWith: readerId, status: 'read' });
      }
    }
  });

  // ---------- "Печатает..." ----------
  socket.on('typing:start', ({ toId, fromId }) => {
    const target = online.get(toId);
    if (target) io.to(target.socketId).emit('typing:update', { fromId, typing: true });

    const key = `${fromId}_${toId}`;
    clearTimeout(typingTimers.get(key));
    typingTimers.set(key, setTimeout(() => {
      const t = online.get(toId);
      if (t) io.to(t.socketId).emit('typing:update', { fromId, typing: false });
    }, 4000));
  });
  socket.on('typing:stop', ({ toId, fromId }) => {
    const target = online.get(toId);
    if (target) io.to(target.socketId).emit('typing:update', { fromId, typing: false });
    clearTimeout(typingTimers.get(`${fromId}_${toId}`));
  });

  // ---------- Реакции ----------
  socket.on('message:react', ({ withId, messageId, userId, emoji }) => {
    if (!withId || !messageId || !userId) return;
    const convId = conversationId(myUserId || userId, withId);
    const messages = readJSON(MESSAGES_FILE, {});
    const list = messages[convId] || [];
    const msg = list.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = [];
    const existingIdx = msg.reactions.findIndex(r => r.userId === userId);
    if (existingIdx !== -1 && msg.reactions[existingIdx].emoji === emoji) {
      msg.reactions.splice(existingIdx, 1); // повторный тап тем же эмодзи — снять реакцию
    } else if (existingIdx !== -1) {
      msg.reactions[existingIdx].emoji = emoji;
    } else {
      msg.reactions.push({ userId, emoji });
    }
    writeJSON(MESSAGES_FILE, messages);

    [myUserId, withId].forEach(uid => {
      const t = online.get(uid);
      if (t) io.to(t.socketId).emit('message:reaction', { messageId, reactions: msg.reactions });
    });
  });

  // ---------- Удаление сообщения ----------
  socket.on('message:delete', ({ withId, messageId }) => {
    if (!withId || !messageId || !myUserId) return;
    const convId = conversationId(myUserId, withId);
    const messages = readJSON(MESSAGES_FILE, {});
    const list = messages[convId] || [];
    const msg = list.find(m => m.id === messageId);
    if (!msg || msg.from !== myUserId) return; // удалять можно только своё

    msg.deleted = true;
    msg.text = '';
    writeJSON(MESSAGES_FILE, messages);

    [myUserId, withId].forEach(uid => {
      const t = online.get(uid);
      if (t) io.to(t.socketId).emit('message:deleted', { messageId });
    });
  });

  // ---------- WebRTC сигналинг (аудиозвонки) ----------

  socket.on('call:invite', ({ toId, fromId, fromName, offer }) => {
    const target = online.get(toId);
    if (!target) {
      socket.emit('call:unavailable', { toId });
      return;
    }
    io.to(target.socketId).emit('call:incoming', { fromId, fromName, offer });
  });

  socket.on('call:answer', ({ toId, answer }) => {
    const target = online.get(toId);
    if (target) io.to(target.socketId).emit('call:answered', { answer });
  });

  socket.on('call:ice', ({ toId, candidate }) => {
    const target = online.get(toId);
    if (target) io.to(target.socketId).emit('call:ice', { candidate });
  });

  socket.on('call:decline', ({ toId }) => {
    const target = online.get(toId);
    if (target) io.to(target.socketId).emit('call:declined');
  });

  socket.on('call:end', ({ toId }) => {
    const target = online.get(toId);
    if (target) io.to(target.socketId).emit('call:ended');
  });

  socket.on('disconnect', () => {
    if (myUserId && online.get(myUserId)?.socketId === socket.id) {
      online.delete(myUserId);
      setLastSeen(myUserId);
      broadcastPresence();
    }
    socketToUser.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Altasalta запущен на порту ${PORT}`);
});
