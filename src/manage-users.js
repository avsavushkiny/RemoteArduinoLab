const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const file = path.join(__dirname, "users.json");
const [command, usernameArg, roleArg] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));
function hash(password, salt) { return crypto.scryptSync(password, salt, 64).toString("hex"); }
(async () => {
  try {
    if (command !== "add" || !usernameArg || !["admin", "student"].includes(roleArg)) {
      console.log("Использование: node manage-users.js add <логин> <student|admin>");
      console.log("Пример: node manage-users.js add student01 student");
      process.exitCode = 1; return;
    }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(usernameArg)) throw new Error("Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание.");
    const users = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    if (users.some(u => u.username.toLowerCase() === usernameArg.toLowerCase())) throw new Error("Такой логин уже существует.");
    const password = await ask("Пароль (не менее 12 символов): ");
    if (password.length < 12 || password.length > 256) throw new Error("Пароль должен содержать от 12 до 256 символов.");
    const confirm = await ask("Повторите пароль: ");
    if (password !== confirm) throw new Error("Пароли не совпадают.");
    const salt = crypto.randomBytes(16).toString("hex");
    users.push({ username: usernameArg, role: roleArg, salt, passwordHash: hash(password, salt), createdAt: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(users, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    console.log(`Создан пользователь ${usernameArg} (роль: ${roleArg}).`);
    console.log("Пароль хранится в виде хеша scrypt; сам пароль в файл не записывается.");
  } finally { rl.close(); }
})().catch(error => { console.error("Ошибка:", error.message); process.exitCode = 1; rl.close(); });
