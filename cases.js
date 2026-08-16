(function () {
  "use strict";

  // Ждём, пока app.js создаст window.AppState (порядок подключения
  // скриптов в index.html: config.js -> app.js -> aviator.js -> blackjack.js -> cases.js).
  const AppState = window.AppState;

  const els = {
    caseBtn: document.getElementById("caseCardBtn"),
    caseCost: document.getElementById("caseCardCost"),
    error: document.getElementById("caseError"),
    resultBadge: document.getElementById("caseResultBadge"),
    itemsGrid: document.getElementById("caseItemsGrid"),
    recentGamesList: document.getElementById("caseRecentGamesList"),
  };

  let opening = false;
  let loaded = false; // содержимое кейса не меняется — грузим один раз за сессию

  function renderItems(items) {
    els.itemsGrid.innerHTML = "";
    items.forEach((it, i) => {
      const chancePct = it.weight / 10;
      const chanceText = chancePct < 1 ? chancePct.toFixed(2) : chancePct.toFixed(1).replace(/\.0$/, "");

      const card = document.createElement("div");
      card.className = `case-item rarity-${it.rarity}`;
      card.dataset.index = i;
      card.innerHTML = `
        <span class="case-item-chance">${chanceText}%</span>
        <span class="case-item-gem" aria-hidden="true"></span>
        <span class="case-item-name">${it.label}</span>
        <span class="case-item-value">${it.value > 0 ? "+" + it.value : "—"}</span>
      `;
      els.itemsGrid.appendChild(card);
    });
  }

  function clearHighlight() {
    els.itemsGrid.querySelectorAll(".case-item.is-won").forEach((el) => el.classList.remove("is-won"));
  }

  function revealItem(data) {
    clearHighlight();
    const card = els.itemsGrid.querySelector(`[data-index="${data.item_index}"]`);
    if (card) {
      card.classList.add("is-won");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => card.classList.remove("is-won"), 2600);
    }

    AppState.setBalance(data.new_balance);

    els.resultBadge.classList.remove("hidden", "win", "lose", "flat");
    if (data.value > 0) {
      els.resultBadge.classList.add("win");
      els.resultBadge.textContent = `${data.label} · +${data.value} шансов`;
    } else {
      els.resultBadge.classList.add("lose");
      els.resultBadge.textContent = `${data.label} · выигрыша нет`;
    }

    AppState.fetchRecentGames(els.recentGamesList, "case");
  }

  els.caseBtn.addEventListener("click", async () => {
    if (opening) return;
    opening = true;
    els.error.classList.add("hidden");
    els.resultBadge.classList.add("hidden");
    els.caseBtn.disabled = true;

    try {
      const data = await AppState.api("/api/cases/open", { method: "POST", auth: true });
      revealItem(data);
    } catch (err) {
      els.error.textContent = err.message;
      els.error.classList.remove("hidden");
    } finally {
      opening = false;
      els.caseBtn.disabled = false;
    }
  });

  async function onEnter() {
    if (!loaded) {
      const data = await AppState.api("/api/cases", { auth: true });
      els.caseCost.textContent = data.cost;
      renderItems(data.items);
      loaded = true;
    }
    await AppState.fetchRecentGames(els.recentGamesList, "case");
  }

  window.CasesGame = { onEnter };
})();
