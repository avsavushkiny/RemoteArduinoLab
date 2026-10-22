const statusEl = document.getElementById("serverStatus");
const loginPanel = document.getElementById("loginPanel");
const labContent = document.getElementById("labContent");
const loginForm = document.getElementById("loginForm");
const loginResult = document.getElementById("loginResult");
const logoutButton = document.getElementById("logoutButton");
const camera = document.getElementById("camera");
const cameraError = document.getElementById("cameraError");
const form = document.getElementById("uploadForm");
const result = document.getElementById("uploadResult");
const portSelect = document.getElementById("serialPort");
const portStatus = document.getElementById("portStatus");
const refreshPortsButton = document.getElementById("refreshPorts");
const jobsList = document.getElementById("jobsList");
const queueSummary = document.getElementById("queueSummary");
const refreshJobsButton = document.getElementById("refreshJobs");
let currentRole = "student";
let jobsTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  if (response.status === 401) {
    showLogin();
    throw new Error(body.message || "Сессия завершена. Войдите снова.");
  }
  if (!response.ok) throw new Error(body.message || `Ошибка HTTP ${response.status}`);
  return body;
}
function showLogin() {
  loginPanel.hidden = false;
  labContent.hidden = true;
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = null;
  camera.removeAttribute("src");
}
async function showLab(user) {
  loginPanel.hidden = true;
  labContent.hidden = false;
  currentRole = user.role;
  document.getElementById("whoami").textContent = user.username;
  document.getElementById("roleBadge").textContent = user.role === "admin" ? "преподаватель" : "студент";
  statusEl.textContent = "Вы вошли в систему";
  camera.src = `/camera?ts=${Date.now()}`;
  await refreshPorts();
  await refreshJobs();
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = setInterval(refreshJobs, 3000);
  refreshStatus();
}
async function checkSession() {
  try {
    const data = await api("/api/me");
    if (data.authenticated) await showLab(data);
    else { showLogin(); statusEl.textContent = "Войдите, чтобы пользоваться лабораторией"; }
  } catch (e) { showLogin(); statusEl.textContent = "Не удалось проверить сессию"; }
}
loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  loginResult.textContent = "Проверка учётных данных…";
  try {
    const data = await api("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: document.getElementById("username").value, password: document.getElementById("password").value })
    });
    document.getElementById("password").value = "";
    loginResult.textContent = "";
    await showLab(data);
  } catch (e) { loginResult.textContent = e.message; }
  finally { button.disabled = false; }
});
logoutButton.addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (_) {}
  showLogin();
  statusEl.textContent = "Вы вышли из системы";
});
async function refreshStatus() {
  try {
    const data = await api("/api/status");
    statusEl.textContent = `${data.message}. Камера: ${data.cameraName}. ${data.avrdudeAvailable ? "AVRDUDE найден" : "AVRDUDE не найден"}`;
  } catch (_) {}
}
async function refreshPorts() {
  const previous = portSelect.value;
  portSelect.replaceChildren(new Option("Загрузка списка портов…", ""));
  portStatus.textContent = "Ищем COM-порты на компьютере лаборатории…";
  refreshPortsButton.disabled = true;
  try {
    const body = await api("/api/ports");
    if (!body.success) throw new Error(body.message || "Ошибка получения портов");
    portSelect.replaceChildren();
    if (!body.ports.length) {
      portSelect.add(new Option("COM-порты не найдены", ""));
      portStatus.textContent = "Arduino не обнаружена. Подключите плату и нажмите «Обновить порты».";
      return;
    }
    portSelect.add(new Option("Выберите порт…", ""));
    for (const item of body.ports) portSelect.add(new Option(`${item.port} — ${item.name}`, item.port));
    if (body.ports.some(item => item.port === previous)) portSelect.value = previous;
    else if (body.ports.length === 1) portSelect.value = body.ports[0].port;
    portStatus.textContent = `Найдено портов: ${body.ports.length}. Выберите порт Arduino.`;
  } catch (e) { portSelect.replaceChildren(new Option("Не удалось получить список портов", "")); portStatus.textContent = e.message; }
  finally { refreshPortsButton.disabled = false; }
}
refreshPortsButton.addEventListener("click", refreshPorts);
camera.addEventListener("error", () => { cameraError.hidden = false; });
camera.addEventListener("load", () => { cameraError.hidden = true; });

form.addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("firmware");
  if (!portSelect.value) { result.textContent = "Сначала выберите COM-порт Arduino."; return; }
  if (!input.files.length) { result.textContent = "Сначала выберите файл .hex."; return; }
  const data = new FormData();
  data.append("firmware", input.files[0]);
  data.append("port", portSelect.value);
  const button = document.getElementById("submitJob");
  button.disabled = true;
  result.textContent = "Отправляем задание в очередь…";
  try {
    const body = await api("/api/jobs", { method: "POST", body: data });
    result.textContent = `Задание ${body.job.id.slice(0, 8)} добавлено. Позиция в очереди: ${body.job.position || "следующая"}.`;
    form.reset();
    await refreshPorts();
    await refreshJobs();
  } catch (e) { result.textContent = `Ошибка: ${e.message}`; }
  finally { button.disabled = false; }
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function statusLabel(job) {
  return ({ queued: "В очереди", running: "Выполняется", success: "Успешно", failed: "Ошибка", cancelled: "Отменено" })[job.status] || job.status;
}
async function refreshJobs() {
  try {
    const data = await api("/api/jobs");
    queueSummary.textContent = `Заданий в ожидании: ${data.queueLength}. ${data.flashInProgress ? "Сейчас выполняется прошивка." : "Программатор свободен."}`;
    if (!data.jobs.length) { jobsList.innerHTML = "<p>Заданий пока нет.</p>"; return; }
    jobsList.innerHTML = data.jobs.map(job => `
      <article class="job-card">
        <div class="job-top"><strong>${escapeHtml(job.originalName)}</strong><span class="badge state-${escapeHtml(job.status)}">${escapeHtml(statusLabel(job))}</span></div>
        <div class="job-meta">ID: ${escapeHtml(job.id.slice(0, 8))} · Пользователь: ${escapeHtml(job.username)} · Порт: ${escapeHtml(job.port)} · ${escapeHtml(new Date(job.createdAt).toLocaleString())}</div>
        <p>${escapeHtml(job.message)}${job.status === "queued" ? ` Позиция: ${job.position}` : ""}</p>
        ${job.output ? `<details><summary>Вывод программатора</summary><pre>${escapeHtml(job.output)}</pre></details>` : ""}
        ${job.status === "queued" ? `<button class="secondary cancel-job" type="button" data-id="${escapeHtml(job.id)}">Отменить</button>` : ""}
      </article>`).join("");
    jobsList.querySelectorAll(".cancel-job").forEach(button => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await api(`/api/jobs/${encodeURIComponent(button.dataset.id)}/cancel`, { method: "POST" }); await refreshJobs(); }
      catch (e) { alert(e.message); button.disabled = false; }
    }));
  } catch (e) { queueSummary.textContent = e.message; }
}
refreshJobsButton.addEventListener("click", refreshJobs);
checkSession();


// Serial Monitor: один общий COM-порт, эксклюзивное владение на время сессии.
const serialConsolePort = document.getElementById("serialConsolePort");
const serialBaudRate = document.getElementById("serialBaudRate");
const serialOpenButton = document.getElementById("serialOpen");
const serialCloseButton = document.getElementById("serialClose");
const serialClearButton = document.getElementById("serialClear");
const serialStatus = document.getElementById("serialStatus");
const serialOutput = document.getElementById("serialOutput");
const serialInput = document.getElementById("serialInput");
const serialWriteForm = document.getElementById("serialWriteForm");
const serialSendButton = document.getElementById("serialSend");
const serialAppendNewline = document.getElementById("serialAppendNewline");
let serialPollTimer = null;
let serialIsOpen = false;
let serialCanControl = false;

function appendSerialText(value) {
  if (!value) return;
  serialOutput.textContent += value;
  if (serialOutput.textContent.length > 40000) serialOutput.textContent = serialOutput.textContent.slice(-40000);
  serialOutput.scrollTop = serialOutput.scrollHeight;
}
function updateSerialControls(state) {
  serialIsOpen = Boolean(state.open);
  serialCanControl = Boolean(state.canControl);
  serialOpenButton.disabled = serialIsOpen;
  serialCloseButton.disabled = !serialIsOpen || !serialCanControl;
  serialSendButton.disabled = !serialIsOpen || !serialCanControl;
  serialConsolePort.disabled = serialIsOpen;
  serialBaudRate.disabled = serialIsOpen;
  if (state.open) {
    serialStatus.textContent = state.canControl
      ? `Открыт ${state.port}, ${state.baudRate} бод. Владелец: ${state.owner}.`
      : `Порт занят пользователем ${state.owner}. Вы можете просматривать только статус.`;
  } else {
    serialStatus.textContent = state.message || "Последовательный порт закрыт.";
  }
}
async function refreshSerialStatus() {
  try {
    const data = await api("/api/serial/status");
    updateSerialControls(data.serial);
  } catch (e) {
    serialStatus.textContent = e.message;
  }
}
async function refreshSerialPorts() {
  try {
    const old = serialConsolePort.value;
    const data = await api("/api/ports");
    serialConsolePort.replaceChildren(new Option("Выберите порт…", ""));
    for (const p of data.ports || []) serialConsolePort.add(new Option(`${p.port} — ${p.name}`, p.port));
    if ((data.ports || []).some(p => p.port === old)) serialConsolePort.value = old;
    else if ((data.ports || []).length === 1) serialConsolePort.value = data.ports[0].port;
  } catch (e) {
    serialConsolePort.replaceChildren(new Option("Ошибка списка портов", ""));
    serialStatus.textContent = e.message;
  }
}
async function pollSerial() {
  try {
    const data = await api("/api/serial/read");
    appendSerialText(data.text);
    if (!data.open && serialIsOpen) {
      updateSerialControls({ open: false, message: data.message || "Последовательный порт закрыт." });
    }
  } catch (e) {
    if (!String(e.message).includes("другим пользователем")) serialStatus.textContent = e.message;
  }
}
function startSerialPolling() {
  if (serialPollTimer) clearInterval(serialPollTimer);
  serialPollTimer = setInterval(pollSerial, 400);
  pollSerial();
}
function stopSerialPolling() {
  if (serialPollTimer) clearInterval(serialPollTimer);
  serialPollTimer = null;
}
serialOpenButton.addEventListener("click", async () => {
  if (!serialConsolePort.value) {
    serialStatus.textContent = "Сначала выберите COM-порт.";
    return;
  }
  serialOpenButton.disabled = true;
  serialStatus.textContent = "Открываем последовательный порт…";
  try {
    const data = await api("/api/serial/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: serialConsolePort.value, baudRate: Number(serialBaudRate.value) })
    });
    serialOutput.textContent = "";
    updateSerialControls(data.serial);
    serialStatus.textContent = data.message;
    startSerialPolling();
  } catch (e) {
    serialStatus.textContent = e.message;
    await refreshSerialStatus();
  } finally {
    serialOpenButton.disabled = serialIsOpen;
  }
});
serialCloseButton.addEventListener("click", async () => {
  serialCloseButton.disabled = true;
  try {
    const data = await api("/api/serial/close", { method: "POST" });
    serialStatus.textContent = data.message;
    stopSerialPolling();
    await refreshSerialStatus();
  } catch (e) {
    serialStatus.textContent = e.message;
    await refreshSerialStatus();
  }
});
serialClearButton.addEventListener("click", () => { serialOutput.textContent = ""; });
serialWriteForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!serialCanControl || !serialIsOpen) {
    serialStatus.textContent = "Сначала откройте последовательный порт.";
    return;
  }
  let data = serialInput.value;
  if (serialAppendNewline.checked) data += "\r\n";
  if (!data.trim()) {
    serialStatus.textContent = "Введите данные для отправки.";
    return;
  }
  serialSendButton.disabled = true;
  try {
    const result = await api("/api/serial/write", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data })
    });
    serialStatus.textContent = result.message;
    serialInput.value = "";
  } catch (e) {
    serialStatus.textContent = e.message;
  } finally {
    serialSendButton.disabled = !serialIsOpen || !serialCanControl;
  }
});
const previousShowLab = showLab;
showLab = async function(user) {
  await previousShowLab(user);
  await refreshSerialPorts();
  await refreshSerialStatus();
  if (serialPollTimer) stopSerialPolling();
};
const previousShowLogin = showLogin;
showLogin = function() {
  previousShowLogin();
  stopSerialPolling();
  serialIsOpen = false;
  serialCanControl = false;
  updateSerialControls({ open: false, message: "Войдите в систему для работы с COM-портом." });
};
