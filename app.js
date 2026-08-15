(function () {
  "use strict";

  const API_BASE = window.API_BASE.replace(/\/$/, "");
  const TOKEN_KEY = "gc_token";

  const SEGMENT_COLORS = {
    "x0": "#ff5c77",
    "x1": "#4b4570",
    "x0.5": "#ff8fa3",
    "x1.5": "#8fe3c4",
    "x2": "#33d69f",
    "🎁 +1": "#7b61ff",
    "x3": "#ffc857",
    "x5": "#ff9f1c",
  };

  const els = {
    preloader: document.getElementById("preloader"),
    lettersWrap: document.querySelector(".preloader-letters"),
    lettersFill: document.getElementById("lettersFill"),

    loginScreen: document.getElementById("loginScreen"),
    wheelScreen: document.getElementById("wheelScreen"),
    balanceChip: document.getElementById("balanceChip"),
    balanceValue: document.getElementById("balanceValue"),

    idForm: document.getElementById("idForm"),
    telegramId: document.getElementById("telegramId"),
    sendCodeBtn: document.getElementById("sendCodeBtn"),

    codeForm: document.getElementById("codeForm"),
    codeInput: document.getElementById("codeInput"),
    verifyBtn: document.getElementById("verifyBtn"),
    resendBtn: document.getElementById("resendBtn"),
    loginError: document.getElementById("loginError"),

    wheel: document.getElementById("wheel"),
    resultBadge: document.getElementById("resultBadge"),
    legendList: document.getElementById("legendList"),
    historyList: document.getElementById("historyList"),

    betMinus: document.getElementById("betMinus"),
    betPlus: document.getElementById("betPlus"),
    betValue: document.getElementById("betValue"),
    spinBtn: document.getElementById("spinBtn"),
    spinCost: document.getElementById("spinCost"),
    spinError: document.getElementById("spinError"),
  };

  let pendingTelegramId = null;
  let sections = [];
  let minBet = 5, betStep = 5, maxBet = 100;
  let bet = 5;
  let currentDeg = 0;
  let spinning = false;

  // ---------- API helper ----------

  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) throw new Error("Нет сессии");
      headers["Authorization"] = "Bearer " + token;
    }
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || "Ошибка запроса");
    }
    return data;
  }

  // ---------- login flow ----------

  els.idForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();
    const raw = els.telegramId.value.trim();
    if (!/^\d+$/.test(raw)) {
      showError("Telegram ID должен состоять только из цифр");
      return;
    }
    pendingTelegramId = Number(raw);
    setBusy(els.sendCodeBtn, true, "Отправляем...");
    try {
      await api("/api/auth/request-code", { method: "POST", body: { telegram_id: pendingTelegramId } });
      els.idForm.classList.add("hidden");
      els.codeForm.classList.remove("hidden");
      els.codeInput.focus();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(els.sendCodeBtn, false, "Отправить код");
    }
  });

  els.resendBtn.addEventListener("click", async () => {
    hideError();
    setBusy(els.resendBtn, true, "Отправляем...");
    try {
      await api("/api/auth/request-code", { method: "POST", body: { telegram_id: pendingTelegramId } });
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(els.resendBtn, false, "Отправить код ещё раз");
    }
  });

  els.codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();
    const code = els.codeInput.value.trim();
    if (!code) return;
    setBusy(els.verifyBtn, true, "Проверяем...");
    try {
      const data = await api("/api/auth/verify", {
        method: "POST",
        body: { telegram_id: pendingTelegramId, code },
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      await enterApp();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(els.verifyBtn, false, "Войти");
    }
  });

  function showError(msg) {
    els.loginError.textContent = msg;
    els.loginError.classList.remove("hidden");
  }
  function hideError() {
    els.loginError.classList.add("hidden");
  }
  function setBusy(btn, busy, label) {
    btn.disabled = busy;
    btn.textContent = label;
  }

  // ---------- app screen ----------

  async function enterApp() {
    const me = await api("/api/me", { auth: true });
    sections = me.sections;
    minBet = me.min_bet;
    betStep = me.bet_step;
    maxBet = me.max_bet;
    bet = minBet;

    els.loginScreen.classList.add("hidden");
    els.wheelScreen.classList.remove("hidden");
    els.balanceChip.classList.remove("hidden");
    setBalance(me.balance);

    buildWheel();
    buildLegend();
    updateBetUI();
    loadHistory();
  }

  function setBalance(v) {
    els.balanceValue.textContent = v;
  }

  function buildWheel() {
    const n = sections.length;
    const step = 360 / n;
    const stops = sections
      .map((s, i) => {
        const color = SEGMENT_COLORS[s.label] || "#4b4570";
        return `${color} ${i * step}deg ${(i + 1) * step}deg`;
      })
      .join(", ");
    els.wheel.style.background = `conic-gradient(${stops})`;

    els.wheel.querySelectorAll(".wheel-seg-label").forEach((el) => el.remove());

    const radiusPx = els.wheel.clientWidth * 0.31 || 105;
    sections.forEach((s, i) => {
      const center = i * step + step / 2;
      const rad = (center * Math.PI) / 180;
      const x = radiusPx * Math.sin(rad);
      const y = -radiusPx * Math.cos(rad);
      const label = document.createElement("div");
      label.className = "wheel-seg-label";
      label.textContent = s.label;
      label.style.left = `calc(50% + ${x}px)`;
      label.style.top = `calc(50% + ${y}px)`;
      label.style.transform = `translate(-50%, -50%) rotate(${center}deg)`;
      els.wheel.appendChild(label);
    });
  }

  function buildLegend() {
    els.legendList.innerHTML = "";
    sections.forEach((s) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.background = SEGMENT_COLORS[s.label] || "#4b4570";
      const chance = (s.weight / 10).toFixed(1).replace(/\.0$/, "");
      const text = document.createElement("span");
      text.textContent = `${s.label} — ${chance}%`;
      li.appendChild(dot);
      li.appendChild(text);
      els.legendList.appendChild(li);
    });
  }

  function updateBetUI() {
    els.betValue.textContent = bet;
    els.spinCost.textContent = `−${bet} шансов`;
    els.betMinus.disabled = bet <= minBet;
    els.betPlus.disabled = bet >= maxBet;
  }

  els.betMinus.addEventListener("click", () => {
    bet = Math.max(minBet, bet - betStep);
    updateBetUI();
  });
  els.betPlus.addEventListener("click", () => {
    bet = Math.min(maxBet, bet + betStep);
    updateBetUI();
  });

  els.spinBtn.addEventListener("click", async () => {
    if (spinning) return;
    els.spinError.classList.add("hidden");
    els.resultBadge.classList.add("hidden");
    spinning = true;
    els.spinBtn.disabled = true;

    try {
      const data = await api("/api/spin", { method: "POST", auth: true, body: { bet } });
      animateTo(data.section_index, () => showResult(data));
    } catch (err) {
      els.spinError.textContent = err.message;
      els.spinError.classList.remove("hidden");
      spinning = false;
      els.spinBtn.disabled = false;
    }
  });

  function animateTo(index, onDone) {
    const n = sections.length;
    const step = 360 / n;
    const center = index * step + step / 2;
    const jitter = (Math.random() - 0.5) * (step * 0.5); // держимся в пределах сектора
    const targetMod = ((360 - center - jitter) % 360 + 360) % 360;

    const extraSpins = 5;
    let newDeg = currentDeg - (currentDeg % 360) + extraSpins * 360 + targetMod;
    if (newDeg <= currentDeg) newDeg += 360;

    currentDeg = newDeg;
    els.wheel.style.transform = `rotate(${currentDeg}deg)`;

    window.setTimeout(() => {
      spinning = false;
      els.spinBtn.disabled = false;
      onDone();
    }, 4700);
  }

  function showResult(data) {
    setBalance(data.new_balance);
    const net = data.payout - data.bet;
    els.resultBadge.classList.remove("hidden", "win", "lose", "flat");
    if (net > 0) {
      els.resultBadge.classList.add("win");
      els.resultBadge.textContent = `${data.label} · +${net} шансов`;
    } else if (net < 0) {
      els.resultBadge.classList.add("lose");
      els.resultBadge.textContent = `${data.label} · −${Math.abs(net)} шансов`;
    } else {
      els.resultBadge.classList.add("flat");
      els.resultBadge.textContent = `${data.label} · ставка возвращена`;
    }
    prependHistory(data);
  }

  function prependHistory(data) {
    const empty = els.historyList.querySelector(".history-empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    const net = data.payout - data.bet;
    const sign = net > 0 ? "+" : net < 0 ? "−" : "±";
    li.innerHTML = `<span>${data.label}</span><span>${sign}${Math.abs(net)}</span>`;
    els.historyList.prepend(li);
    while (els.historyList.children.length > 15) {
      els.historyList.removeChild(els.historyList.lastChild);
    }
  }

  async function loadHistory() {
    try {
      const data = await api("/api/history", { auth: true });
      if (!data.spins.length) return;
      els.historyList.innerHTML = "";
      data.spins.forEach((s) => {
        const li = document.createElement("li");
        const net = s.payout - s.bet;
        const sign = net > 0 ? "+" : net < 0 ? "−" : "±";
        li.innerHTML = `<span>${s.label}</span><span>${sign}${Math.abs(net)}</span>`;
        els.historyList.appendChild(li);
      });
    } catch (_) {
      // тихо игнорируем — не критично для отображения
    }
  }

  // ---------- preloader ----------

  // Плавно "заливает" буквы GP снизу вверх (серый -> жёлтый) за заданное время
  // и возвращает промис, который резолвится, когда анимация полностью завершена.
  function runPreloaderFill(durationMs) {
    return new Promise((resolve) => {
      const start = performance.now();

      function frame(now) {
        const t = Math.min(1, (now - start) / durationMs);
        // easeInOutQuad — мягкий разгон и мягкое замедление
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const topInset = (1 - eased) * 100;
        els.lettersFill.style.clipPath = `inset(${topInset}% 0 0 0)`;

        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          els.lettersWrap.classList.add("is-filled");
          resolve();
        }
      }

      requestAnimationFrame(frame);
    });
  }

  function hidePreloader() {
    els.preloader.classList.add("preloader-out");
    window.setTimeout(() => {
      els.preloader.remove();
    }, 550);
  }

  // ---------- boot ----------

  (async function boot() {
    // Заливка идёт параллельно с проверкой сессии — что бы ни случилось раньше,
    // экран загрузки не уйдёт быстрее, чем за ~1.4с, и не позже, чем оба процесса завершатся.
    const fillDone = runPreloaderFill(1400);

    let loggedIn = false;
    if (localStorage.getItem(TOKEN_KEY)) {
      try {
        await enterApp();
        loggedIn = true;
      } catch (_) {
        localStorage.removeItem(TOKEN_KEY);
      }
    }

    if (!loggedIn) {
      els.loginScreen.classList.remove("hidden");
    }

    await fillDone;
    hidePreloader();
  })();
})();
