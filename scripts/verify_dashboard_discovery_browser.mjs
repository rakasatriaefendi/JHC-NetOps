import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(root, "runner", ".env"));
loadEnv(path.join(root, "frontend", ".env.local"));
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!supabaseUrl || !serviceKey || !existsSync(chromePath)) throw new Error("Browser verification prerequisites are unavailable");

const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const profilePath = path.join(root, "runner", "data", `browser-e2e-${stamp}`);
const email = `dashboard-admin-${stamp}@example.invalid`;
const password = `Tmp-${randomBytes(18).toString("base64url")}!`;
let userId = null;
let chrome = null;
let cdp = null;

try {
  userId = await createAdmin(email, password);
  chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profilePath}`, "--no-first-run", "--disable-gpu", "about:blank"], { windowsHide: true, shell: false, stdio: "ignore" });
  const port = await waitDevtoolsPort(profilePath);
  const page = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("http://localhost:3000/login")}`, { method: "PUT" }).then((response) => response.json());
  cdp = new Devtools(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(cdp, `document.querySelector('input[name="email"]') !== null`, 20_000);
  await cdp.evaluate(`(() => {
    const assign=(selector,value)=>{const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
    assign('input[name="email"]',${JSON.stringify(email)});
    assign('input[name="password"]',${JSON.stringify(password)});
    document.querySelector('form').requestSubmit();
  })()`);
  await waitFor(cdp, `location.pathname === '/dashboard'`, 30_000);
  const desktop = await cdp.evaluate(`(() => ({
    text: document.body.innerText,
    headings: [...document.querySelectorAll('h2')].map((node)=>node.textContent.trim()),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
  }))()`);
  assert(desktop.text.includes("LOCAL TRAFFIC — THIS DEVICE") || desktop.text.includes("Local Traffic — This Device"), "Local Traffic summary did not render");
  assert(desktop.text.includes("RX/TX menunjukkan traffic yang sedang teramati"), "RX/TX helper text is missing");
  assert(!desktop.text.includes("Deploy Edge Function ingest"), "Developer deployment copy remains on Dashboard");
  assert(desktop.headings.indexOf("Current observed traffic") < desktop.headings.indexOf("Known-target reachability"), "Dashboard section order is incorrect");
  assert(desktop.text.includes("Discover Network"), "Admin discovery action did not render");

  await waitFor(cdp, `(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('Discover Network')); return button && Object.keys(button).some((key)=>key.startsWith('__reactProps')); })()`, 30_000);
  await cdp.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('Discover Network')); const key=Object.keys(button).find((item)=>item.startsWith('__reactProps')); button[key].onClick(); return true; })()`);
  await waitFor(cdp, `document.querySelector('[role="dialog"][aria-label="Network Discovery"]') !== null`, 10_000);
  let drawer = await cdp.evaluate(`document.body.innerText`);
  if (drawer.includes("Discovery results expired")) {
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button)=>button.textContent.includes('Refresh current network')).click()`);
  }
  await waitFor(cdp, `document.body.innerText.includes('Start Discovery') || document.body.innerText.includes('Local Runner is offline')`, 45_000);
  drawer = await cdp.evaluate(`document.body.innerText`);
  assert(drawer.includes("Current local subnet"), "Discovery scope was not rendered");
  assert(drawer.includes("browser cannot submit a CIDR") || drawer.includes("browser cannot submit a CIDR".toUpperCase()) || drawer.includes("The browser cannot submit a CIDR"), "Browser scope restriction copy is missing");
  const arbitraryInputs = await cdp.evaluate(`[...document.querySelectorAll('input')].filter((input)=>/cidr|range|command|flag/i.test(input.name+' '+input.placeholder)).length`);
  assert(arbitraryInputs === 0, "Drawer exposes arbitrary discovery scope input");

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await cdp.evaluate(`({overflow:document.documentElement.scrollWidth>window.innerWidth,dialog:!!document.querySelector('[role="dialog"]')})`);
  assert(mobile.dialog && !mobile.overflow, "Mobile drawer has horizontal overflow or is not visible");
  console.log(JSON.stringify({ ok: true, authenticated_dashboard: true, local_traffic_summary: true, rx_tx_copy: true,
    admin_discovery_drawer: true, arbitrary_scope_input_absent: true, dashboard_order: true, mobile_no_horizontal_overflow: true }, null, 2));
} finally {
  cdp?.close();
  if (chrome) {
    chrome.kill();
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
  if (userId) await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: authHeaders(serviceKey) }).catch(() => {});
  if (path.resolve(profilePath).startsWith(path.join(root, "runner", "data") + path.sep)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(profilePath, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); }
    }
  }
}

async function createAdmin(userEmail, userPassword) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, { method: "POST", headers: { ...authHeaders(serviceKey), "Content-Type": "application/json" }, body: JSON.stringify({ email: userEmail, password: userPassword, email_confirm: true }) });
  const user = await response.json();
  if (!response.ok || !user.id) throw new Error("Temporary browser user could not be created");
  const profile = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, { method: "PATCH", headers: { ...authHeaders(serviceKey), "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ status: "approved", role: "admin", approved_at: new Date().toISOString() }) });
  if (!profile.ok) throw new Error("Temporary browser profile could not be approved");
  return user.id;
}

function Devtools(url) {
  this.url = url; this.nextId = 1; this.pending = new Map(); this.events = [];
  this.open = () => new Promise((resolve, reject) => { this.socket = new WebSocket(this.url); this.socket.onopen = resolve; this.socket.onerror = reject; this.socket.onmessage = (event) => { const message = JSON.parse(event.data); if (!message.id) { this.events.push(message); this.events = this.events.slice(-50); return; } const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }; });
  this.send = (method, params = {}) => { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); };
  this.evaluate = async (expression) => { const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error("Browser expression failed"); return result.result.value; };
  this.close = () => this.socket?.close();
}

async function waitFor(cdpClient, expression, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await cdpClient.evaluate(expression).catch(() => false)) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`Browser wait timed out: ${expression}`); }
async function waitDevtoolsPort(directory) { const file = path.join(directory, "DevToolsActivePort"); const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (existsSync(file)) return Number(readFileSync(file, "utf8").split(/\r?\n/)[0]); await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Headless Chrome did not expose DevTools"); }
function authHeaders(key) { return { Authorization: `Bearer ${key}`, apikey: key }; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function loadEnv(filename) { try { for (const raw of readFileSync(filename, "utf8").split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const index = line.indexOf("="); if (index < 1) continue; const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); if (process.env[key] === undefined) process.env[key] = value; } } catch {} }
