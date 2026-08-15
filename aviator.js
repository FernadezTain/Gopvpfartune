(function () {
  "use strict";

  // Ждём, пока app.js создаст window.AppState (порядок подключения
  // скриптов в index.html: config.js -> app.js -> aviator.js).
  const AppState = window.AppState;
  const AVI_BASE = window.AVIATOR_API_BASE.replace(/\/$/, "");

  const supabaseClient = window.supabase.createClient(
    window.SUPABASE_URL,
    window.SUPABASE_ANON_KEY
  );

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
  let bet = 5;

  let roundId = null;
  let roundStatus = "waiting";   // waiting | flying | crashed
  let myBetPlaced = false;
  let myBetCashedOut = false;

  const history = []; // точки графика [{t, mult}]
  let flyingStartedAt = null;
  let lastCrashPoint = null;

  let betsChannel = null;
  const playersInRound = new Map(); // user_id -> {username, bet, status, cashout_multiplier}

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

  // ---------- realtime: рост коэффициента (broadcast, не таблица) ----------

  const liveChannel = supabaseClient.channel("aviator:live");
  liveChannel
    .on("broadcast", { event: "tick" }, ({ payload }) => handleEngineEvent(payload))
    .subscribe();

  function handleEngineEvent(payload) {
    if (payload.type === "waiting") {
      resetRoundUI();
      roundId = payload.round_id;
      roundStatus = "waiting";
      els.status.textContent = `Приём ставок… ${payload.seconds}с`;
      subscribeToRoundBets(roundId);
    } else if (payload.type === "flying_start") {
      roundStatus = "flying";
      flyingStartedAt = performance.now();
      history.length = 0;
      history.push({ t: 0, mult: 1 });
      els.status.textContent = "Полёт!";
      updateActionButton();
    } else if (payload.type === "tick") {
      roundStatus = "flying";
      const t = (performance.now() - flyingStartedAt) / 1000;
      history.push({ t, mult: payload.multiplier });
      els.multiplier.textContent = `${payload.multiplier.toFixed(2)}x`;
      els.multiplier.classList.remove("is-crashed");
      drawGraph(payload.multiplier, false);
    } else if (payload.type === "crashed") {
      roundStatus = "crashed";
      lastCrashPoint = payload.crash_point;
      els.multiplier.textContent = `${payload.crash_point.toFixed(2)}x`;
      els.multiplier.classList.add("is-crashed");
      els.status.textContent = "Разбился! Новый раунд скоро…";
      drawGraph(payload.crash_point, true);
      updateActionButton();
      if (myBetPlaced && !myBetCashedOut) {
        showError("Не успели — ставка сгорела");
      }
    }
  }

  function resetRoundUI() {
    myBetPlaced = false;
    myBetCashedOut = false;
    els.multiplier.classList.remove("is-crashed");
    els.multiplier.textContent = "1.00x";
    hideError();
    playersInRound.clear();
    renderPlayersList();
    if (betsChannel) {
      supabaseClient.removeChannel(betsChannel);
      betsChannel = null;
    }
    updateActionButton();
  }

  // ---------- realtime: список игроков раунда (таблица aviator_bets) ----------

  function subscribeToRoundBets(rId) {
    betsChannel = supabaseClient
      .channel(`aviator_bets:${rId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "aviator_bets", filter: `round_id=eq.${rId}` },
        (payload) => {
          playersInRound.set(payload.new.user_id, payload.new);
          renderPlayersList();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "aviator_bets", filter: `round_id=eq.${rId}` },
        (payload) => {
          playersInRound.set(payload.new.user_id, payload.new);
          renderPlayersList();
          if (payload.new.user_id === AppState.telegramId && payload.new.status === "cashed_out") {
            myBetCashedOut = true;
            AppState.setBalance(currentBalanceGuess(payload.new));
            updateActionButton();
          }
        }
      )
      .subscribe();
  }

  function currentBalanceGuess(betRow) {
    // Баланс окончательно подтянется при следующем /api/me, но для
    // мгновенной обратной связи прибавляем payout сразу на клиенте.
    const shown = Number(document.getElementById("balanceValue").textContent) || 0;
    return shown + betRow.payout;
  }

  function renderPlayersList() {
    els.playersList.innerHTML = "";
    if (!playersInRound.size) {
      els.playersList.innerHTML = `<li class="history-empty">Пока никто не поставил.</li>`;
      return;
    }
    [...playersInRound.values()]
      .sort((a, b) => b.bet - a.bet)
      .forEach((p) => {
        const li = document.createElement("li");
        const name = p.username || String(p.user_id);
        if (p.status === "cashed_out") {
          li.className = "cashed-out";
          li.innerHTML = `<span>${name}</span><span>+${p.payout} (${Number(p.cashout_multiplier).toFixed(2)}x)</span>`;
        } else if (p.status === "lost") {
          li.innerHTML = `<span>${name}</span><span>−${p.bet}</span>`;
        } else {
          li.className = "pending";
          li.innerHTML = `<span>${name}</span><span>ставка ${p.bet}</span>`;
        }
        els.playersList.appendChild(li);
      });
  }

  // ---------- ставка / кэшаут ----------

  function updateActionButton() {
    els.actionBtn.classList.remove("is-cashout");
    els.actionBtn.disabled = false;

    if (roundStatus === "waiting" && !myBetPlaced) {
      els.actionText.textContent = "Поставить";
      els.actionCost.textContent = `−${bet} шансов`;
    } else if (roundStatus === "waiting" && myBetPlaced) {
      els.actionText.textContent = "Ставка принята";
      els.actionCost.textContent = "Ждём старта…";
      els.actionBtn.disabled = true;
    } else if (roundStatus === "flying" && myBetPlaced && !myBetCashedOut) {
      els.actionBtn.classList.add("is-cashout");
      els.actionText.textContent = "Забрать";
      els.actionCost.textContent = els.multiplier.textContent;
    } else {
      els.actionText.textContent = roundStatus === "flying" ? "Ставки закрыты" : "Ждите новый раунд";
      els.actionCost.textContent = "";
      els.actionBtn.disabled = true;
    }
  }

  els.betMinus.addEventListener("click", () => {
    bet = Math.max(MIN_BET, bet - BET_STEP);
    els.betValue.textContent = bet;
    updateActionButton();
  });
  els.betPlus.addEventListener("click", () => {
    bet = Math.min(MAX_BET, bet + BET_STEP);
    els.betValue.textContent = bet;
    updateActionButton();
  });

  els.actionBtn.addEventListener("click", async () => {
    hideError();
    els.actionBtn.disabled = true;
    try {
      if (roundStatus === "waiting" && !myBetPlaced) {
        const data = await AppState.api("/aviator/bet", { method: "POST", auth: true, body: { bet }, base: AVI_BASE });
        myBetPlaced = true;
        AppState.setBalance(data.new_balance);
      } else if (roundStatus === "flying" && myBetPlaced && !myBetCashedOut) {
        const data = await AppState.api("/aviator/cashout", { method: "POST", auth: true, base: AVI_BASE });
        myBetCashedOut = true;
        AppState.setBalance(data.new_balance);
      }
    } catch (err) {
      showError(err.message);
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
      const state = await AppState.api("/aviator/state", { base: AVI_BASE });
      roundId = state.round_id;
      roundStatus = state.status;
      if (state.status === "flying") {
        els.status.textContent = "Полёт!";
        els.multiplier.textContent = `${state.multiplier.toFixed(2)}x`;
      } else {
        els.status.textContent = "Ожидание ставок…";
      }
      updateActionButton();
    } catch (_) {
      els.status.textContent = "Не удалось подключиться к раунду";
    }
  }

  window.AviatorGame = { onEnter };
})();
