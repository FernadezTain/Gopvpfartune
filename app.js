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

  const GAME_NAMES = { wheel: "Колесо Фортуны", aviator: "Авиатор", blackjack: "Блэкджек", case: "Кейсы"};

  const els = {
    preloader: document.getElementById("preloader"),
    lettersWrap: document.querySelector(".preloader-letters"),
    lettersFill: document.getElementById("lettersFill"),

    backBtn: document.getElementById("backBtn"),
    bottomNav: document.getElementById("bottomNav"),
    balanceChip: document.getElementById("balanceChip"),
    balanceValue: document.getElementById("balanceValue"),

    loginScreen: document.getElementById("loginScreen"),
    mainMenuScreen: document.getElementById("mainMenuScreen"),
    casesScreen: document.getElementById("casesScreen"),
    caseDetailScreen: document.getElementById("caseDetailScreen"),
    wheelScreen: document.getElementById("wheelScreen"),
    aviatorScreen: document.getElementById("aviatorScreen"),
    blackjackScreen: document.getElementById("blackjackScreen"),
    profileScreen: document.getElementById("profileScreen"),
    historyScreen: document.getElementById("historyScreen"),
    inventoryScreen: document.getElementById("inventoryScreen"),

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
    wheelRecentGamesList: document.getElementById("wheelRecentGamesList"),

    betMinus: document.getElementById("betMinus"),
    betPlus: document.getElementById("betPlus"),
    betValue: document.getElementById("betValue"),
    spinBtn: document.getElementById("spinBtn"),
    spinCost: document.getElementById("spinCost"),
    spinError: document.getElementById("spinError"),

    profileName: document.getElementById("profileName"),
    profileId: document.getElementById("profileId"),
    profileBalance: document.getElementById("profileBalance"),
    openHistoryBtn: document.getElementById("openHistoryBtn"),
    openInventoryBtn: document.getElementById("openInventoryBtn"),
    logoutBtn: document.getElementById("logoutBtn"),

    historyTableBody: document.getElementById("historyTableBody"),
  };

  // Общее состояние приложения — доступно и aviator.js через window.AppState
  window.AppState = {
    telegramId: null,
    username: null,
    getToken: () => localStorage.getItem(TOKEN_KEY),
    setBalance: setBalance,
  };

  let pendingTelegramId = null;
  let sections = [];
  let minBet = 5, betStep = 5, maxBet = 100;
  let bet = 5;
  let currentDeg = 0;
  let spinning = false;

  // ---------- роутер экранов ----------

const TOP_LEVEL_SCREENS = ["mainMenuScreen", "casesScreen", "profileScreen"]; // тут виден нижний навбар, скрыта кнопка "назад"
  const screenStack = ["mainMenuScreen"];
  let lastTopLevelScreen = "mainMenuScreen";

  // Проигрывает анимацию входа для экрана: слайд вправо/влево при
  // переключении между "Главная" и "Профиль" в нижнем меню, иначе — плавное появление.
  function playScreenAnim(el, screenId, isSubScreen) {
    el.classList.remove("screen-anim-fade", "screen-anim-right", "screen-anim-left");
    void el.offsetWidth;

    let anim = "screen-anim-fade";
    if (!isSubScreen) {
      const prevIndex = TOP_LEVEL_SCREENS.indexOf(lastTopLevelScreen);
      const nextIndex = TOP_LEVEL_SCREENS.indexOf(screenId);
      if (prevIndex !== -1 && nextIndex !== -1 && prevIndex !== nextIndex) {
        anim = nextIndex > prevIndex ? "screen-anim-right" : "screen-anim-left";
      }
      lastTopLevelScreen = screenId;
    }
    el.classList.add(anim);
  }

  async function navigateTo(screenId, { push = true } = {}) {
    // Открытие самих игр сопровождаем коротким экраном загрузки с теми
    // же буквами GP, что и на старте приложения — под ним успевает
    // подготовиться экран (canvas самолётика меряет себя, тянутся
    // актуальные данные раунда), и переключение выглядит как осознанная
    // загрузка, а не мгновенный, но "дёрганый" щелчок между экранами.
    const isGameScreen = screenId === "wheelScreen" || screenId === "aviatorScreen" || screenId === "blackjackScreen";
    let fillDone = null;
    if (isGameScreen) {
      fillDone = showGameLoader();
    }

    [
      "loginScreen", "mainMenuScreen", "casesScreen", "caseDetailScreen", "wheelScreen",
      "aviatorScreen", "blackjackScreen", "profileScreen", "historyScreen", "inventoryScreen",
    ].forEach((id) => document.getElementById(id).classList.add("hidden"));

    const screenEl = document.getElementById(screenId);
    screenEl.classList.remove("hidden");

    // Нижний навбар виден на "верхнеуровневых" экранах (меню, профиль,
    // история) — кнопка "назад" видна в самих играх (колесо, самолётик, блэкджек).
    const isSubScreen = ["wheelScreen", "aviatorScreen", "blackjackScreen", "historyScreen", "caseDetailScreen", "inventoryScreen"].includes(screenId);
    els.bottomNav.classList.toggle("hidden", isSubScreen);
    els.backBtn.classList.toggle("hidden", !isSubScreen);

    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.target === screenId);
    });

    playScreenAnim(screenEl, screenId, isSubScreen);

    if (push) {
      if (!isSubScreen) {
        screenStack.length = 0;
      }
      screenStack.push(screenId);
    }

    let dataReady = Promise.resolve();
    if (screenId === "aviatorScreen" && window.AviatorGame) {
      // Экран уже видим (снят .hidden), поэтому canvas корректно измеряет
      // себя внутри onEnter — грузим данные раунда, пока сверху ещё виден лоадер.
      dataReady = window.AviatorGame.onEnter();
    }
    if (screenId === "wheelScreen") {
      dataReady = window.AppState.fetchRecentGames(els.wheelRecentGamesList, "wheel");
    }
    if (screenId === "blackjackScreen" && window.BlackjackGame) {
      dataReady = window.BlackjackGame.onEnter();
    }
    if (screenId === "casesScreen" && window.CasesGame) {
      dataReady = window.CasesGame.onEnter();
    }
    if (screenId === "historyScreen") {
      loadGamesHistory();
    }
    if (screenId === "inventoryScreen" && window.InventoryGame) {
      dataReady = window.InventoryGame.onEnter();
    }

    if (isGameScreen) {
      await Promise.all([fillDone, dataReady]);
      hideGameLoader();
    }
  }

  els.backBtn.addEventListener("click", () => {
    screenStack.pop();
    const prev = screenStack[screenStack.length - 1] || "mainMenuScreen";
    navigateTo(prev, { push: false });
  });

  document.querySelectorAll(".game-card, .nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.target));
  });

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

  els.logoutBtn.addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    window.location.reload();
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

    window.AppState.telegramId = me.telegram_id;
    window.AppState.username = me.username;

    els.loginScreen.classList.add("hidden");
    els.balanceChip.classList.remove("hidden");
    setBalance(me.balance);

    buildWheel();
    buildLegend();
    updateBetUI();

    els.profileName.textContent = me.username || String(me.telegram_id);
    els.profileId.textContent = `ID: ${me.telegram_id}`;
    els.profileBalance.textContent = me.balance;

    navigateTo("mainMenuScreen");
  }

  function setBalance(v) {
    els.balanceValue.textContent = v;
    els.profileBalance.textContent = v;
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
    els.betValue.value = bet;
    els.spinCost.textContent = `−${bet} шансов`;
    els.betMinus.disabled = bet <= minBet;
    els.betPlus.disabled = bet >= maxBet;
  }

  function clampBet(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return bet;
    return Math.min(maxBet, Math.max(minBet, n));
  }

  els.betMinus.addEventListener("click", () => {
    bet = Math.max(minBet, bet - betStep);
    updateBetUI();
  });
  els.betPlus.addEventListener("click", () => {
    bet = Math.min(maxBet, bet + betStep);
    updateBetUI();
  });

  els.betValue.addEventListener("input", () => {
    // Не даём вводить ничего, кроме цифр, пока пользователь печатает.
    els.betValue.value = els.betValue.value.replace(/[^0-9]/g, "");
  });
  els.betValue.addEventListener("change", () => {
    bet = clampBet(els.betValue.value);
    updateBetUI();
  });
  els.betValue.addEventListener("blur", () => {
    bet = clampBet(els.betValue.value);
    updateBetUI();
  });
  els.betValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.betValue.blur();
  });

  els.spinBtn.addEventListener("click", async () => {
    if (spinning) return;
    els.spinError.classList.add("hidden");
    els.resultBadge.classList.add("hidden");
    spinning = true;
    els.spinBtn.disabled = true;
    els.betValue.disabled = true;

    try {
      const data = await api("/api/spin", { method: "POST", auth: true, body: { bet } });
      animateTo(data.section_index, () => showResult(data));
    } catch (err) {
      els.spinError.textContent = err.message;
      els.spinError.classList.remove("hidden");
      spinning = false;
      els.spinBtn.disabled = false;
      els.betValue.disabled = false;
    }
  });

  function animateTo(index, onDone) {
    const n = sections.length;
    const step = 360 / n;
    const center = index * step + step / 2;
    const jitter = (Math.random() - 0.5) * (step * 0.5);
    const targetMod = ((360 - center - jitter) % 360 + 360) % 360;

    const extraSpins = 5;
    let newDeg = currentDeg - (currentDeg % 360) + extraSpins * 360 + targetMod;
    if (newDeg <= currentDeg) newDeg += 360;

    currentDeg = newDeg;
    els.wheel.style.transform = `rotate(${currentDeg}deg)`;

    window.setTimeout(() => {
      spinning = false;
      els.spinBtn.disabled = false;
      els.betValue.disabled = false;
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
    window.AppState.fetchRecentGames(els.wheelRecentGamesList, "wheel");
  }

  // ---------- история игр (профиль) ----------

  async function loadGamesHistory() {
    els.historyTableBody.innerHTML = `<tr><td colspan="5" class="history-empty">Загрузка…</td></tr>`;
    try {
      const data = await api("/api/games/history", { auth: true });
      if (!data.rounds.length) {
        els.historyTableBody.innerHTML = `<tr><td colspan="5" class="history-empty">Пока пусто — сыграйте первую игру.</td></tr>`;
        return;
      }
      els.historyTableBody.innerHTML = "";
      data.rounds.forEach((r) => {
        const tr = document.createElement("tr");
        const changeClass = r.balance_change > 0 ? "change-positive" : r.balance_change < 0 ? "change-negative" : "";
        const sign = r.balance_change > 0 ? "+" : "";
        const shortId = r.game_round_id.slice(0, 8);
        tr.innerHTML = `
          <td>${GAME_NAMES[r.game_type] || r.game_type}</td>
          <td class="game-id-cell" title="${r.game_round_id}">${shortId}…</td>
          <td>${r.bet}</td>
          <td>${r.result_label || "—"}</td>
          <td class="${changeClass}">${sign}${r.balance_change}</td>
        `;
        els.historyTableBody.appendChild(tr);
      });
    } catch (err) {
      els.historyTableBody.innerHTML = `<tr><td colspan="5" class="history-empty">Не удалось загрузить историю</td></tr>`;
    }
  }

  els.openHistoryBtn.addEventListener("click", () => navigateTo("historyScreen"));
  els.openInventoryBtn.addEventListener("click", () => navigateTo("inventoryScreen"));

  // ---------- API helper (общий, используется и aviator.js) ----------

  async function api(path, { method = "GET", body, auth = false, base = API_BASE } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) throw new Error("Нет сессии");
      headers["Authorization"] = "Bearer " + token;
    }
    const res = await fetch(base + path, {
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
  window.AppState.api = api;

  // ---------- "последние игры" — общая лента, используется и колесом,
  // и самолётиком (aviator.js), каждый экран запрашивает свой game_type,
  // поэтому в авиаторе больше не мелькают спины колеса и наоборот. ----------

  const GAME_LABELS = { wheel: "Колесо", aviator: "Авиатор", blackjack: "BlackJack", case: "Кейс" };

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function formatGameTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }

  function renderRecentGames(listEl, games) {
    listEl.innerHTML = "";
    if (!games || games.length === 0) {
      const li = document.createElement("li");
      li.className = "history-empty";
      li.textContent = "Игр пока не было.";
      listEl.appendChild(li);
      return;
    }
    for (const g of games) {
      const li = document.createElement("li");
      li.className = "recent-game-row";
      const changeClass = g.balance_change > 0 ? "change-positive"
        : g.balance_change < 0 ? "change-negative"
        : "change-neutral";
      const changeText = g.balance_change > 0 ? `+${g.balance_change}` : `${g.balance_change}`;
      const gameLabel = GAME_LABELS[g.game_type] || g.game_type;
      li.innerHTML = `
        <div class="rg-top">
          <span class="rg-name">${escapeHtml(g.username)}</span>
          <span class="rg-time">${formatGameTime(g.created_at)}</span>
        </div>
        <div class="rg-bottom">
          <span class="rg-bet">${escapeHtml(gameLabel)} · ставка ${g.bet}</span>
          <span class="rg-result ${changeClass}">${changeText} (${escapeHtml(g.result_label)})</span>
        </div>
      `;
      listEl.appendChild(li);
    }
  }

  // gameType: "wheel" | "aviator" — каждый экран передаёт свой, чтобы
  // ленты не смешивались.
  async function fetchRecentGames(listEl, gameType) {
    try {
      const data = await api(`/api/games/recent?game_type=${encodeURIComponent(gameType)}`, { auth: true });
      renderRecentGames(listEl, data.games);
    } catch (_) {
      // тихо — вспомогательный блок, не должен ломать саму игру
    }
  }

  window.AppState.fetchRecentGames = fetchRecentGames;
  window.AppState.navigateTo = navigateTo;

  // ---------- заморозка gif в статичный кадр (для слабых устройств) ----------
  // Используется и в кейсах (лента/список содержимого), и в инвентаре:
  // проигрывать gif-анимацию сразу в нескольких карточках одновременно
  // (особенно в быстро скроллящейся ленте открытия кейса) — гарантированный
  // лаг на слабых телефонах. Поэтому везде, кроме модалки "Управление
  // предметом", если у предмета есть только Icon_Gif (Icon_Png пуст),
  // рисуем первый кадр gif на canvas и отдаём статичный PNG вместо живой
  // анимации. Результаты кешируются по URL, чтобы не перерисовывать один
  // и тот же gif десятки раз в ленте кейса.
  const _freezeCache = new Map();

  function freezeFirstFrame(url) {
    if (!url) return Promise.resolve(null);
    if (_freezeCache.has(url)) return _freezeCache.get(url);

    const promise = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || 1;
          canvas.height = img.naturalHeight || 1;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        } catch (_) {
          // Кросс-домен без CORS-заголовков — canvas "испачкан", читать
          // пиксели нельзя. Возвращаем исходный gif как есть: лучше живая
          // анимация в одном месте, чем совсем без картинки.
          resolve(url);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });

    _freezeCache.set(url, promise);
    return promise;
  }

  // Единая точка выбора иконки ВНЕ модалок управления: всегда png, если
  // он есть; если png пуст, а gif есть — статичный (замороженный) gif.
  function staticIconFor(item) {
    if (item.icon_png) return Promise.resolve(item.icon_png);
    if (item.icon_gif) return freezeFirstFrame(item.icon_gif);
    return Promise.resolve(null);
  }

  window.AppState.freezeFirstFrame = freezeFirstFrame;
  window.AppState.staticIconFor = staticIconFor;

  // ---------- preloader ----------

  function runPreloaderFill(durationMs) {
    return new Promise((resolve) => {
      const start = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - start) / durationMs);
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
    // Узел не удаляем — тот же самый экран с буквами GP переиспользуется
    // как короткий лоадер при открытии игр (см. showGameLoader ниже).
  }

  // ---------- лоадер при открытии игры (переиспользует preloader) ----------

  function showGameLoader() {
    els.preloader.classList.remove("preloader-out");
    els.lettersWrap.classList.remove("is-filled");
    els.lettersFill.style.clipPath = "inset(100% 0 0 0)";
    return runPreloaderFill(550);
  }

  function hideGameLoader() {
    els.preloader.classList.add("preloader-out");
  }

  // ---------- boot ----------
  // Заливка идёт ПАРАЛЛЕЛЬНО с проверкой сессии — пока грузится экран,
  // мы уже успеваем узнать, залогинен ли человек, и к моменту, когда
  // прелоадер исчезает, сразу открывается либо меню, либо форма входа
  // (а не форма входа "по умолчанию" с последующим миганием).

  (async function boot() {
    const fillDone = runPreloaderFill(1400);

    let loggedIn = false;
    if (localStorage.getItem(TOKEN_KEY)) {
      try {
        // Автовход по сохранённой сессии ограничен по времени: если
        // /api/me по какой-то причине зависнет (например, "холодный
        // старт" serverless-функции или проблемный preflight-запрос),
        // мы не должны держать прелоадер на экране бесконечно — через
        // AUTOLOGIN_TIMEOUT_MS сдаёмся и показываем форму входа.
        const AUTOLOGIN_TIMEOUT_MS = 8000;
        await Promise.race([
          enterApp(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Таймаут автовхода")), AUTOLOGIN_TIMEOUT_MS)
          ),
        ]);
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
