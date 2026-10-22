const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { SerialPort } = require("serialport");
const config = require("./config");

const app = express();
const uploadDir = path.join(__dirname, "uploads");
const logsDir = path.join(__dirname, "logs");
const usersFile = path.join(__dirname, "users.json");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

const sessions = new Map();
const jobs = new Map();
const queue = [];
let flashInProgress = false;
let workerRunning = false;
let serialConnection = null;
let serialOwner = null;
let serialTextBuffer = "";
let serialOpenedAt = null;
const SERIAL_BAUD_RATES = new Set([300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200, 230400]);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_QUEUE_PER_USER = 3;

function readUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, record) {
  if (!record || !record.salt || !record.passwordHash) return false;
  return safeEqual(hashPassword(password, record.salt), record.passwordHash);
}
function logEvent(event) {
  fs.appendFileSync(path.join(logsDir, "uploads.jsonl"), JSON.stringify(event) + "\n", "utf8");
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("=") || "");
  }
  return "";
}
function currentUser(req) {
  const token = getCookie(req, "ral_session");
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) { sessions.delete(token); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { username: session.username, role: session.role, token };
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Войдите в систему." });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ success: false, message: "Доступно только преподавателю." });
  next();
}
function requireCsrf(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      const host = req.headers.host;
      if (url.host !== host) return res.status(403).json({ success: false, message: "Запрос отклонён: источник не совпадает." });
    } catch (_) { return res.status(403).json({ success: false, message: "Некорректный источник запроса." }); }
  }
  next();
}
function getSerialPorts() {
  return new Promise((resolve, reject) => {
    const ps = `Get-CimInstance Win32_SerialPort | Select-Object DeviceID,Name | ConvertTo-Json -Compress`;
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(stderr || "Не удалось получить список COM-портов"));
      if (!stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(rows.filter(row => /^COM\d+$/i.test(String(row.DeviceID || "")))
          .map(row => ({ port: String(row.DeviceID).toUpperCase(), name: String(row.Name || row.DeviceID) }))
          .sort((a, b) => Number(a.port.slice(3)) - Number(b.port.slice(3))));
      } catch (error) { reject(new Error("Не удалось разобрать список COM-портов: " + error.message)); }
    });
  });
}
function findAvrdude() {
  const a = config.arduino, candidates = [];
  if (a.avrdudePath) candidates.push({ exe: a.avrdudePath, conf: a.avrdudeConfigPath });
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    candidates.push({ exe: path.join(root, "Arduino", "hardware", "tools", "avr", "bin", "avrdude.exe"), conf: path.join(root, "Arduino", "hardware", "tools", "avr", "etc", "avrdude.conf") });
    candidates.push({ exe: path.join(root, "Arduino IDE", "resources", "app", "lib", "backend", "resources", "avrdude", "windows", "avrdude.exe"), conf: path.join(root, "Arduino IDE", "resources", "app", "lib", "backend", "resources", "avrdude", "windows", "avrdude.conf") });
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const base = path.join(local, "Arduino15", "packages", "arduino", "tools", "avrdude");
    try {
      for (const version of fs.readdirSync(base).sort().reverse()) {
        const p = path.join(base, version);
        candidates.push({ exe: path.join(p, "bin", "avrdude.exe"), conf: path.join(p, "etc", "avrdude.conf") });
      }
    } catch (_) {}
  }
  for (const item of candidates) {
    if (item.exe && fs.existsSync(item.exe)) {
      let conf = item.conf;
      if ((!conf || !fs.existsSync(conf)) && item.exe) {
        const beside = path.resolve(path.dirname(item.exe), "..", "etc", "avrdude.conf");
        if (fs.existsSync(beside)) conf = beside;
      }
      if (conf && fs.existsSync(conf)) return { exe: item.exe, conf };
    }
  }
  return null;
}
function runAvrdude(hexPath, port, toolchain) {
  return new Promise((resolve, reject) => {
    const args = ["-C", toolchain.conf, "-v", "-p", config.arduino.mcu, "-c", config.arduino.programmer,
      "-P", port, "-b", String(config.arduino.baudRate), "-D", "-U", `flash:w:${hexPath}:i`];
    const child = spawn(toolchain.exe, args, { windowsHide: true, shell: false });
    let output = "", settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const collect = chunk => { output = (output + chunk.toString()).slice(-12000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", err => finish(new Error(`Не удалось запустить avrdude: ${err.message}`)));
    child.on("close", code => code === 0 ? finish(null, output) : finish(new Error(`avrdude завершился с кодом ${code}.\n${output}`)));
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Превышено время прошивки (${Math.round(config.arduino.flashTimeoutMs / 1000)} с).\n${output}`)); }, config.arduino.flashTimeoutMs);
  });
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}.hex`)
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => path.extname(file.originalname).toLowerCase() === ".hex"
    ? cb(null, true) : cb(new Error("Разрешены только файлы Intel HEX с расширением .hex"))
});

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: user.username, role: user.role });
});
app.post("/api/login", requireCsrf, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || password.length < 1 || password.length > 256) {
    return res.status(400).json({ success: false, message: "Введите имя пользователя и пароль." });
  }
  const user = readUsers().find(item => item.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ success: false, message: "Неверное имя пользователя или пароль." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username: user.username, role: user.role === "admin" ? "admin" : "student", expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader("Set-Cookie", `ral_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  logEvent({ time: new Date().toISOString(), action: "login", username: user.username });
  res.json({ success: true, username: user.username, role: user.role === "admin" ? "admin" : "student" });
});
app.post("/api/logout", requireAuth, requireCsrf, (req, res) => {
  sessions.delete(req.user.token);
  res.setHeader("Set-Cookie", "ral_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ success: true });
});

app.get("/api/status", requireAuth, (_req, res) => res.json({
  online: true, cameraConfigured: Boolean(config.cameraName), cameraName: config.cameraName,
  message: "Сервер лаборатории работает", maxUploadBytes: config.maxUploadBytes,
  flashInProgress, queueLength: queue.length, avrdudeAvailable: Boolean(findAvrdude()), baudRate: config.arduino.baudRate,
  serialOpen: Boolean(serialConnection && serialConnection.isOpen), serialOwner
}));
app.get("/api/ports", requireAuth, async (_req, res) => {
  try { res.json({ success: true, ports: await getSerialPorts() }); }
  catch (error) {
    console.error("Ошибка поиска COM-портов:", error.message);
    res.status(500).json({ success: false, message: "Не удалось получить COM-порты. Проверьте, что сервер запущен в Windows." });
  }
});
function publicJob(job) {
  return { id: job.id, username: job.username, originalName: job.originalName, port: job.port, size: job.size,
    status: job.status, createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    message: job.message || "", position: job.status === "queued" ? queue.findIndex(id => id === job.id) + 1 : 0,
    output: job.output || "" };
}

function serialStateFor(user) {
  if (!serialConnection || !serialConnection.isOpen) {
    return { open: false, owner: null, canControl: false, message: "Последовательный порт закрыт." };
  }
  const canControl = user.role === "admin" || user.username === serialOwner;
  return {
    open: true,
    port: serialConnection.path,
    baudRate: serialConnection.baudRate,
    owner: serialOwner,
    openedAt: serialOpenedAt,
    canControl,
    message: canControl ? "Порт открыт. Можно читать и отправлять данные." : "Порт занят другим пользователем."
  };
}
app.get("/api/serial/status", requireAuth, (req, res) => {
  res.json({ success: true, serial: serialStateFor(req.user) });
});
app.post("/api/serial/open", requireAuth, requireCsrf, async (req, res) => {
  if (serialConnection && serialConnection.isOpen) {
    return res.status(409).json({ success: false, message: `Порт уже открыт пользователем ${serialOwner}. Сначала он должен закрыть соединение.` });
  }
  const portName = String(req.body?.port || "").toUpperCase();
  const baudRate = Number(req.body?.baudRate || 9600);
  if (!/^COM\d+$/.test(portName)) return res.status(400).json({ success: false, message: "Выберите корректный COM-порт." });
  if (!SERIAL_BAUD_RATES.has(baudRate)) return res.status(400).json({ success: false, message: "Недопустимая скорость последовательного порта." });
  try {
    const available = await getSerialPorts();
    if (!available.some(p => p.port === portName)) return res.status(400).json({ success: false, message: `Порт ${portName} не найден.` });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Не удалось проверить COM-порт: " + error.message });
  }
  if (flashInProgress || queue.some(id => jobs.get(id)?.status === "queued")) {
    return res.status(409).json({ success: false, message: "Есть задания прошивки в очереди. Откройте последовательный порт после завершения очереди." });
  }
  const connection = new SerialPort({ path: portName, baudRate, autoOpen: false });
  connection.open(error => {
    if (error) return res.status(500).json({ success: false, message: `Не удалось открыть ${portName}: ${error.message}. Возможно, порт занят Arduino IDE или другим приложением.` });
    serialConnection = connection;
    serialOwner = req.user.username;
    serialTextBuffer = "";
    serialOpenedAt = new Date().toISOString();
    connection.on("data", chunk => {
      serialTextBuffer += chunk.toString("utf8");
      if (serialTextBuffer.length > 40000) serialTextBuffer = serialTextBuffer.slice(-40000);
    });
    connection.on("error", err => {
      serialTextBuffer += `\r\n[Ошибка последовательного порта: ${err.message}]\r\n`;
      if (serialTextBuffer.length > 40000) serialTextBuffer = serialTextBuffer.slice(-40000);
    });
    connection.on("close", () => {
      serialTextBuffer += "\r\n[Последовательный порт закрыт]\r\n";
      if (serialTextBuffer.length > 40000) serialTextBuffer = serialTextBuffer.slice(-40000);
      serialConnection = null;
      serialOwner = null;
      serialOpenedAt = null;
      processQueue();
    });
    logEvent({ time: serialOpenedAt, action: "serial_open", username: req.user.username, port: portName, baudRate });
    res.json({ success: true, serial: serialStateFor(req.user), message: `Порт ${portName} открыт на скорости ${baudRate}.` });
  });
});
app.get("/api/serial/read", requireAuth, (req, res) => {
  if (!serialConnection || !serialConnection.isOpen) {
    const text = serialTextBuffer;
    serialTextBuffer = "";
    return res.json({ success: true, open: false, text, message: "Последовательный порт закрыт." });
  }
  if (req.user.role !== "admin" && req.user.username !== serialOwner) {
    return res.status(403).json({ success: false, message: "Последовательный порт открыт другим пользователем." });
  }
  const text = serialTextBuffer;
  serialTextBuffer = "";
  res.json({ success: true, open: true, text });
});
app.post("/api/serial/write", requireAuth, requireCsrf, (req, res) => {
  if (!serialConnection || !serialConnection.isOpen) return res.status(409).json({ success: false, message: "Сначала откройте последовательный порт." });
  if (req.user.role !== "admin" && req.user.username !== serialOwner) return res.status(403).json({ success: false, message: "Порт открыт другим пользователем." });
  const data = String(req.body?.data ?? "");
  if (!data.length) return res.status(400).json({ success: false, message: "Введите данные для отправки." });
  if (data.length > 2048) return res.status(400).json({ success: false, message: "За один раз можно отправить не более 2048 символов." });
  serialConnection.write(data, "utf8", error => {
    if (error) return res.status(500).json({ success: false, message: "Ошибка записи: " + error.message });
    serialConnection.drain(drainError => {
      if (drainError) return res.status(500).json({ success: false, message: "Ошибка передачи: " + drainError.message });
      logEvent({ time: new Date().toISOString(), action: "serial_write", username: req.user.username, port: serialConnection.path, chars: data.length });
      res.json({ success: true, message: `Отправлено ${data.length} символов.` });
    });
  });
});
app.post("/api/serial/close", requireAuth, requireCsrf, (req, res) => {
  if (!serialConnection || !serialConnection.isOpen) return res.json({ success: true, message: "Порт уже закрыт." });
  if (req.user.role !== "admin" && req.user.username !== serialOwner) {
    return res.status(403).json({ success: false, message: "Закрыть порт может только пользователь, который его открыл, или преподаватель." });
  }
  const connection = serialConnection;
  connection.close(error => {
    if (error) return res.status(500).json({ success: false, message: "Не удалось закрыть порт: " + error.message });
    logEvent({ time: new Date().toISOString(), action: "serial_close", username: req.user.username, port: connection.path });
    res.json({ success: true, message: "Последовательный порт закрыт." });
  });
});

app.get("/api/jobs", requireAuth, (req, res) => {
  const mine = [...jobs.values()].filter(j => req.user.role === "admin" || j.username === req.user.username)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(publicJob);
  res.json({ success: true, jobs: mine, queueLength: queue.length, flashInProgress });
});
app.get("/api/jobs/:id", requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || (req.user.role !== "admin" && job.username !== req.user.username))
    return res.status(404).json({ success: false, message: "Задание не найдено." });
  res.json({ success: true, job: publicJob(job) });
});
app.post("/api/jobs/:id/cancel", requireAuth, requireCsrf, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || (req.user.role !== "admin" && job.username !== req.user.username))
    return res.status(404).json({ success: false, message: "Задание не найдено." });
  if (job.status !== "queued") return res.status(409).json({ success: false, message: "Можно отменить только задание, ожидающее очереди." });
  const idx = queue.indexOf(job.id);
  if (idx >= 0) queue.splice(idx, 1);
  job.status = "cancelled"; job.finishedAt = new Date().toISOString(); job.message = "Задание отменено.";
  fs.unlink(job.filePath, () => {});
  logEvent({ time: job.finishedAt, action: "flash_cancelled", jobId: job.id, username: job.username });
  res.json({ success: true, job: publicJob(job) });
});

app.post("/api/jobs", requireAuth, requireCsrf, (req, res, next) => {
  const count = [...jobs.values()].filter(j => j.username === req.user.username && ["queued", "running"].includes(j.status)).length;
  if (count >= MAX_QUEUE_PER_USER) return res.status(429).json({ success: false, message: `У вас уже есть ${MAX_QUEUE_PER_USER} активных задания. Дождитесь завершения.` });
  next();
}, upload.single("firmware"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Выберите файл .hex" });
  const port = String(req.body.port || "").toUpperCase();
  if (!/^COM\d+$/.test(port)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ success: false, message: "Выберите COM-порт." }); }
  let hex;
  try { hex = fs.readFileSync(req.file.path, "utf8"); }
  catch (_) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ success: false, message: "Не удалось прочитать HEX-файл." }); }
  const lines = hex.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length || lines.some(line => !/^:[0-9A-Fa-f]+$/.test(line) || line.length < 11) ||
      !lines.some(line => line.slice(7, 9).toUpperCase() === "01")) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: "Файл не похож на корректный Intel HEX. Выберите .hex, экспортированный Arduino IDE." });
  }
  const job = {
    id: crypto.randomUUID(), username: req.user.username, role: req.user.role, port,
    filePath: req.file.path, originalName: path.basename(req.file.originalname).slice(0, 180),
    size: req.file.size, status: "queued", message: "Задание добавлено в очередь.",
    createdAt: new Date().toISOString()
  };
  jobs.set(job.id, job); queue.push(job.id);
  logEvent({ time: job.createdAt, action: "flash_queued", jobId: job.id, username: job.username, port, originalName: job.originalName, size: job.size });
  res.status(202).json({ success: true, message: "Задание добавлено в очередь.", job: publicJob(job) });
  processQueue();
});

async function processQueue() {
  if (workerRunning || (serialConnection && serialConnection.isOpen)) return;
  workerRunning = true;
  try {
    while (queue.length) {
      if (serialConnection && serialConnection.isOpen) break;
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== "queued") continue;
      job.status = "running"; job.startedAt = new Date().toISOString(); job.message = "Прошивка выполняется. Не отключайте плату.";
      flashInProgress = true;
      logEvent({ time: job.startedAt, action: "flash_started", jobId: job.id, username: job.username, port: job.port, originalName: job.originalName, size: job.size });
      try {
        const available = await getSerialPorts();
        if (!available.some(p => p.port === job.port)) throw new Error(`Порт ${job.port} не найден. Проверьте подключение Arduino.`);
        const toolchain = findAvrdude();
        if (!toolchain) throw new Error("Не найден avrdude. Установите Arduino IDE или настройте пути в config.js.");
        const output = await runAvrdude(job.filePath, job.port, toolchain);
        job.status = "success"; job.message = `Прошивка успешно записана через ${job.port}.`; job.output = output.slice(-5000);
        logEvent({ time: new Date().toISOString(), action: "flash_success", jobId: job.id, username: job.username, port: job.port });
      } catch (error) {
        job.status = "failed"; job.message = error.message.slice(0, 3000); job.output = error.message.slice(-5000);
        logEvent({ time: new Date().toISOString(), action: "flash_failed", jobId: job.id, username: job.username, port: job.port, error: job.message });
      } finally {
        job.finishedAt = new Date().toISOString();
        flashInProgress = false;
        fs.unlink(job.filePath, () => {});
      }
    }
  } finally {
    workerRunning = false;
    flashInProgress = false;
    if (queue.length) processQueue();
  }
}

app.get("/camera", requireAuth, (req, res) => {
  const boundary = "ffmpeg";
  const args = ["-hide_banner", "-loglevel", "warning", "-f", "dshow", "-rtbufsize", config.inputBuffer,
    "-i", `video=${config.cameraName}`, "-an", "-vf", `scale=${config.outputWidth}:-1,fps=${config.frameRate}`,
    "-c:v", "mjpeg", "-q:v", String(config.jpegQuality), "-f", "mpjpeg", "-boundary_tag", boundary, "pipe:1"];
  let ffmpeg;
  try { ffmpeg = spawn(config.ffmpegPath, args, { windowsHide: true }); }
  catch (error) { console.error("Не удалось запустить FFmpeg:", error.message); return res.status(500).send("Не удалось запустить FFmpeg. Проверьте ffmpegPath в config.js."); }
  res.status(200);
  res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary=${boundary}`);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  let stderrText = "";
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", chunk => { stderrText = (stderrText + chunk.toString()).slice(-4000); });
  ffmpeg.on("error", error => { console.error("Ошибка запуска FFmpeg:", error.message); if (!res.headersSent) res.status(500).end("Ошибка запуска FFmpeg."); else res.end(); });
  ffmpeg.on("close", code => { if (code !== 0 && !res.destroyed) console.error(`FFmpeg завершился с кодом ${code}: ${stderrText}`); });
  const stop = () => { if (ffmpeg && ffmpeg.exitCode === null && !ffmpeg.killed) ffmpeg.kill(); };
  req.on("close", stop); res.on("close", stop);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? `Файл слишком большой. Максимум: ${Math.round(config.maxUploadBytes / 1048576)} МБ.` : "Ошибка загрузки файла.";
    return res.status(400).json({ success: false, message: msg });
  }
  res.status(400).json({ success: false, message: err.message || "Ошибка обработки запроса." });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Веб-сервер: http://localhost:${config.port}`);
  console.log(`Видеопоток: http://localhost:${config.port}/camera`);
  console.log(`Камера: ${config.cameraName}`);
  console.log(`FFmpeg: ${config.ffmpegPath}`);
  console.log(`Arduino Uno R3: ATmega328P, скорость загрузки ${config.arduino.baudRate}.`);
  console.log(`AVRDUDE: ${findAvrdude() ? findAvrdude().exe : "не найден — задайте пути в config.js"}`);
  console.log("Требуется вход в систему; сервер предназначен для доверенной сети Radmin VPN.");
});
