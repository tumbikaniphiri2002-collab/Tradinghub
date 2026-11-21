// PUT YOUR REGISTERED DERIV APP ID HERE (numbers only, keep the quotes)
const APP_ID = "351tNZiIAHYfpVlNrstTM";

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const OAUTH_URL = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}&l=EN&brand=deriv`;

let ws;
let currentSubId = null;
let tickHistory = [];
let userCurrency = "USD";
let recommendedContract = null;
let accounts = [];

window.onload = () => {
  parseOAuthCallback();
  try {
    const saved = localStorage.getItem("deriv_accounts");
    if (saved) {
      accounts = JSON.parse(saved);
      if (accounts.length > 0) {
        populateAccountSwitcher();
        connectDeriv(accounts[0].token);
      }
    }
  } catch (e) {
    localStorage.removeItem("deriv_accounts");
  }
};

function loginWithDeriv() {
  if (APP_ID === "YOUR_APP_ID") {
    alert("First register your App ID at api.deriv.com and paste it into app.js!");
    return;
  }
  window.location.href = OAUTH_URL;
}

function parseOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const parsed = [];
  let i = 1;

  while (params.has(`acct${i}`) && params.has(`token${i}`)) {
    parsed.push({
      acct: params.get(`acct${i}`),
      token: params.get(`token${i}`),
      cur: params.get(`cur${i}`) || "USD"
    });
    i++;
  }

  if (parsed.length > 0) {
    // Demo accounts (VRTC) first, for safety
    parsed.sort((a, b) => {
      const aDemo = a.acct.startsWith("VRTC") ? 0 : 1;
      const bDemo = b.acct.startsWith("VRTC") ? 0 : 1;
      return aDemo - bDemo;
    });
    localStorage.setItem("deriv_accounts", JSON.stringify(parsed));
    // Remove tokens from the address bar
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function populateAccountSwitcher() {
  const switcher = document.getElementById("accountSwitcher");
  switcher.innerHTML = "";
  accounts.forEach((acc, index) => {
    const typeLabel = acc.acct.startsWith("VRTC") ? "DEMO" : "REAL";
    const option = document.createElement("option");
    option.value = index;
    option.textContent = `${typeLabel} - ${acc.acct} (${acc.cur})`;
    switcher.appendChild(option);
  });
}

function switchAccount() {
  const index = document.getElementById("accountSwitcher").value;
  const selected = accounts[index];
  if (selected) connectDeriv(selected.token);
}

function logoutDeriv() {
  localStorage.removeItem("deriv_accounts");
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  location.reload();
}

function logMessage(msg) {
  const logBox = document.getElementById("tradeLog");
  const time = new Date().toLocaleTimeString();
  const row = document.createElement("div");
  row.textContent = `[${time}] ${msg}`;
  logBox.prepend(row);
}

function connectDeriv(token) {
  // Close any old connection first
  if (ws && ws.readyState <= WebSocket.OPEN) {
    ws.onclose = null;
    ws.close();
  }
  currentSubId = null;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    logMessage("Connecting to Deriv...");
    ws.send(JSON.stringify({ authorize: token }));
  };

  ws.onerror = () => {
    logMessage("❌ Connection error. Check your internet and App ID.");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      logMessage("❌ Error: " + data.error.message);
      return;
    }

    if (data.msg_type === "authorize") {
      userCurrency = data.authorize.currency;
      document.getElementById("status").textContent = "Connected";
      document.getElementById("status").className = "badge online";
      document.getElementById("loginCard").classList.add("hidden");
      document.getElementById("accountCard").classList.remove("hidden");
      document.getElementById("balance").textContent = data.authorize.balance;
      document.getElementById("currency").textContent = userCurrency;
      logMessage("✅ Authorized: " + data.authorize.loginid);

      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      subscribeTicks();
    }

    if (data.msg_type === "balance") {
      document.getElementById("balance").textContent = data.balance.balance;
    }

    if (data.msg_type === "tick") {
      // Ignore leftover ticks from a market we switched away from
      const selected = document.getElementById("marketSelect").value;
      if (data.tick.symbol !== selected) return;

      currentSubId = data.tick.id;
      const quote = data.tick.quote;
      document.getElementById("livePrice").textContent = quote;
      analyzeMarket(quote, data.tick.pip_size);
    }

    if (data.msg_type === "buy") {
      logMessage(`🟢 Order Filled | ID: ${data.buy.contract_id} | Cost: $${data.buy.buy_price}`);
    }
  };

  ws.onclose = () => {
    currentSubId = null;
    tickHistory = [];
    recommendedContract = null;
    document.getElementById("status").textContent = "Disconnected";
    document.getElementById("status").className = "badge offline";
    document.getElementById("aiExecBtn").disabled = true;
    logMessage("⚠️ Disconnected from server.");
  };
}

function subscribeTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (currentSubId) {
    ws.send(JSON.stringify({ forget: currentSubId }));
    currentSubId = null;
  }

  tickHistory = [];
  recommendedContract = null;
  document.getElementById("aiSignal").textContent = "COLLECTING DATA...";
  document.getElementById("aiConfidence").textContent = "0%";
  document.getElementById("aiReason").textContent =
    "Waiting for at least 10 ticks to analyze momentum & digits...";
  document.getElementById("aiExecBtn").disabled = true;

  const symbol = document.getElementById("marketSelect").value;
  ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
  logMessage("📡 Subscribed to " + symbol);
}

function analyzeMarket(quote, pipSize) {
  const formatted = Number(quote).toFixed(pipSize || 2);
  const lastDigit = parseInt(formatted.slice(-1), 10);

  tickHistory.push({ price: Number(quote), digit: lastDigit });
  if (tickHistory.length > 30) tickHistory.shift();

  if (tickHistory.length < 10) {
    document.getElementById("aiReason").textContent =
      `Collecting ticks (${tickHistory.length}/10 minimum)...`;
    return;
  }

  let rises = 0, falls = 0, evens = 0, odds = 0;

  for (let i = 0; i < tickHistory.length; i++) {
    if (tickHistory[i].digit % 2 === 0) evens++;
    else odds++;

    if (i > 0) {
      if (tickHistory[i].price > tickHistory[i - 1].price) rises++;
      else if (tickHistory[i].price < tickHistory[i - 1].price) falls++;
    }
  }

  const totalMoves = rises + falls || 1;
  const risePct = Math.round((rises / totalMoves) * 100);
  const fallPct = 100 - risePct;

  const evenPct = Math.round((evens / tickHistory.length) * 100);
  const oddPct = 100 - evenPct;

  document.getElementById("trendStat").textContent = `${risePct}% / ${fallPct}%`;
  document.getElementById("digitStat").textContent = `${evenPct}% / ${oddPct}%`;

  const candidates = [
    { type: "CALL", label: "RISE (CALL)", score: risePct, reason: `Upward momentum at ${risePct}% over last ${tickHistory.length} ticks.` },
    { type: "PUT", label: "FALL (PUT)", score: fallPct, reason: `Downward momentum at ${fallPct}% over last ${tickHistory.length} ticks.` },
    { type: "DIGITEVEN", label: "EVEN DIGITS", score: evenPct, reason: `Even digits dominating at ${evenPct}% frequency.` },
    { type: "DIGITODD", label: "ODD DIGITS", score: oddPct, reason: `Odd digits dominating at ${oddPct}% frequency.` }
  ];

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  recommendedContract = best.type;
  document.getElementById("aiSignal").textContent = best.label;
  document.getElementById("aiConfidence").textContent = best.score + "%";
  document.getElementById("aiReason").textContent = best.reason;
  document.getElementById("aiExecBtn").disabled = false;
}

function executeAISignal() {
  if (!recommendedContract) {
    alert("Wait for the AI Analyzer to generate a signal first.");
    return;
  }
  executeBulk(recommendedContract);
}

function executeBulk(contractType) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("Log in with Deriv first.");
    return;
  }

  const symbol = document.getElementById("marketSelect").value;
  const stake = parseFloat(document.getElementById("stakeInput").value);
  const duration = parseInt(document.getElementById("durationInput").value, 10);
  const bulkCount = parseInt(document.getElementById("bulkCountInput").value, 10);

  if (isNaN(stake) || stake < 0.35 || isNaN(bulkCount) || bulkCount < 1 || bulkCount > 10) {
    alert("Check your Stake (min $0.35) and Bulk Count (1–10).");
    return;
  }

  // Rise/Fall needs 5-10 ticks; digit contracts allow 1-10
  const isRiseFall = contractType === "CALL" || contractType === "PUT";
  const minTicks = isRiseFall ? 5 : 1;
  if (isNaN(duration) || duration < minTicks || duration > 10) {
    alert(`Ticks must be between ${minTicks} and 10 for this contract type.`);
    return;
  }

  logMessage(`🚀 Sending ${bulkCount}x ${contractType} trades ($${stake} each)...`);

  // Stagger orders by 250ms to respect rate limits
  for (let i = 0; i < bulkCount; i++) {
    setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
          amount: stake,
          basis: "stake",
          contract_type: contractType,
          currency: userCurrency,
          duration: duration,
          duration_unit: "t",
          symbol: symbol
        }
      }));
    }, i * 250);
  }
}