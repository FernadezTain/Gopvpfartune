(function () {
  "use strict";

  // config.js -> app.js -> aviator.js -> blackjack.js — AppState уже готов.
  const AppState = window.AppState;

  const els = {
    screen: document.getElementById("blackjackScreen"),
    dealerCards: document.getElementById("bjDealerCards"),
    dealerTotal: document.getElementById("bjDealerTotal"),
    playerCards: document.getElementById("bjPlayerCards"),
    playerTotal: document.getElementById("bjPlayerTotal"),
    status: document.getElementById("bjStatus"),
    betMinus: document.getElementById("bjBetMinus"),
    betPlus: document.getElementById("bjBetPlus"),
    betValue: document.getElementById("bjBetValue"),
    dealBtn: document.getElementById("bjDealBtn"),
    dealCost: document.getElementById("bjDealCost"),
    actions: document.getElementById("bjActions"),
    hitBtn: document.getElementById("bjHitBtn"),
    standBtn: document.getElementById("bjStandBtn"),
    doubleBtn: document.getElementById("bjDoubleBtn"),
    error: document.getElementById("bjError"),
    recentGamesList: document.getElementById("bjRecentGamesList"),
  };

  const MIN_BET = 1, BET_STEP = 1, MAX_BET = 100;
  let bet = 5;
  let handId = null;
  let handStatus = "idle"; // idle | active | finished
  let canDouble = false;

  const RED_SUITS = new Set(["♥", "♦"]);

  function renderCards(container, cards, hideSecond) {
    container.innerHTML = "";
    cards.forEach((c, i) => {
      const el = document.createElement("div");
      const isHidden = hideSecond && i === 1;
      el.className = "bj-card" + (isHidden ? " bj-card-back" : "");
      if (!isHidden) {
        el.classList.toggle("is-red", RED_SUITS.has(c.s));
        el.innerHTML = `<span>${c.r}</span><span>${c.s}</span>`;
      }
      container.appendChild(el);
    });
  }

  function updateBetUI() {
    els.betValue.value = bet;
    els.dealCost.textContent = `−${bet} шансов`;
    els.betMinus.disabled = bet <= MIN_BET;
    els.betPlus.disabled = bet >= MAX_BET;
  }
  function clampBet(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return bet;
    return Math.min(MAX_BET, Math.max(MIN_BET, n));
  }

  els.betMinus.addEventListener("click", () => { bet = Math.max(MIN_BET, bet - BET_STEP); updateBetUI(); });
  els.betPlus.addEventListener("click", () => { bet = Math.min(MAX_BET, bet + BET_STEP); updateBetUI(); });
  els.betValue.addEventListener("input", () => { els.betValue.value = els.betValue.value.replace(/[^0-9]/g, ""); });
  els.betValue.addEventListener("change", () => { bet = clampBet(els.betValue.value); updateBetUI(); });
  els.betValue.addEventListener("blur", () => { bet = clampBet(els.betValue.value); updateBetUI(); });
  els.betValue.addEventListener("keydown", (e) => { if (e.key === "Enter") els.betValue.blur(); });

  function showError(msg) { els.error.textContent = msg; els.error.classList.remove("hidden"); }
  function hideError() { els.error.classList.add("hidden"); }

  function setBusy(busy) {
    els.dealBtn.disabled = busy;
    els.hitBtn.disabled = busy;
    els.standBtn.disabled = busy;
    els.doubleBtn.disabled = busy || !canDouble;
    els.betValue.disabled = busy || handStatus === "active";
    els.betMinus.disabled = busy || bet <= MIN_BET || handStatus === "active";
    els.betPlus.disabled = busy || bet >= MAX_BET || handStatus === "active";
  }

  function goActive(data) {
    handId = data.hand_id || handId;
    handStatus = "active";
    canDouble = data.player_cards.length === 2;
    els.dealBtn.classList.add("hidden");
    els.actions.classList.remove("hidden");
    els.dealerTotal.textContent = "";
    renderCards(els.dealerCards, [{ r: data.dealer_up_card.r, s: data.dealer_up_card.s }, { r: "?", s: "?" }], true);
    els.playerTotal.textContent = `(${data.player_total})`;
    renderCards(els.playerCards, data.player_cards, false);
    els.status.textContent = "Ваш ход";
    setBusy(false);
  }

  function goFinished(data) {
    handStatus = "finished";
    handId = null;
    els.dealBtn.classList.remove("hidden");
    els.actions.classList.add("hidden");
    renderCards(els.dealerCards, data.dealer_cards, false);
    els.dealerTotal.textContent = `(${data.dealer_total})`;
    renderCards(els.playerCards, data.player_cards, false);
    els.playerTotal.textContent = `(${data.player_total})`;
    els.status.textContent = data.result_label;
    AppState.setBalance(data.new_balance);
    setBusy(false);
    fetchRecentGames();
  }

  els.dealBtn.addEventListener("click", async () => {
    hideError();
    setBusy(true);
    try {
      const data = await AppState.api("/api/blackjack/start", { method: "POST", auth: true, body: { bet } });
      if (data.status === "finished") {
        els.actions.classList.add("hidden");
        goFinished(data);
      } else {
        goActive(data);
      }
    } catch (e) {
      showError(e.message);
      setBusy(false);
    }
  });

  els.hitBtn.addEventListener("click", async () => {
    if (!handId) return;
    hideError();
    setBusy(true);
    try {
      const data = await AppState.api("/api/blackjack/hit", { method: "POST", auth: true, body: { hand_id: handId } });
      if (data.status === "finished") {
        goFinished(data);
      } else {
        canDouble = false;
        els.playerTotal.textContent = `(${data.player_total})`;
        renderCards(els.playerCards, data.player_cards, false);
        setBusy(false);
      }
    } catch (e) {
      showError(e.message);
      setBusy(false);
    }
  });

  els.standBtn.addEventListener("click", async () => {
    if (!handId) return;
    hideError();
    setBusy(true);
    try {
      const data = await AppState.api("/api/blackjack/stand", { method: "POST", auth: true, body: { hand_id: handId } });
      goFinished(data);
    } catch (e) {
      showError(e.message);
      setBusy(false);
    }
  });

  els.doubleBtn.addEventListener("click", async () => {
    if (!handId || !canDouble) return;
    hideError();
    setBusy(true);
    try {
      const data = await AppState.api("/api/blackjack/double", { method: "POST", auth: true, body: { hand_id: handId } });
      goFinished(data);
    } catch (e) {
      showError(e.message);
      setBusy(false);
    }
  });

  async function fetchRecentGames() {
    await AppState.fetchRecentGames(els.recentGamesList, "blackjack");
  }

  async function onEnter() {
    hideError();
    els.betValue.value = bet;
    try {
      const state = await AppState.api("/api/blackjack/state", { auth: true });
      if (state.has_hand) {
        handId = state.hand_id;
        bet = state.bet;
        els.betValue.value = bet;
        goActive({
          hand_id: state.hand_id,
          player_cards: state.player_cards,
          player_total: state.player_total,
          dealer_up_card: state.dealer_up_card,
        });
      } else {
        handStatus = "idle";
        handId = null;
        els.dealBtn.classList.remove("hidden");
        els.actions.classList.add("hidden");
        els.dealerCards.innerHTML = "";
        els.playerCards.innerHTML = "";
        els.dealerTotal.textContent = "";
        els.playerTotal.textContent = "";
        els.status.textContent = "Сделайте ставку";
        setBusy(false);
      }
    } catch (_) {
      els.status.textContent = "Не удалось подключиться";
    }
    updateBetUI();
    fetchRecentGames();
  }

  window.BlackjackGame = { onEnter };
})();
