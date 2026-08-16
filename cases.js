(function () {
  "use strict";

  // Этот файл раньше был случайной копией app.js (из-за чего экран кейсов
  // не работал вообще — а то, что было видно на экране, это просто
  // статичная разметка из index.html без какой-либо логики). Здесь —
  // настоящая реализация:
  //
  //   1. Пользователь жмёт "Открыть кейс".
  //   2. Сервер (POST /api/cases/open) сам решает выигрыш — вес секций
  //      известен только бэкенду — и отдаёт на фронт item_index + label.
  //   3. Фронт строит длинную ленту предметов (случайные для "мусора" +
  //      ОБЯЗАТЕЛЬНО серверный предмет на фиксированной позиции) и
  //      анимирует прокрутку СПРАВА НАЛЕВО, которая тормозит и
  //      останавливается ровно на предмете с сервера под указателем.
  //
  // Фронт никогда сам не решает, что выпало — только красиво
  // визуализирует уже принятое сервером решение.

  const els = {
    caseCardBtn: document.getElementById("caseCardBtn"),
    caseListPrice: document.getElementById("caseListPrice"),

    caseDetailScreen: document.getElementById("caseDetailScreen"),
    caseHeroName: document.getElementById("caseHeroName"),

    caseReel: document.getElementById("caseReel"),
    caseReelTrack: document.getElementById("caseReelTrack"),

    caseOpenBtn: document.getElementById("caseOpenBtn"),
    caseOpenCost: document.getElementById("caseOpenCost"),
    caseError: document.getElementById("caseError"),
    caseResultBadge: document.getElementById("caseResultBadge"),

    caseItemsGrid: document.getElementById("caseItemsGrid"),
    caseRecentGamesList: document.getElementById("caseRecentGamesList"),
  };

  // Геометрия ленты — должна соответствовать style.css (.case-reel-item,
  // .case-reel-track): ширина карточки 88px + gap 8px между карточками,
  // паддинг трека 8px с каждой стороны.
  const ITEM_WIDTH = 88;
  const ITEM_GAP = 8;
  const ITEM_STEP = ITEM_WIDTH + ITEM_GAP;
  const TRACK_PADDING = 8;

  const REEL_LENGTH = 60; // сколько карточек рисуем в ленте
  const LANDING_POS = 48; // на какой по счёту карточке должна остановиться лента
  const SPIN_MS = 5200; // должно совпадать с transition-duration ниже

  let caseData = null; // { cost, items: [{label, value, weight, rarity}] }
  let opening = false;

  function getEl(id) {
    return document.getElementById(id);
  }

  async function loadCaseData(force) {
    if (caseData && !force) return caseData;
    caseData = await window.AppState.api("/api/cases", { auth: true });
    return caseData;
  }

  // ---------- список кейсов ----------

  async function onEnter() {
    try {
      const data = await loadCaseData();
      if (els.caseListPrice) els.caseListPrice.textContent = data.cost;
    } catch (_) {
      // список кейсов не критичен — если не подгрузилось, просто останется
      // дефолтная цена из разметки
    }
  }

  if (els.caseCardBtn) {
    els.caseCardBtn.addEventListener("click", openCaseDetailScreen);
  }

  async function openCaseDetailScreen() {
    window.AppState.navigateTo("caseDetailScreen");

    resetDetailScreen();

    try {
      const data = await loadCaseData();
      if (els.caseOpenCost) els.caseOpenCost.textContent = `−${data.cost} шансов`;
      renderItemsGrid(data.items);
      window.AppState.fetchRecentGames(els.caseRecentGamesList, "case");
    } catch (err) {
      showCaseError(err.message);
    }
  }

  function resetDetailScreen() {
    hideCaseError();
    if (els.caseResultBadge) els.caseResultBadge.classList.add("hidden");
    if (els.caseReel) els.caseReel.classList.add("hidden");
    if (els.caseReelTrack) {
      els.caseReelTrack.style.transition = "none";
      els.caseReelTrack.style.transform = "translateX(0px)";
      els.caseReelTrack.innerHTML = "";
    }
    if (els.caseItemsGrid) {
      els.caseItemsGrid.querySelectorAll(".case-item.is-won").forEach((el) => el.classList.remove("is-won"));
    }
  }

  // ---------- содержимое кейса (таблица шансов) ----------

  function renderItemsGrid(items) {
    if (!els.caseItemsGrid) return;
    els.caseItemsGrid.innerHTML = "";
    items.forEach((item, idx) => {
      const div = document.createElement("div");
      div.className = `case-item rarity-${item.rarity}`;
      div.dataset.index = String(idx);
      const chance = (item.weight / 10).toFixed(1).replace(/\.0$/, "");
      div.innerHTML = `
        <span class="case-item-chance">${chance}%</span>
        <span class="case-item-gem" aria-hidden="true"></span>
        <span class="case-item-name">${escapeHtml(item.label)}</span>
      `;
      els.caseItemsGrid.appendChild(div);
    });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- лента прокрутки ----------

  function buildReelCard(item) {
    const div = document.createElement("div");
    div.className = `case-reel-item rarity-${item.rarity}`;
    div.innerHTML = `
      <span class="case-item-gem" aria-hidden="true"></span>
      <span class="case-reel-item-value">${escapeHtml(item.label)}</span>
    `;
    return div;
  }

  // Взвешенный случайный предмет — используется ТОЛЬКО для "проходных"
  // карточек ленты (визуальный шум слева/справа от выигрыша), никогда для
  // определения самого выигрыша — тот уже посчитан сервером.
  function weightedRandomItem(items) {
    const total = items.reduce((sum, it) => sum + it.weight, 0);
    let r = Math.random() * total;
    for (const it of items) {
      r -= it.weight;
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  function playOpenAnimation(items, winIndex) {
    const winItem = items[winIndex];

    const strip = [];
    for (let i = 0; i < REEL_LENGTH; i++) {
      strip.push(i === LANDING_POS ? winItem : weightedRandomItem(items));
    }

    els.caseReelTrack.innerHTML = "";
    els.caseReelTrack.style.transition = "none";
    els.caseReelTrack.style.transform = "translateX(0px)";

    const fragment = document.createDocumentFragment();
    strip.forEach((item) => fragment.appendChild(buildReelCard(item)));
    els.caseReelTrack.appendChild(fragment);

    els.caseReel.classList.remove("hidden");

    // Форсируем перерасчёт layout, чтобы браузер зафиксировал стартовую
    // позицию (translateX(0)) ДО того, как мы запустим transition —
    // иначе анимация "прыгнет" сразу в конечную точку.
    void els.caseReelTrack.offsetWidth;

    const viewportEl = els.caseReel.querySelector(".case-reel-viewport");
    const viewportWidth = viewportEl.clientWidth;

    // Центр карточки-победителя внутри трека.
    const landingCenter = TRACK_PADDING + LANDING_POS * ITEM_STEP + ITEM_WIDTH / 2;

    // Небольшой случайный сдвиг, чтобы указатель не всегда останавливался
    // ровно по центру карточки (как в реальных кейсах) — но не настолько
    // большой, чтобы уехать на соседнюю карточку.
    const maxJitter = ITEM_WIDTH / 2 - 14;
    const jitter = (Math.random() * 2 - 1) * maxJitter;

    const targetX = -(landingCenter - viewportWidth / 2) + jitter;

    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          els.caseReelTrack.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.85, 0.13, 1)`;
          els.caseReelTrack.style.transform = `translateX(${targetX}px)`;
        });
      });

      window.setTimeout(() => {
        const landedEl = els.caseReelTrack.children[LANDING_POS];
        if (landedEl) landedEl.classList.add("is-landed");
        resolve();
      }, SPIN_MS + 60);
    });
  }

  // ---------- открытие кейса ----------

  if (els.caseOpenBtn) {
    els.caseOpenBtn.addEventListener("click", handleOpenCase);
  }

  async function handleOpenCase() {
    if (opening) return;
    opening = true;
    els.caseOpenBtn.disabled = true;
    hideCaseError();
    if (els.caseResultBadge) els.caseResultBadge.classList.add("hidden");
    if (els.caseItemsGrid) {
      els.caseItemsGrid.querySelectorAll(".case-item.is-won").forEach((el) => el.classList.remove("is-won"));
    }

    try {
      // Шаг 1: сервер уже сейчас решил, что выпадет, и списал/начислил баланс.
      const [result, data] = await Promise.all([
        window.AppState.api("/api/cases/open", { method: "POST", auth: true }),
        loadCaseData(),
      ]);

      // Шаг 2: фронт просто визуализирует уже принятое решение сервера.
      await playOpenAnimation(data.items, result.item_index);

      window.AppState.setBalance(result.new_balance);
      showCaseResult(result);

      const wonEl = els.caseItemsGrid.querySelector(`[data-index="${result.item_index}"]`);
      if (wonEl) wonEl.classList.add("is-won");

      window.AppState.fetchRecentGames(els.caseRecentGamesList, "case");
    } catch (err) {
      showCaseError(err.message);
    } finally {
      opening = false;
      els.caseOpenBtn.disabled = false;
    }
  }

  function showCaseResult(data) {
    if (!els.caseResultBadge) return;
    const net = data.value - data.cost;
    els.caseResultBadge.classList.remove("hidden", "win", "lose", "flat");
    if (net > 0) {
      els.caseResultBadge.classList.add("win");
      els.caseResultBadge.textContent = `${data.label} · +${net} шансов`;
    } else if (net < 0) {
      els.caseResultBadge.classList.add("lose");
      els.caseResultBadge.textContent = `${data.label} · −${Math.abs(net)} шансов`;
    } else {
      els.caseResultBadge.classList.add("flat");
      els.caseResultBadge.textContent = `${data.label} · ставка возвращена`;
    }
  }

  function showCaseError(msg) {
    if (!els.caseError) return;
    els.caseError.textContent = msg;
    els.caseError.classList.remove("hidden");
  }
  function hideCaseError() {
    if (!els.caseError) return;
    els.caseError.classList.add("hidden");
  }

  window.CasesGame = { onEnter };
})();
