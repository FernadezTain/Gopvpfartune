(function () {
  "use strict";

  // Ждём, пока app.js создаст window.AppState (порядок подключения
  // скриптов в index.html: config.js -> app.js -> aviator.js).
  const AppState = window.AppState;

  const els = {
    screen: document.getElementById("aviatorScreen"),
    canvas: document.getElementById("aviatorCanvas"),
    plane: document.getElementById("aviatorPlane"),
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
  // Инвалидирует ответы на устаревшие /state-запросы: если кэшаут и
  // новая ставка успевают произойти быстрее, чем вернётся ответ на
  // /state от ПРЕДЫДУЩЕГО полёта, этот ответ, придя позже, не должен
  // переписывать таймер уже нового раунда — иначе табло "скачет" на
  // множитель из прошлого полёта (баг, который чинит этот токен).
  let pollToken = 0;

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

    if (history.length < 2) {
      els.plane.classList.add("is-hidden");
      return;
    }

    const maxT = history[history.length - 1].t || 1;
    const maxMult = Math.max(2, currentMult * 1.15);

    const toX = (t) => (t / maxT) * (w * 0.82) + w * 0.06;
    const toY = (m) => h - ((m - 1) / (maxMult - 1)) * (h * 0.78) - h * 0.1;

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

    // Самолётик едет на самом кончике кривой, развёрнутый по касательной
    // к последнему участку графика — небольшой штрих, который делает
    // табло похожим на приборную панель, а не просто линию на графике.
    const last = history[history.length - 1];
    const prev = history[history.length - 2] || last;
    const lastX = toX(last.t), lastY = toY(last.mult);
    const prevX = toX(prev.t), prevY = toY(prev.mult);
    const angle = Math.atan2(lastY - prevY, lastX - prevX) * (180 / Math.PI);

    els.plane.style.left = `${lastX}px`;
    els.plane.style.top = `${lastY}px`;
    els.plane.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    els.plane.classList.remove("is-hidden");
    els.plane.classList.toggle("is-crashed", crashed);
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
    const myToken = pollToken;
    pollHandle = setInterval(async () => {
      if (roundStatus !== "flying" || myToken !== pollToken) return;
      // t0 — момент отправки запроса. Множитель в ответе соответствует
      // тому, что было на сервере где-то между t0 и моментом получения
      // ответа (RTT). Берём середину этого интервала как оценку истинного
      // момента — так компенсируем сетевую задержку, а не добавляем её
      // целиком к таймеру (что и вызывало прыжки табло вперёд).
      const t0 = performance.now();
      try {
        const state = await AppState.api("/api/aviator/state", { auth: true });
        // Пока ждали ответ, раунд мог уже смениться (кэшаут + новая
        // ставка). Если токен уже не совпадает — это ответ по старому,
        // неактуальному полёту, применять его нельзя.
        if (myToken !== pollToken || roundStatus !== "flying") return;
        if (!state.has_round) {
          // сервер решил, что полёт уже разбился (ленивое завершение по времени) —
          // локально мы это ещё не знали, отдельного push-уведомления нет
          handleCrash();
        } else if (typeof state.multiplier === "number") {
          const rtt = performance.now() - t0;
          const serverSampleTime = t0 + rtt / 2;
          const elapsedGuess = Math.log(state.multiplier) / GROWTH_RATE;
          const newFlyingStartedAt = serverSampleTime - elapsedGuess * 1000;
          // Синкаем только при заметном дрейфе (>80мс) — иначе микро-разницы
          // от асимметрии RTT будут дёргать табло почём зря.
          if (Math.abs(newFlyingStartedAt - flyingStartedAt) > 80) {
            flyingStartedAt = newFlyingStartedAt;
          }
        }
      } catch (_) {
        // сеть моргнула — не страшно, попробуем на следующем тике
      }
    }, POLL_MS);
  }

  function stopPolling() {
    pollToken++; // любой ещё летящий по сети ответ прошлого опроса теперь считается устаревшим
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
    els.screen.classList.remove("is-flying");
    els.screen.classList.add("is-crashed");
    els.plane.classList.add("is-crashed");
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
    els.screen.classList.remove("is-flying", "is-crashed");
    els.plane.classList.add("is-hidden");
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
    els.betValue.disabled = roundStatus === "flying";

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

  function clampBet(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return bet;
    return Math.min(MAX_BET, Math.max(MIN_BET, n));
  }

  els.betMinus.addEventListener("click", () => {
    if (roundStatus === "flying") return;
    bet = Math.max(MIN_BET, bet - BET_STEP);
    els.betValue.value = bet;
    updateActionButton();
  });
  els.betPlus.addEventListener("click", () => {
    if (roundStatus === "flying") return;
    bet = Math.min(MAX_BET, bet + BET_STEP);
    els.betValue.value = bet;
    updateActionButton();
  });

  els.betValue.addEventListener("input", () => {
    els.betValue.value = els.betValue.value.replace(/[^0-9]/g, "");
  });
  els.betValue.addEventListener("change", () => {
    bet = clampBet(els.betValue.value);
    els.betValue.value = bet;
    updateActionButton();
  });
  els.betValue.addEventListener("blur", () => {
    bet = clampBet(els.betValue.value);
    els.betValue.value = bet;
    updateActionButton();
  });
  els.betValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.betValue.blur();
  });

  els.actionBtn.addEventListener("click", async () => {
    hideError();
    els.actionBtn.disabled = true;
    try {
      if (roundStatus === "idle" || roundStatus === "crashed") {
        const data = await AppState.api("/api/aviator/bet", { method: "POST", auth: true, body: { bet } });
        roundStatus = "flying";
        // Каждая ставка теперь всегда открывает свой собственный, новый
        // раунд на сервере (started_flying_at = now()) — значит честный
        // старт всегда 1.00x. Сбрасываем локально сразу, не дожидаясь
        // и не подстраиваясь под multiplier из ответа: так табло гарантированно
        // показывает 1.00x в момент старта, а не «доедет» до какого-то
        // промежуточного числа из-за сетевой задержки.
        history.length = 0;
        history.push({ t: 0, mult: 1 });
        flyingStartedAt = performance.now();
        els.status.textContent = "Полёт!";
        els.multiplier.textContent = "1.00x";
        els.multiplier.classList.remove("is-crashed");
        els.screen.classList.remove("is-crashed");
        els.screen.classList.add("is-flying");
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
        els.screen.classList.remove("is-flying");
        els.plane.classList.add("is-hidden");
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
    els.betValue.value = bet;
    // t0 — момент отправки запроса, нужен для той же компенсации RTT,
    // что и в startPolling: без неё табло после reload «доезжает» вперёд
    // на время задержки сети.
    const t0 = performance.now();
    try {
      const state = await AppState.api("/api/aviator/state", { auth: true });
      if (state.has_round && state.status === "flying") {
        roundStatus = "flying";
        bet = state.bet;
        els.betValue.value = bet;
        // Восстанавливаем локальный старт полёта из текущего множителя,
        // чтобы анимация продолжилась с правильного места после reload:
        // mult = exp(RATE*t) -> t = ln(mult)/RATE
        const rtt = performance.now() - t0;
        const serverSampleTime = t0 + rtt / 2;
        const elapsedGuess = Math.log(state.multiplier) / GROWTH_RATE;
        flyingStartedAt = serverSampleTime - elapsedGuess * 1000;
        history.length = 0;
        els.status.textContent = "Полёт!";
        els.multiplier.textContent = `${state.multiplier.toFixed(2)}x`;
        els.screen.classList.remove("is-crashed");
        els.screen.classList.add("is-flying");
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
