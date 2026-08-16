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

    reel: document.getElementById("caseReel"),
    reelViewport: document.querySelector("#caseReel .case-reel-viewport"),
    reelTrack: document.getElementById("caseReelTrack"),
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
    els.reel.classList.add("hidden");
    els.reelTrack.innerHTML = "";
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

  // ---------- лента прокрутки ----------

  const REEL_ITEM_WIDTH = 88;
  const REEL_ITEM_GAP = 8;
  const REEL_STEP = REEL_ITEM_WIDTH + REEL_ITEM_GAP;
  const REEL_LANDING_INDEX = 34;   // на этой позиции в ленте останавливается выигрыш
  const REEL_TRAILING_ITEMS = 6;   // сколько карточек видно "после" выигрыша
  const REEL_SPIN_MS = 4200;

  function pickWeightedRandom(items) {
    const totalWeight = items.reduce((s, i) => s + (i.weight || 1), 0);
    let roll = Math.random() * totalWeight;
    for (const item of items) {
      roll -= item.weight || 1;
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  function reelItemEl(item) {
    const div = document.createElement("div");
    div.className = "case-reel-item " + (RARITY_CLASS[item.rarity] || "rarity-common");
    div.innerHTML = `
      <span class="case-item-gem" aria-hidden="true"></span>
      <span class="case-reel-item-value">${item.value > 0 ? "+" + item.value : "Пусто"}</span>
    `;
    return div;
  }

  // Строит ленту из случайных предметов (только для красоты прокрутки) и
  // подставляет РЕАЛЬНЫЙ выигранный предмет (уже определённый сервером)
  // строго на позицию REEL_LANDING_INDEX — анимация лишь показывает
  // результат, который уже вычислен и сохранён на бэкенде.
  function buildReel(allItems, landedItem) {
    const total = REEL_LANDING_INDEX + REEL_TRAILING_ITEMS + 1;
    els.reelTrack.innerHTML = "";
    els.reelTrack.style.transition = "none";
    els.reelTrack.style.transform = "translateX(0)";

    for (let i = 0; i < total; i++) {
      const item = i === REEL_LANDING_INDEX ? landedItem : pickWeightedRandom(allItems);
      const el = reelItemEl(item);
      el.dataset.index = String(i);
      els.reelTrack.appendChild(el);
    }
  }

  function spinReelTo(landedIndex) {
    return new Promise((resolve) => {
      const viewportWidth = els.reelViewport.clientWidth;
      // Небольшой случайный сдвиг внутри карточки — чтобы остановка не
      // выглядела механически идеальной, но предмет всё равно чётко под указателем.
      const jitter = (Math.random() - 0.5) * (REEL_ITEM_WIDTH * 0.3);
      const targetX = -(landedIndex * REEL_STEP + REEL_STEP / 2 - viewportWidth / 2) + jitter;

      // Даём браузеру отрисовать стартовое положение без transition,
      // и только следующим кадром включаем анимацию — иначе transition
      // "съест" и исходную установку transform: translateX(0).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          els.reelTrack.style.transition = `transform ${REEL_SPIN_MS}ms cubic-bezier(0.1, 0.79, 0.15, 1)`;
          els.reelTrack.style.transform = `translateX(${targetX}px)`;
        });
      });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        els.reelTrack.removeEventListener("transitionend", onEnd);
        resolve();
      };
      const onEnd = (e) => {
        if (e.propertyName === "transform") finish();
      };
      els.reelTrack.addEventListener("transitionend", onEnd);
      // Подстраховка на случай, если transitionend не придёт (например,
      // вкладка была свёрнута во время анимации).
      setTimeout(finish, REEL_SPIN_MS + 400);
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
      // 1) Кейс открывает СЕРВЕР — результат уже определён и записан в
      //    базу ещё до того, как на экране началась хоть одна анимация.
      const data = await AppState.api("/api/cases/open", { method: "POST", auth: true });
      const config = await loadCaseConfig();
      const landedItem = config.items[data.item_index] || {
        label: data.label, value: data.value, rarity: data.rarity, weight: 1,
      };

      // 2) Фронт только визуализирует уже готовый результат — крутит
      //    ленту так, чтобы она гарантированно остановилась именно на
      //    предмете, который вернул сервер.
      els.reel.classList.remove("hidden");
      buildReel(config.items, landedItem);
      await spinReelTo(REEL_LANDING_INDEX);

      const landedEl = els.reelTrack.querySelector(`[data-index="${REEL_LANDING_INDEX}"]`);
      if (landedEl) landedEl.classList.add("is-landed");

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
