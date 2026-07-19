const express = require('express');
const multer = require('multer');
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
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');

// Создаём папки/файлы, если их нет
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(POSTS_FILE)) fs.writeFileSync(POSTS_FILE, '[]');
if (!fs.existsSync(CHAT_FILE)) fs.writeFileSync(CHAT_FILE, '[]');

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return [];
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- Загрузка файлов ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}_${nanoid(8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 МБ на файл
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только фото и видео'));
    }
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Список постов (новые сверху)
app.get('/api/posts', (req, res) => {
  const posts = readJSON(POSTS_FILE).sort((a, b) => b.createdAt - a.createdAt);
  res.json(posts);
});

// Загрузка нового поста
app.post('/api/upload', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

  const post = {
    id: nanoid(10),
    filename: req.file.filename,
    type: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
    caption: (req.body.caption || '').slice(0, 200),
    author: (req.body.author || 'Гость').slice(0, 30),
    createdAt: Date.now(),
    likes: 0
  };

  const posts = readJSON(POSTS_FILE);
  posts.push(post);
  writeJSON(POSTS_FILE, posts);

  io.emit('new-post', post);
  res.json(post);
});

// Лайк
app.post('/api/posts/:id/like', (req, res) => {
  const posts = readJSON(POSTS_FILE);
  const post = posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Не найдено' });
  post.likes = (post.likes || 0) + 1;
  writeJSON(POSTS_FILE, posts);
  io.emit('post-liked', { id: post.id, likes: post.likes });
  res.json(post);
});

// ---------- Чат ----------
io.on('connection', (socket) => {
  const history = readJSON(CHAT_FILE).slice(-100);
  socket.emit('chat-history', history);

  socket.on('chat-message', (msg) => {
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return;
    const chatMsg = {
      id: nanoid(8),
      author: (msg.author || 'Гость').toString().slice(0, 30),
      text: msg.text.toString().slice(0, 500),
      createdAt: Date.now()
    };
    const chat = readJSON(CHAT_FILE);
    chat.push(chatMsg);
    // храним только последние 500 сообщений
    const trimmed = chat.slice(-500);
    writeJSON(CHAT_FILE, trimmed);

    io.emit('chat-message', chatMsg);
  });
});

server.listen(PORT, () => {
  console.log(`A1tasalta запущен на порту ${PORT}`);
});
