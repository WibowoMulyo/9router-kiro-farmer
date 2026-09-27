const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROUTER_BASE = "http://localhost:20128";

const PROVIDER = "kiro";
const SOCIAL_IDP = "google";
const AKUN_FILE = path.join(__dirname, "akun.txt");
const FAILED_FILE = path.join(__dirname, "failed.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readAccounts() {
  if (!fs.existsSync(AKUN_FILE)) return [];
  const content = fs.readFileSync(AKUN_FILE, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => {
      const parts = line.trim().split("|");
      if (parts.length < 2) return null;
      const email = parts[0].trim();
      const password = parts[1].trim();
      return { email, password, raw: line.trim() };
    })
    .filter((a) => a && a.email && a.password);
}

function removeAccount(rawLine) {
  if (!fs.existsSync(AKUN_FILE)) return;
  const content = fs.readFileSync(AKUN_FILE, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() !== rawLine);
  fs.writeFileSync(AKUN_FILE, lines.join("\n"));
}

function logFailedAccount(rawLine, reason) {
  fs.appendFileSync(FAILED_FILE, `${rawLine} | Reason: ${reason}\n`);
}

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${ROUTER_BASE}${apiPath}`,
      {
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(new Error(`${method} ${apiPath} non-JSON: ${out.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getConnections() {
  const data = await apiRequest("GET", "/api/providers");
  return data.connections || [];
}

async function hasProviderConnection(email) {
  try {
    const conns = await getConnections();
    return conns.some(
      (c) => c.provider === PROVIDER && (c.name === email || c.email === email),
    );
  } catch (e) {
    return false;
  }
}

// social-exchange menamai connection baru sebagai "Account N" (email null),
// jadi koneksi baru diidentifikasi dari diff ID sebelum/sesudah.
async function getProviderConnections() {
  const conns = await getConnections();
  return conns.filter((c) => c.provider === PROVIDER);
}

async function findNewConnection(idSetBefore, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fresh = (await getProviderConnections().catch(() => [])).filter(
      (c) => !idSetBefore.has(c.id),
    );
    if (fresh.length) return fresh[0];
    await sleep(2000);
  }
  return null;
}

const CLICKABLE = "button, a[role='button'], div[role='button'], input[type='submit']";

async function clickButtonByText(page, textSubstrings, timeoutMs = 10000, excludeSubstrings = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) return false;
    try {
      // Ligature icon material-symbols menular ke textContent tombol, jadi
      // span ikon dibuang sebelum label dicocokkan.
      const index = await page.evaluate((sel, subs, exs) => {
        const label = (el) => {
          const parts = [];
          const walk = (n) => {
            for (const c of n.childNodes) {
              if (c.nodeType === 3) parts.push(c.nodeValue);
              else if (c.nodeType === 1 && !c.classList.contains("material-symbols-outlined")) walk(c);
            }
          };
          walk(el);
          return (parts.join(" ").replace(/\s+/g, " ").trim() || el.value || "").toLowerCase();
        };
        const nodes = [...document.querySelectorAll(sel)];
        for (let i = 0; i < nodes.length; i++) {
          const t = label(nodes[i]);
          if (!t) continue;
          const has = (list) => list.some((s) => t.includes(s.toLowerCase()));
          if (has(subs) && !has(exs)) return i;
        }
        return -1;
      }, CLICKABLE, textSubstrings, excludeSubstrings);
      if (index >= 0) {
        const els = await page.$$(CLICKABLE);
        if (els[index]) {
          await els[index].click();
          return true;
        }
      }
    } catch (e) {
      // Halaman sedang navigasi atau tab sudah ditutup
    }
    await sleep(500);
  }
  return false;
}

async function checkForGoogleVerificationOrError(oauthTab) {
  if (oauthTab.isClosed()) return null;
  try {
    const pageText = await oauthTab.evaluate(() =>
      document.body ? document.body.innerText : "",
    );
    const errorKeywords = [
      "Verify it's you",
      "2-Step Verification",
      "Check your phone",
      "Couldn't sign you in",
      "Wrong password",
      "Enter a phone number",
      "Confirm your recovery email",
      "This browser or app may not be secure",
      "Suspicious activity",
    ];
    for (const kw of errorKeywords) {
      if (pageText.toLowerCase().includes(kw.toLowerCase())) return kw;
    }
  } catch (e) {
    // Page might be navigating
  }
  return null;
}

async function loginAccount(account, index, total) {
  const { email, password } = account;
  console.log(`\n==================================================`);
  console.log(`=== Account ${index + 1}/${total}: ${email} ===`);
  console.log(`==================================================`);

  if (await hasProviderConnection(email)) {
    console.log(`[SKIP] ${email} sudah ada di 9Router, menghapus dari akun.txt.`);
    removeAccount(account.raw);
    return;
  }

  console.log(`Starting ${PROVIDER} OAuth session via ${SOCIAL_IDP}...`);
  let session = null;
  for (let attempt = 1; attempt <= 3 && !(session && session.authUrl); attempt++) {
    session = await apiRequest(
      "GET",
      `/api/oauth/${PROVIDER}/social-authorize?provider=${SOCIAL_IDP}`,
    ).catch((e) => ({ error: e.message }));
    if (session && session.authUrl) break;
    console.log(`  attempt ${attempt} failed: ${JSON.stringify(session).slice(0, 140)}`);
    await sleep(3000);
  }
  if (!session || !session.authUrl) {
    throw new Error("9Router could not start the OAuth session.");
  }

  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const oauthTab = await browser.newPage();

    // Skema kiro:// tidak bisa dimuat Chrome: page.url() tidak pernah berubah,
    // code callback hanya muncul di event request.
    let callbackUrl = null;
    oauthTab.on("request", (r) => {
      const u = r.url();
      if (callbackUrl || !u.includes("code=")) return;
      if (u.includes("authenticate-success") || !/^https?:/i.test(u)) callbackUrl = u;
    });

    console.log("Opening Kiro auth page (redirects straight to Google)...");
    await oauthTab
      .goto(session.authUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch((e) => console.log(`  goto belum selesai (${e.message.slice(0, 50)})`));
    await oauthTab.bringToFront();

    const googleStart = Date.now();
    while (Date.now() - googleStart < 25000 && !oauthTab.url().includes("accounts.google.com")) {
      if (callbackUrl) break;
      await sleep(500);
    }
    if (!callbackUrl && !oauthTab.url().includes("accounts.google.com")) {
      const shown = await oauthTab
        .evaluate(() => (document.body ? document.body.innerText : ""))
        .catch(() => "");
      throw new Error(
        `Google sign-in did not start. Page said: ${shown.replace(/\s+/g, " ").slice(0, 150)}`,
      );
    }
    console.log("Google OAuth tab opened successfully.");

    console.log(`Typing email: ${email}`);
    await oauthTab.waitForSelector('input[type="email"], #identifierId', { timeout: 15000 });
    await oauthTab.type('input[type="email"], #identifierId', email);

    console.log("Clicking Next (email)...");
    try {
      await oauthTab.click("#identifierNext");
    } catch (e) {
      await clickButtonByText(oauthTab, ["Next", "Berikutnya"], 5000);
    }

    await sleep(2000);
    const emailErr = await checkForGoogleVerificationOrError(oauthTab);
    if (emailErr) throw new Error(`Google Email Error: ${emailErr}`);

    console.log("Waiting for password input...");
    await oauthTab.waitForSelector('input[type="password"]', { visible: true, timeout: 20000 });
    await sleep(1000);
    console.log("Typing password...");
    await oauthTab.type('input[type="password"]', password);

    console.log("Clicking Next (password)...");
    try {
      await oauthTab.click("#passwordNext");
    } catch (e) {
      await clickButtonByText(oauthTab, ["Next", "Berikutnya"], 5000);
    }

    console.log("Processing post-password steps...");
    const postPasswordStart = Date.now();
    while (Date.now() - postPasswordStart < 45000) {
      if (oauthTab.isClosed()) {
        console.log("OAuth tab closed automatically.");
        break;
      }
      if (callbackUrl) {
        console.log("Kiro callback captured!");
        break;
      }

      const err = await checkForGoogleVerificationOrError(oauthTab);
      if (err) throw new Error(`Google Login Verification/Error required: "${err}"`);

      try {
        const hasUnderstand = await oauthTab.$("#gaplustosNext");
        if (hasUnderstand) {
          console.log('Clicking "I Understand" consent button...');
          await oauthTab.click("#gaplustosNext");
          await sleep(2000);
          continue;
        }
      } catch (e) {}

      try {
        const hasApprove = await oauthTab.$("#submit_approve_access");
        if (hasApprove) {
          console.log("Clicking Access Approval button...");
          await oauthTab.click("#submit_approve_access");
          await sleep(2000);
          continue;
        }
      } catch (e) {}

      const clickedAny = await clickButtonByText(
        oauthTab,
        ["I understand", "Saya mengerti", "Continue", "Allow", "Izinkan", "Lanjutkan", "Sign in", "Masuk"],
        2000,
      );
      if (clickedAny) {
        console.log("Clicked consent/continue button.");
        await sleep(2000);
        continue;
      }

      // Kalau halaman mentok di Google setelah consent
      if (!oauthTab.isClosed() && oauthTab.url().includes("accounts.google.com")) {
        const pageText = await oauthTab
          .evaluate(() => document.body?.innerText || "")
          .catch(() => "");
        if (/error|denied|restricted/i.test(pageText)) {
          throw new Error(`Google OAuth stuck: ${pageText.slice(0, 120)}`);
        }
      }

      await sleep(1000);
    }

    if (!callbackUrl) {
      throw new Error("Authorization selesai tapi callback kiro:// dengan code tidak tertangkap.");
    }
    const code = new URL(callbackUrl).searchParams.get("code");
    if (!code) {
      throw new Error(`Kiro callback tidak punya code: ${callbackUrl.slice(0, 140)}`);
    }

    const idsBefore = new Set((await getProviderConnections()).map((c) => c.id));
    console.log("Exchanging code with 9Router...");
    const exchanged = await apiRequest("POST", `/api/oauth/${PROVIDER}/social-exchange`, {
      code,
      codeVerifier: session.codeVerifier,
      provider: SOCIAL_IDP,
    });
    if (exchanged && exchanged.error) {
      throw new Error(`social-exchange failed: ${exchanged.error}`);
    }

    // Verifikasi final: connection baru muncul, lalu di-rename ke email
    console.log("Waiting for 9Router to register the connection...");
    const created = await findNewConnection(idsBefore, 60000);
    if (!created) {
      throw new Error(`OAuth selesai tapi koneksi ${PROVIDER} baru tidak muncul di 9Router (60s).`);
    }
    await apiRequest("PUT", `/api/providers/${created.id}`, { name: email }).catch((e) =>
      console.log(`  rename ke ${email} gagal: ${e.message.slice(0, 80)}`),
    );

    console.log(`[SUCCESS] Account ${index + 1} (${email}) connected to 9Router!`);
    removeAccount(account.raw);
    console.log(`[REMOVED] ${email} removed from akun.txt.`);
  } catch (error) {
    console.error(`[FAILED] Account ${email}: ${error.message}`);
    for (const p of await browser.pages()) {
      if (p.isClosed()) continue;
      const text = await p
        .evaluate(() => (document.body ? document.body.innerText : "").replace(/\s+/g, " "))
        .catch(() => "");
      console.error(`  [tab] ${p.url().slice(0, 100)}`);
      console.error(`  [text] ${text.slice(0, 300)}`);
      await p.screenshot({ path: path.join(__dirname, `failed-${index + 1}.png`) }).catch(() => {});
    }
    logFailedAccount(account.raw, error.message);
  } finally {
    try {
      await browser.close();
    } catch (e) {}
    console.log("Browser closed.");
  }
}

(async () => {
  const accounts = readAccounts();
  console.log(`Total accounts to add: ${accounts.length}`);
  if (accounts.length === 0) {
    console.log("No accounts found in akun.txt.");
    return;
  }

  for (let i = 0; i < accounts.length; i++) {
    await loginAccount(accounts[i], i, accounts.length);
    if (i < accounts.length - 1) {
      console.log("Waiting 3 seconds before processing next account...");
      await sleep(3000);
    }
  }

  console.log("\nAll accounts processed!");
})();
