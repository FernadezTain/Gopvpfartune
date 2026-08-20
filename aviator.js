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
    recentGamesList: document.getElementById("aviRecentGamesList"),
  };

  const ctx = els.canvas.getContext("2d");
  const MIN_BET = 1, BET_STEP = 1, MAX_BET = 500;
  const GROWTH_RATE = 0.16;   // должно совпадать с api_server.py
  const POLL_MS = 700;        // редкая сверка с сервером — растёт мультипликатор локально, по времени
  let bet = 5;

  // На телефонах ограничиваем и плотность канваса, и частоту его перерисовки:
  // devicePixelRatio на многих Android/iPhone доходит до 3, а полноэкранный
  // канвас в таком разрешении с заливкой-градиентом на каждый кадр — это и
  // есть основной источник "лагов" в самолётике на мобильных.
  const IS_MOBILE = window.matchMedia("(max-width: 640px)").matches || "ontouchstart" in window;
  const CANVAS_DPR = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);
  let mobileFrameSkip = 0;

  // Блокировка кнопки "Поставить" на BET_LOCK_MS после конца раунда
  // (краш или кэшаут) — простая и надёжная альтернатива подгонке таймеров:
  // просто даём и локальному rAF-таймеру, и 700мс-поллингу время осесть,
  // прежде чем разрешаем новую ставку. За 10 секунд это гарантированно
  // произойдёт, даже на плохой сети.
  const BET_LOCK_MS = 10000;
  let bettingLockedUntil = 0;   // performance.now(), до которого ставить нельзя
  let lockCountdownHandle = null;

  function lockBetting(ms) {
    bettingLockedUntil = performance.now() + ms;
    clearInterval(lockCountdownHandle);
    lockCountdownHandle = setInterval(() => {
      if (performance.now() >= bettingLockedUntil) {
        clearInterval(lockCountdownHandle);
        lockCountdownHandle = null;
        bettingLockedUntil = 0;
      }
      updateActionButton();
    }, 250);
    updateActionButton();
  }

  let roundStatus = "idle";   // idle | flying | crashed
  let flyingStartedAt = null; // performance.now() в момент старта полёта
  let localAnimHandle = null;
  let pollHandle = null;
  // Плавная коррекция дрейфа: вместо мгновенного "телепорта" flyingStartedAt
  // (который на графике выглядит как резкий залом кривой вверх/вниз),
  // растягиваем поправку на DRIFT_EASE_MS — кривая остаётся гладкой, даже
  // если сама поправка ощутимая (единичный всплеск RTT на нестабильной сети).
  const DRIFT_EASE_MS = 600;
  let driftFromValue = null;  // flyingStartedAt на начало текущей коррекции
  let driftTarget = null;     // куда едем (null = коррекции сейчас нет)
  let driftStartAt = null;    // performance.now() начала коррекции
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
    els.canvas.width = rect.width * CANVAS_DPR;
    els.canvas.height = rect.height * CANVAS_DPR;
    ctx.setTransform(CANVAS_DPR, 0, 0, CANVAS_DPR, 0, 0);
    gradCacheH = 0; // размер сменился — закэшированные градиенты больше не подходят
  }
  window.addEventListener("resize", resizeCanvas);

  // Градиент заливки под кривой не меняется, пока не поменяется высота
  // канваса или статус (полёт/краш) — пересоздавать его 60 раз в секунду
  // (как было раньше) незачем, это лишняя работа на каждый кадр.
  let gradCacheH = 0;
  let gradFlying = null;
  let gradCrashed = null;
  function getTrackGradient(h, crashed) {
    if (gradCacheH !== h) {
      gradFlying = null;
      gradCrashed = null;
      gradCacheH = h;
    }
    if (crashed) {
      if (!gradCrashed) {
        gradCrashed = ctx.createLinearGradient(0, 0, 0, h);
        gradCrashed.addColorStop(0, "rgba(255,92,119,0.35)");
        gradCrashed.addColorStop(1, "rgba(255,200,87,0)");
      }
      return gradCrashed;
    }
    if (!gradFlying) {
      gradFlying = ctx.createLinearGradient(0, 0, 0, h);
      gradFlying.addColorStop(0, "rgba(255,200,87,0.35)");
      gradFlying.addColorStop(1, "rgba(255,200,87,0)");
    }
    return gradFlying;
  }

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

    const grad = getTrackGradient(h, crashed);

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
      const now = performance.now();
      if (driftTarget !== null) {
        const t = Math.min(1, (now - driftStartAt) / DRIFT_EASE_MS);
        flyingStartedAt = driftFromValue + (driftTarget - driftFromValue) * t;
        if (t >= 1) driftTarget = null;
      }
      const elapsed = (now - flyingStartedAt) / 1000;
      const mult = Math.exp(GROWTH_RATE * elapsed);
      els.multiplier.textContent = `${mult.toFixed(2)}x`;
      els.multiplier.classList.remove("is-crashed");
      history.push({ t: elapsed, mult });
      if (history.length > 400) history.shift();

      // Цифра множителя обновляется каждый кадр (это просто текст — дёшево),
      // а сама перерисовка канваса на телефонах прорежена вдвое: график
      // визуально всё равно гладкий, а нагрузка на GPU ощутимо ниже.
      mobileFrameSkip++;
      if (!IS_MOBILE || mobileFrameSkip % 2 === 0) {
        drawGraph(mult, false);
      }
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
          // Синкаем только при заметном дрейфе (>80мс), но саму коррекцию
          // не применяем мгновенно — запускаем плавный переход (см. frame()
          // в startLocalAnimation), чтобы не было залома на графике даже
          // при большом одноразовом всплеске RTT.
          if (Math.abs(newFlyingStartedAt - flyingStartedAt) > 80) {
            driftFromValue = flyingStartedAt;
            driftTarget = newFlyingStartedAt;
            driftStartAt = performance.now();
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
    lockBetting(BET_LOCK_MS);
    updateActionButton();
    fetchRecentGames();
  }

  function resetRoundUI() {
    stopLocalAnimation();
    stopPolling();
    roundStatus = "idle";
    flyingStartedAt = null;
    driftTarget = null;
    history.length = 0;
    els.multiplier.classList.remove("is-crashed");
    els.multiplier.textContent = "1.00x";
    els.status.textContent = "Ставьте, когда будете готовы.";
    els.screen.classList.remove("is-flying", "is-crashed");
    els.plane.classList.add("is-hidden");
    hideError();
    updateActionButton();
  }

  // ---------- последние 5 игр (всех игроков, только Авиатор) ----------
  //
  // Рендер вынесен в app.js (window.AppState.fetchRecentGames) и общий
  // с колесом — здесь просто передаём свой контейнер и game_type, чтобы
  // в этой ленте показывались только раунды самолётика, а не колеса.

  function fetchRecentGames() {
    return AppState.fetchRecentGames(els.recentGamesList, "aviator");
  }

  // ---------- ставка / кэшаут ----------

  function updateActionButton() {
    els.actionBtn.classList.remove("is-cashout");
    els.actionBtn.disabled = false;
    els.betValue.disabled = roundStatus === "flying";

    if (roundStatus === "idle" || roundStatus === "crashed") {
      const msLeft = bettingLockedUntil - performance.now();
      if (msLeft > 0) {
        const secsLeft = Math.ceil(msLeft / 1000);
        els.actionBtn.disabled = true;
        els.actionText.textContent = `Подождите ${secsLeft}с`;
        els.actionCost.textContent = "";
      } else {
        els.actionText.textContent = "Поставить";
        els.actionCost.textContent = `−${bet} GP`;
      }
    } else if (roundStatus === "flying") {
      els.actionBtn.classList.add("is-cashout");
      els.actionText.textContent = "Забрать";
      els.actionCost.textContent = els.multiplier.textContent;
    }
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
        // t0 — момент отправки запроса на СВОИХ часах (performance.now()).
        const t0 = performance.now();
        const data = await AppState.api("/api/aviator/bet", { method: "POST", auth: true, body: { bet } });
        roundStatus = "flying";
        // ВАЖНО: раньше пробовали синхронизироваться через абсолютные часы
        // (Date.now() на клиенте vs data.started_flying_at с сервера).
        // Это сломалось: если системные часы сервера (Deploy-f, Алматы)
        // сбиты — а там уже были проблемы с сетью/NTP — разница между
        // часами клиента и сервера даёт ПОСТОЯННЫЙ сдвиг, из-за которого
        // каждый новый раунд стартовал с одного и того же завышенного
        // значения («продолжает от того, где закончил прошлый»).
        //
        // Правильно — не трогать абсолютное время вообще. Используем тот
        // же приём, что и в startPolling()/onEnter(): берём относительный
        // multiplier с сервера и компенсируем сетевую задержку через RTT/2
        // на СВОИХ часах (performance.now()) — это не зависит от того,
        // насколько точны часы сервера, только от симметричности сети.
        const rtt = performance.now() - t0;
        const serverSampleTime = t0 + rtt / 2;
        const elapsedGuess = Math.log(data.multiplier) / GROWTH_RATE;
        flyingStartedAt = serverSampleTime - elapsedGuess * 1000;
        const nowPerf = performance.now();
        const elapsedNow = Math.max(0, (nowPerf - flyingStartedAt) / 1000);
        const multNow = Math.exp(GROWTH_RATE * elapsedNow);
        history.length = 0;
        history.push({ t: 0, mult: 1 }); // якорь начала графика
        history.push({ t: elapsedNow, mult: multNow });
        driftTarget = null; // на всякий случай гасим незавершённую коррекцию прошлого полёта
        els.status.textContent = "Полёт!";
        els.multiplier.textContent = `${multNow.toFixed(2)}x`;
        els.multiplier.classList.remove("is-crashed");
        els.screen.classList.remove("is-crashed");
        els.screen.classList.add("is-flying");
        AppState.setBalance(data.new_balance);
        startLocalAnimation();
        startPolling();
      } else if (roundStatus === "flying") {
        stopLocalAnimation();
        stopPolling();
        const data = await cashoutWithRetry();
        if (typeof data.new_balance === "number") AppState.setBalance(data.new_balance);
        // Табло держало последнее локально анимированное значение — пока
        // запрос шёл до сервера, реальный множитель успел чуть подрасти.
        // Показываем именно то число, по которому реально начислили выигрыш,
        // а не «замороженный» локальный кадр — иначе цифра на табло и в
        // сообщении разъезжаются.
        els.multiplier.textContent = `${data.multiplier.toFixed(2)}x`;
        showError(`Забрали ${data.payout} при ${data.multiplier.toFixed(2)}x`);
        roundStatus = "idle";
        lockBetting(BET_LOCK_MS);
        els.status.textContent = "Ставьте снова, когда будете готовы.";
        els.screen.classList.remove("is-flying");
        els.plane.classList.add("is-hidden");
        fetchRecentGames();
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

  // ---------- надёжный кэшаут ----------
  //
  // Раньше клик "Забрать" делал ОДИН запрос через AppState.api(). Если
  // сеть моргала именно в этот момент (запрос ушёл, но ответ не
  // вернулся — или наоборот, вообще не ушёл), игрок видел ошибку или
  // зависшую кнопку, решал "ну и ладно, видимо разбился", а на сервере
  // ставка оставалась 'pending', и раунд продолжал лететь. Потом,
  // зайдя в игру заново, игрок получал этот раунд обратно — но уже с
  // огромным множителем, как будто он не останавливался.
  //
  // Теперь: при обрыве СЕТИ (запрос не дошёл до сервера или ответ не
  // вернулся) — повторяем запрос до 3 раз. Это безопасно благодаря
  // идемпотентности кэшаута на сервере (см. api_server.py): повторный
  // вызов вернёт тот же самый результат, а не проведёт кэшаут дважды.
  // Если сервер ответил ЧЕТКО (например "уже разбился") — это
  // окончательный ответ, повторять не нужно.
  async function cashoutWithRetry(maxAttempts = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await AppState.api("/api/aviator/cashout", { method: "POST", auth: true });
        return data;
      } catch (e) {
        lastErr = e;
        // Ошибки вида "Самолётик уже разбился" / "Активного полёта нет" /
        // "Нет токена" — это осмысленный ответ сервера (или локальная
        // проверка), а не обрыв связи. Ретраить их бессмысленно и вредно
        // (можно зациклиться на настоящем отказе) — сразу выходим.
        const definitive = /разбился|Активного полёта нет|Нет токена|Сессия недействительна/i.test(e.message || "");
        if (definitive || attempt === maxAttempts) throw e;
        // Небольшая пауза перед повтором (сеть могла ненадолго пропасть).
        await new Promise((r) => setTimeout(r, 350 * attempt));
      }
    }
    throw lastErr;
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.remove("hidden");
  }
  function hideError() {
    els.error.classList.add("hidden");
  }

  // ---------- вызывается при входе на экран самолётика ----------

  // Сколько секунд полёта можно списать на "обычный реконнект" (открыли
  // приложение через пару секунд после того, как сами же поставили) —
  // до этого порога подхватываем раунд молча, как и раньше. Если раунд
  // летит дольше — это, вероятнее всего, "зомби" от ставки, чей кэшаут
  // не подтвердился на сервере (см. cashoutWithRetry и комментарий в
  // api_server.py), и мы явно предупреждаем игрока, а не тихо продолжаем
  // с уже выросшим множителем, как будто ничего не произошло.
  const STALE_ROUND_SECONDS = 4;

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
        driftTarget = null; // стартуем без незавершённой коррекции
        history.length = 0;
        els.multiplier.textContent = `${state.multiplier.toFixed(2)}x`;
        els.screen.classList.remove("is-crashed");
        els.screen.classList.add("is-flying");

        const isStale = typeof state.flying_seconds === "number" && state.flying_seconds > STALE_ROUND_SECONDS;
        if (isStale) {
          // Не выдумываем нового поведения игры (раунд по-прежнему честно
          // долетит своим ходом) — просто громко сообщаем, что это старый,
          // незавершённый полёт, а не только что начатый, чтобы игрок не
          // тратил время, разглядывая табло, думая, что оно только
          // стартовало с 1.00x.
          els.status.textContent = `Продолжаем незавершённый полёт (уже в воздухе ${Math.round(state.flying_seconds)}с) — заберите выигрыш`;
          showError("Обнаружена незакрытая предыдущая ставка — заберите её, пока не разбилась");
        } else {
          els.status.textContent = "Полёт!";
          hideError();
        }

        startLocalAnimation();
        startPolling();
      } else {
        resetRoundUI();
      }
      updateActionButton();
    } catch (_) {
      els.status.textContent = "Не удалось подключиться";
    }
    fetchRecentGames();
  }

  window.AviatorGame = { onEnter };
})();
