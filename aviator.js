(function () {
  "use strict";

  // Ждём, пока app.js создаст window.AppState (порядок подключения
  // скриптов в index.html: config.js -> app.js -> aviator.js).
  const AppState = window.AppState;

  const els = {
    canvas: document.getElementById("aviatorCanvas"),
    multiplier: document.getElementById("aviatorMultiplier"),
    status: document.getElementById("aviatorStatus"),
    betMinus: document.getElementById("aviBetMinus"),
    betPlus: document.getElementById("aviBetPlus"),
    betValue: document.getElementById("aviBetValue"),
    actionBtn: document.getElementById("aviActionBtn"),
    actionText: document.getElementById("aviActionText"),
    actionCost: document.getElementById("aviActionCost"),
    error: document.getElementById("aviError"),
    playersList: document.getElementById("aviPlayersList"),
  };

  const ctx = els.canvas.getContext("2d");
  const MIN_BET = 1, BET_STEP = 1, MAX_BET = 500;
  const GROWTH_RATE = 0.16;   // должно совпадать с api_server.py
  const POLL_MS = 700;        // редкая сверка с сервером — растёт мультипликатор локально, по времени
  let bet = 5;

  let roundStatus = "idle";   // idle | flying | crashed
  let flyingStartedAt = null; // performance.now() в момент старта полёта
  let localAnimHandle = null;
  let pollHandle = null;

  const history = []; // точки графика [{t, mult}]

  // ---------- canvas ----------

  function resizeCanvas() {
    const rect = els.canvas.parentElement.getBoundingClientRect();
    els.canvas.width = rect.width * devicePixelRatio;
    els.canvas.height = rect.height * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);

  function drawGraph(currentMult, crashed) {
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) return;

    const maxT = history[history.length - 1].t || 1;
    const maxMult = Math.max(2, currentMult * 1.15);

    const toX = (t) => (t / maxT) * (w * 0.85) + w * 0.05;
    const toY = (m) => h - ((m - 1) / (maxMult - 1)) * (h * 0.8) - h * 0.08;

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(1));
    history.forEach((p) => ctx.lineTo(toX(p.t), toY(p.mult)));

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, crashed ? "rgba(255,92,119,0.35)" : "rgba(255,200,87,0.35)");
    grad.addColorStop(1, "rgba(255,200,87,0)");

    ctx.lineTo(toX(history[history.length - 1].t), h);
    ctx.lineTo(toX(0), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(1));
    history.forEach((p) => ctx.lineTo(toX(p.t), toY(p.mult)));
    ctx.strokeStyle = crashed ? "#ff5c77" : "#ffc857";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // ---------- локальная анимация роста коэффициента (mult = exp(RATE*t)) ----------
  // Сервер лишь изредка подтверждает статус (poll) и решает, где реально
  // проходит точка краша — она секретна и известна только ему.

  function startLocalAnimation() {
    stopLocalAnimation();
    function frame() {
      if (roundStatus !== "flying" || flyingStartedAt === null) return;
      const elapsed = (performance.now() - flyingStartedAt) / 1000;
      const mult = Math.exp(GROWTH_RATE * elapsed);
      els.multiplier.textContent = `${mult.toFixed(2)}x`;
      els.multiplier.classList.remove("is-crashed");
      history.push({ t: elapsed, mult });
      if (history.length > 400) history.shift();
      drawGraph(mult, false);
      updateActionButton();
      localAnimHandle = requestAnimationFrame(frame);
    }
    localAnimHandle = requestAnimationFrame(frame);
  }

  function stopLocalAnimation() {
    if (localAnimHandle) {
      cancelAnimationFrame(localAnimHandle);
      localAnimHandle = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollHandle = setInterval(async () => {
      if (roundStatus !== "flying") return;
      try {
        const state = await AppState.api("/api/aviator/state", { auth: true });
        if (!state.has_round) {
          // сервер решил, что полёт уже разбился (ленивое завершение по времени) —
          // локально мы это ещё не знали, отдельного push-уведомления нет
          handleCrash();
        } else if (typeof state.multiplier === "number") {
          // подтягиваем локальный таймер к серверному множителю, чтобы
          // рассинхрон (throttling вкладки, дрейф rAF и т.п.) не копился
          const elapsedGuess = Math.log(state.multiplier) / GROWTH_RATE;
          flyingStartedAt = performance.now() - elapsedGuess * 1000;
        }
      } catch (_) {
        // сеть моргнула — не страшно, попробуем на следующем тике
      }
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  function handleCrash() {
    stopLocalAnimation();
    stopPolling();
    roundStatus = "crashed";
    els.multiplier.classList.add("is-crashed");
    els.status.textContent = "Разбился! Ставьте снова.";
    showError("Не успели — ставка сгорела");
    updateActionButton();
  }

  function resetRoundUI() {
    stopLocalAnimation();
    stopPolling();
    roundStatus = "idle";
    flyingStartedAt = null;
    history.length = 0;
    els.multiplier.classList.remove("is-crashed");
    els.multiplier.textContent = "1.00x";
    els.status.textContent = "Ставьте, когда будете готовы.";
    hideError();
    renderOwnStatus();
    updateActionButton();
  }

  // ---------- статус собственной ставки (раунды личные — общего списка игроков нет) ----------

  function renderOwnStatus() {
    els.playersList.innerHTML = "";
    const li = document.createElement("li");
    if (roundStatus === "idle") {
      li.className = "history-empty";
      li.textContent = "Ваш полёт начнётся сразу после ставки.";
    } else if (roundStatus === "flying") {
      li.className = "pending";
      li.textContent = `В полёте — ставка ${bet}`;
    } else if (roundStatus === "crashed") {
      li.textContent = "Разбился — ставка сгорела";
    }
    els.playersList.appendChild(li);
  }

  // ---------- ставка / кэшаут ----------

  function updateActionButton() {
    els.actionBtn.classList.remove("is-cashout");
    els.actionBtn.disabled = false;

    if (roundStatus === "idle" || roundStatus === "crashed") {
      els.actionText.textContent = "Поставить";
      els.actionCost.textContent = `−${bet} шансов`;
    } else if (roundStatus === "flying") {
      els.actionBtn.classList.add("is-cashout");
      els.actionText.textContent = "Забрать";
      els.actionCost.textContent = els.multiplier.textContent;
    }
    renderOwnStatus();
  }

  els.betMinus.addEventListener("click", () => {
    if (roundStatus === "flying") return;
    bet = Math.max(MIN_BET, bet - BET_STEP);
    els.betValue.textContent = bet;
    updateActionButton();
  });
  els.betPlus.addEventListener("click", () => {
    if (roundStatus === "flying") return;
    bet = Math.min(MAX_BET, bet + BET_STEP);
    els.betValue.textContent = bet;
    updateActionButton();
  });

  els.actionBtn.addEventListener("click", async () => {
    hideError();
    els.actionBtn.disabled = true;
    try {
      if (roundStatus === "idle" || roundStatus === "crashed") {
        const data = await AppState.api("/api/aviator/bet", { method: "POST", auth: true, body: { bet } });
        roundStatus = "flying";
        // Раунд общий: пока запрос летел туда-обратно (или если раунд
        // уже был запущен раньше — например другим игроком), реальный
        // множитель на сервере мог уйти вперёд от 1.00x. Синхронизируем
        // локальный таймер по факту, а не считаем, что старт — это
        // момент получения ответа (иначе именно тут возникает рассинхрон
        // между тем, что показывает клиент, и тем, что считает сервер
        // при кэшауте).
        const startMult = data.multiplier || 1;
        const elapsedGuess = Math.log(startMult) / GROWTH_RATE;
        flyingStartedAt = performance.now() - elapsedGuess * 1000;
        history.length = 0;
        history.push({ t: elapsedGuess, mult: startMult });
        els.status.textContent = "Полёт!";
        els.multiplier.textContent = `${startMult.toFixed(2)}x`;
        els.multiplier.classList.remove("is-crashed");
        AppState.setBalance(data.new_balance);
        startLocalAnimation();
        startPolling();
      } else if (roundStatus === "flying") {
        stopLocalAnimation();
        stopPolling();
        const data = await AppState.api("/api/aviator/cashout", { method: "POST", auth: true });
        AppState.setBalance(data.new_balance);
        // Табло держало последнее локально анимированное значение — пока
        // запрос шёл до сервера, реальный множитель успел чуть подрасти.
        // Показываем именно то число, по которому реально начислили выигрыш,
        // а не «замороженный» локальный кадр — иначе цифра на табло и в
        // сообщении разъезжаются.
        els.multiplier.textContent = `${data.multiplier.toFixed(2)}x`;
        showError(`Забрали ${data.payout} при ${data.multiplier.toFixed(2)}x`);
        roundStatus = "idle";
        els.status.textContent = "Ставьте снова, когда будете готовы.";
      }
    } catch (e) {
      showError(e.message);
      // если кэшаут не прошёл (например, уже разбился) — сверим реальный статус с сервером
      if (roundStatus === "flying") {
        try {
          const state = await AppState.api("/api/aviator/state", { auth: true });
          if (!state.has_round) handleCrash();
        } catch (_) { /* ignore */ }
      }
    } finally {
      updateActionButton();
    }
  });

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.remove("hidden");
  }
  function hideError() {
    els.error.classList.add("hidden");
  }

  // ---------- вызывается при входе на экран самолётика ----------

  async function onEnter() {
    resizeCanvas();
    els.betValue.textContent = bet;
    try {
      const state = await AppState.api("/api/aviator/state", { auth: true });
      if (state.has_round && state.status === "flying") {
        roundStatus = "flying";
        bet = state.bet;
        els.betValue.textContent = bet;
        // Восстанавливаем локальный старт полёта из текущего множителя,
        // чтобы анимация продолжилась с правильного места после reload:
        // mult = exp(RATE*t) -> t = ln(mult)/RATE
        const elapsedGuess = Math.log(state.multiplier) / GROWTH_RATE;
        flyingStartedAt = performance.now() - elapsedGuess * 1000;
        history.length = 0;
        els.status.textContent = "Полёт!";
        els.multiplier.textContent = `${state.multiplier.toFixed(2)}x`;
        startLocalAnimation();
        startPolling();
      } else {
        resetRoundUI();
      }
      updateActionButton();
    } catch (_) {
      els.status.textContent = "Не удалось подключиться";
    }
  }

  window.AviatorGame = { onEnter };
})();
