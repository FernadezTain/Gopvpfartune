(function () {
  "use strict";

  // Экран "Кейсы":
  //   1. Экран СПИСКА кейсов — карточки тянутся с сервера (GET /api/cases),
  //      у каждого кейса свой ключ (case_key), имя, цена и иконка. Раньше
  //      здесь была всегда одна и та же захардкоженная в index.html
  //      карточка — теперь кейсов может быть сколько угодно, и каждый со
  //      своим содержимым (настраивается в Supabase, без правок кода).
  //   2. Пользователь жмёт на карточку кейса -> открывается экран ОДНОГО
  //      кейса, его содержимое подгружается через GET /api/cases/{case_key}.
  //   3. "Открыть кейс" -> POST /api/cases/{case_key}/open. Сервер сам
  //      решает выигрыш (вес секций известен только бэкенду) и отдаёт на
  //      фронт item_index + label.
  //   4. Фронт строит длинную ленту предметов (случайные для "мусора" +
  //      ОБЯЗАТЕЛЬНО серверный предмет на фиксированной позиции) и
  //      анимирует прокрутку СПРАВА НАЛЕВО, которая тормозит и
  //      останавливается ровно на предмете с сервера под указателем.
  //
  // Фронт никогда сам не решает, что выпало — только красиво
  // визуализирует уже принятое сервером решение.

  const els = {
    caseGrid: document.getElementById("caseGrid"),

    caseDetailScreen: document.getElementById("caseDetailScreen"),
    caseHeroIcon: document.getElementById("caseHeroIcon"),
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

  let caseList = null; // [{case_key, name, cost, icon, badge}, ...]
  let activeCase = null; // {case_key, name, cost, icon}
  let caseData = null; // { cost, items: [{label, value, weight, rarity}] } — для activeCase
  let opening = false;

  // ---------- список кейсов ----------

  async function loadCaseList(force) {
    if (caseList && !force) return caseList;
    const data = await window.AppState.api("/api/cases", { auth: true });
    caseList = data.cases || [];
    return caseList;
  }

  async function onEnter() {
    if (!els.caseGrid) return;
    els.caseGrid.innerHTML = `<div class="cases-loading">Загрузка кейсов…</div>`;
    try {
      const list = await loadCaseList(true);
      renderCaseGrid(list);
    } catch (err) {
      els.caseGrid.innerHTML = `<p class="cases-error">${escapeHtml(err.message || "Не удалось загрузить кейсы")}</p>`;
    }
  }

  function renderCaseGrid(list) {
    els.caseGrid.innerHTML = "";
    if (!list.length) {
      els.caseGrid.innerHTML = `<p class="cases-error">Пока нет доступных кейсов</p>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    list.forEach((c) => fragment.appendChild(buildCaseCard(c)));
    els.caseGrid.appendChild(fragment);
  }

  function buildCaseCard(c) {
    const btn = document.createElement("button");
    btn.className = "case-card";
    btn.dataset.case = c.case_key;
    btn.innerHTML = `
      ${c.badge ? `<span class="case-card-badge">${escapeHtml(c.badge)}</span>` : ""}
      <img class="case-card-img" src="${escapeHtml(c.icon || "")}" alt="${escapeHtml(c.name)}" />
      <span class="case-card-price"><span class="icon-chance-coin" aria-hidden="true"></span><span>${c.cost}</span></span>
      <span class="case-card-name">${escapeHtml(c.name)}</span>
    `;
    btn.addEventListener("click", () => openCaseDetailScreen(c));
    return btn;
  }

  async function openCaseDetailScreen(c) {
    activeCase = c;
    window.AppState.navigateTo("caseDetailScreen");

    resetDetailScreen();

    if (els.caseHeroIcon) {
      els.caseHeroIcon.src = c.icon || "";
      els.caseHeroIcon.alt = c.name || "";
    }
    if (els.caseHeroName) {
      els.caseHeroName.textContent = c.name || "";
    }
    if (els.caseOpenCost) els.caseOpenCost.textContent = `−${c.cost} GP`;

    try {
      const data = await loadCaseData(c.case_key, true);
      if (els.caseOpenCost) els.caseOpenCost.textContent = `−${data.cost} GP`;
      renderItemsGrid(data.items);
      window.AppState.fetchRecentGames(els.caseRecentGamesList, "case");
    } catch (err) {
      showCaseError(err.message);
    }
  }

  async function loadCaseData(caseKey, force) {
    if (caseData && !force) return caseData;
    const data = await window.AppState.api(`/api/cases/${encodeURIComponent(caseKey)}`, { auth: true });

    // Для предметных призов (kind: "item") заранее считаем иконку, которую
    // покажем и в списке содержимого, и в ленте прокрутки: ТОЛЬКО статичная
    // картинка (icon_png, а если его нет — замороженный первый кадр
    // icon_gif). Живой gif в кейсах намеренно нигде не проигрывается —
    // в ленте одновременно скроллится несколько десятков карточек, и
    // анимированные gif в каждой из них ощутимо лагают на слабых телефонах.
    await Promise.all(
      data.items.map(async (entry) => {
        if (entry.kind === "item" && entry.item) {
          entry._icon = await window.AppState.staticIconFor(entry.item);
        }
      })
    );

    caseData = data;
    return caseData;
  }

  function resetDetailScreen() {
    caseData = null;
    hideCaseError();
    if (els.caseResultBadge) els.caseResultBadge.classList.add("hidden");
    if (els.caseReel) els.caseReel.classList.add("hidden");
    if (els.caseReelTrack) {
      els.caseReelTrack.style.transition = "none";
      els.caseReelTrack.style.transform = "translateX(0px)";
      els.caseReelTrack.innerHTML = "";
    }
    if (els.caseItemsGrid) {
      els.caseItemsGrid.innerHTML = "";
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
      const visual = item.kind === "item" && item._icon
        ? `<img class="case-item-icon" src="${item._icon}" alt="" loading="lazy" />`
        : `<span class="case-item-gem" aria-hidden="true"></span>`;
      div.innerHTML = `
        <span class="case-item-chance">${chance}%</span>
        ${visual}
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
    const visual = item.kind === "item" && item._icon
      ? `<img class="case-item-icon" src="${item._icon}" alt="" loading="lazy" />`
      : `<span class="case-item-gem" aria-hidden="true"></span>`;
    div.innerHTML = `
      ${visual}
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
    if (opening || !activeCase) return;
    opening = true;
    els.caseOpenBtn.disabled = true;
    hideCaseError();
    if (els.caseResultBadge) els.caseResultBadge.classList.add("hidden");
    if (els.caseItemsGrid) {
      els.caseItemsGrid.querySelectorAll(".case-item.is-won").forEach((el) => el.classList.remove("is-won"));
    }

    try {
      // Шаг 1: сервер уже сейчас решил, что выпадет в ЭТОМ кейсе, и
      // списал/начислил баланс.
      const [result, data] = await Promise.all([
        window.AppState.api(`/api/cases/${encodeURIComponent(activeCase.case_key)}/open`, { method: "POST", auth: true }),
        loadCaseData(activeCase.case_key),
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
    els.caseResultBadge.classList.remove("hidden", "win", "lose", "flat");

    if (data.kind === "item") {
      // Приз — предмет в инвентарь, а не деньги: ставка (стоимость кейса)
      // всё равно списана, поэтому визуально это "win" (получили предмет),
      // но сумму в GP тут не показываем — её просто не было.
      els.caseResultBadge.classList.add("win");
      els.caseResultBadge.textContent = `${data.label} · предмет добавлен в инвентарь`;
      return;
    }

    const net = data.value - data.cost;
    if (net > 0) {
      els.caseResultBadge.classList.add("win");
      els.caseResultBadge.textContent = `${data.label} · +${net} GP`;
    } else if (net < 0) {
      els.caseResultBadge.classList.add("lose");
      els.caseResultBadge.textContent = `${data.label} · −${Math.abs(net)} GP`;
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
