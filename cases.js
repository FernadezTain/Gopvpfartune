(function () {
  "use strict";

  // Ждём, пока app.js создаст window.AppState (порядок подключения
  // скриптов в index.html: config.js -> app.js -> aviator.js -> cases.js).
  const AppState = window.AppState;

  const els = {
    listCardBtn: document.getElementById("caseCardBtn"),
    listPrice: document.getElementById("caseListPrice"),

    detailScreen: document.getElementById("caseDetailScreen"),
    heroName: document.getElementById("caseHeroName"),
    openBtn: document.getElementById("caseOpenBtn"),
    openCost: document.getElementById("caseOpenCost"),
    error: document.getElementById("caseError"),
    resultBadge: document.getElementById("caseResultBadge"),
    itemsGrid: document.getElementById("caseItemsGrid"),
    recentGamesList: document.getElementById("caseRecentGamesList"),
  };

  const RARITY_CLASS = {
    common: "rarity-common",
    uncommon: "rarity-uncommon",
    rare: "rarity-rare",
    epic: "rarity-epic",
    legendary: "rarity-legendary",
    mythic: "rarity-mythic",
  };

  let caseConfig = null;   // { cost, items: [{label, value, weight, rarity}] }
  let configPromise = null;
  let opening = false;

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.remove("hidden");
  }
  function hideError() {
    els.error.classList.add("hidden");
  }

  function setBusy(btn, busy, textEl, busyText, idleText) {
    btn.disabled = busy;
    btn.classList.toggle("is-busy", busy);
    if (textEl) textEl.textContent = busy ? busyText : idleText;
  }

  // ---------- загрузка конфигурации кейса (один раз, дальше — из кэша) ----------

  function loadCaseConfig() {
    if (caseConfig) return Promise.resolve(caseConfig);
    if (!configPromise) {
      configPromise = AppState.api("/api/cases", { auth: true })
        .then((data) => {
          caseConfig = data;
          return data;
        })
        .catch((err) => {
          configPromise = null; // разрешаем повторить попытку при следующем входе
          throw err;
        });
    }
    return configPromise;
  }

  function renderItemsGrid(cost, items) {
    els.itemsGrid.innerHTML = "";
    items.forEach((item, idx) => {
      const chancePct = (item.weight / 10).toFixed(item.weight < 10 ? 3 : item.weight < 100 ? 2 : 1);
      const card = document.createElement("div");
      card.className = "case-item " + (RARITY_CLASS[item.rarity] || "rarity-common");
      card.dataset.itemIndex = String(idx);
      card.innerHTML = `
        <span class="case-item-chance">шанс ${chancePct}%</span>
        <span class="case-item-gem" aria-hidden="true"></span>
        <span class="case-item-name">${item.value > 0 ? item.value + " шансов" : "Пусто"}</span>
        ${item.value > 0 ? `<span class="case-item-value">+${item.value}</span>` : ""}
      `;
      els.itemsGrid.appendChild(card);
    });
  }

  // ---------- вход на экран списка кейсов ----------

  async function onEnter() {
    try {
      const data = await loadCaseConfig();
      if (els.listPrice) els.listPrice.textContent = data.cost;
    } catch (_) {
      // список кейсов не критичен к ошибке загрузки конфига — цена
      // просто останется дефолтной, а деталка при входе покажет ошибку сама
    }
  }

  // ---------- вход на экран открытия кейса ----------

  async function openDetailScreen() {
    hideError();
    els.resultBadge.classList.add("hidden");
    els.itemsGrid.innerHTML = `<p class="history-empty">Загрузка…</p>`;

    await AppState.navigateTo("caseDetailScreen");

    try {
      const data = await loadCaseConfig();
      els.heroName.textContent = "Стартовый кейс";
      els.openCost.textContent = `−${data.cost} шансов`;
      renderItemsGrid(data.cost, data.items);
    } catch (err) {
      els.itemsGrid.innerHTML = "";
      showError(err.message || "Не удалось загрузить кейс");
    }

    AppState.fetchRecentGames(els.recentGamesList, "case");
  }

  if (els.listCardBtn) {
    els.listCardBtn.addEventListener("click", () => {
      openDetailScreen();
    });
  }

  // ---------- открытие кейса ----------

  function flashWonItem(itemIndex) {
    const card = els.itemsGrid.querySelector(`[data-item-index="${itemIndex}"]`);
    if (!card) return;
    card.classList.add("is-won");
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    setTimeout(() => card.classList.remove("is-won"), 2600);
  }

  function showResult(data) {
    AppState.setBalance(data.new_balance);
    const net = data.value - data.cost;
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
    flashWonItem(data.item_index);
    AppState.fetchRecentGames(els.recentGamesList, "case");
  }

  els.openBtn.addEventListener("click", async () => {
    if (opening) return;
    hideError();
    els.resultBadge.classList.add("hidden");
    opening = true;
    setBusy(els.openBtn, true, els.openBtn.querySelector(".btn-spin-text"), "Открываем…", "Открыть кейс");
    try {
      const data = await AppState.api("/api/cases/open", { method: "POST", auth: true });
      showResult(data);
    } catch (err) {
      showError(err.message || "Не удалось открыть кейс");
    } finally {
      opening = false;
      setBusy(els.openBtn, false, els.openBtn.querySelector(".btn-spin-text"), "Открываем…", "Открыть кейс");
    }
  });

  window.CasesGame = { onEnter };
})();
