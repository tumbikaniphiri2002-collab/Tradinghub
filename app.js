// REPLACE THIS WITH YOUR REGISTERED DERIV APP ID FROM ://deriv.com
const APP_ID = "YOUR_APP_ID";

let ws;
let currentSubId = null;
let tickHistory = [];
let userCurrency = "USD";
let recommendedContract = null;
let accounts = [];

// Run on page load to check if Deriv just redirected back with OAuth tokens
window.onload = () => {
  parseOAuthCallback();
  const savedAccounts = localStorage.getItem("deriv_accounts");
  if (savedAccounts) {
    accounts = JSON.parse(savedAccounts);
    if (accounts.length > 0) {
      populateAccountSwitcher();
      connectDeriv(accounts[0].token);
    }
  }
};

function loginWithDeriv() {
  if (APP_ID === "YOUR_APP_ID") {
    alert("First register your App ID at ://deriv.com and paste it into app.js!");
    return;
  }
  const oauthUrl = `https://deriv.com{APP_ID}&l=EN&brand=deriv`;
  window.location.href = oauthUrl;
}

function parseOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const parsedAccounts = [];
  let i = 1;

  while (params.has(`acct${i}`) && params.has(`token${i}`)) {
    parsedAccounts.push({
      acct: params.get(`acct${i}`),
      token: params.get(`token${i}`),
      cur: params.get(`cur${i}`) || "USD"
    });
    i++;
  }

  if (parsedAccounts.length > 0) {
    // Prioritize Demo account (starts with VRTC) first for safety
    parsedAccounts.sort((a, b) => (a.acct.startsWith("VRTC") ? -1 : 1));
    localStorage.setItem("deriv_accounts", JSON.stringify(parsedAccounts));
    // Clean tokens out of the browser URL bar
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
  if (selected) {
    if (ws) ws.close();
    connectDeriv(selected.token);
  }
}

function logoutDeriv() {
  localStorage.removeItem("deriv_accounts");
  if (ws) ws.close();
  location.reload();
}

function logMessage(msg) {
  const logBox = document.getElementById("tradeLog");
  const time = new Date().toLocaleTimeString();
  logBox.innerHTML = `<div>[${time}] ${msg}</div>` + logBox.innerHTML;
}

function connectDeriv(token) {
  ws = new WebSocket(`wss://://derivws.com{APP_ID}`);

  ws.onopen = () => {
    logMessage("Connecting to Deriv...");
    ws.send(JSON.stringify({ authorize: token }));
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
    document.getElementById("status").textContent = "Disconnected";
    document.getElementById("status").className = "badge offline";
    document.getElementById("aiExecBtn").disabled = true;
  };
}

function subscribeTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (currentSubId) {
    ws.send(JSON.stringify({ forget: currentSubId }));
  }

  tickHistory = [];
  recommendedContract = null;
  document.getElementById("aiSignal").textContent = "COLLECTING DATA...";
  document.getElementById("aiConfidence").textContent = "0%";
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

  if (stake < 0.35 || bulkCount < 1 || bulkCount > 10) {
    alert("Check your Stake (min $0.35) and Bulk Count (1–10).");
    return;
  }

  logMessage(`🚀 Sending ${bulkCount}x ${contractType} trades ($${stake} each)...`);

  for (let i = 0; i < bulkCount; i++) {
    setTimeout(() => {
      const request = {
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
      };
      ws.send(JSON.stringify(request));
    }, i * 250);
  }
}
