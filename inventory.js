(function () {
  "use strict";

  // Экран "Инвентарь": сетка предметов (Stars / NFT / Gift), модалка
  // "Управление предметом" (иконка + мета-поля + кнопки Обменять/Получить)
  // и модалка "Обмен предмета" (выбор валюты Stars/Шансы).
  //
  // Правило анимации: если у предмета есть Icon_Gif, в СЕТКЕ он не должен
  // анимироваться — там показывается замороженный первый кадр (через
  // canvas). Живой gif проигрывается только внутри модалки управления.

  const els = {
    invEmpty: document.getElementById("invEmpty"),
    invGrid: document.getElementById("invGrid"),
    invReloadBtn: document.getElementById("invReloadBtn"),

    manageModal: document.getElementById("invManageModal"),
    manageClose: document.getElementById("invManageClose"),
    manageIconBg: document.getElementById("invManageIconBg"),
    manageIcon: document.getElementById("invManageIcon"),
    manageName: document.getElementById("invManageName"),
    manageRows: document.getElementById("invManageRows"),
    exchangeBtn: document.getElementById("invExchangeBtn"),
    claimBtn: document.getElementById("invClaimBtn"),

    exchangeModal: document.getElementById("invExchangeModal"),
    exchangeClose: document.getElementById("invExchangeClose"),
    currencyToggle: document.getElementById("invCurrencyToggle"),
    exchangePreviewValue: document.getElementById("invExchangePreviewValue"),
    exchangeError: document.getElementById("invExchangeError"),
    exchangeCancel: document.getElementById("invExchangeCancel"),
    exchangeConfirm: document.getElementById("invExchangeConfirm"),

    toastStack: document.getElementById("toastStack"),
  };

  const TYPE_LABELS = { nft: "NFT", gift: "Подарок", stars: "Stars" };
  // Часть значений Background из каталога — обычные названия CSS-цветов
  // (Aquamarine, Tomato, Fuchsia, ...) — их можно использовать как есть.
  const FALLBACK_CARD_BG = ["#3a2f63", "#2f2a4d"];

  let items = [];
  let activeItem = null;
  let activeCurrency = "stars";
  let busy = false;

  // ---------- helpers ----------

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function pickIconForGrid(item) {
    // В сетке всегда без анимации: если есть png — берём его, если только
    // gif — замораживаем первый кадр в canvas.
    if (item.icon_png) return Promise.resolve(item.icon_png);
    if (item.icon_gif) return freezeFirstFrame(item.icon_gif);
    return Promise.resolve(null);
  }

  function pickIconForModal(item) {
    // В модалке управления живая анимация разрешена — используем gif,
    // если он есть, иначе png (см. правило "если Png пуст — применяется Gif").
    return item.icon_gif || item.icon_png || null;
  }

  function freezeFirstFrame(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || 1;
          canvas.height = img.naturalHeight || 1;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        } catch (_) {
          // Кросс-домен без CORS-заголовков — canvas "испачкан", не можем
          // прочитать пиксели. В этом случае лучше показать анимацию,
          // чем совсем без картинки.
          resolve(url);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function cardBackground(item) {
    if (item.background) return item.background;
    return null;
  }

  function itemTitle(item) {
    if (item.type === "nft") return item.model || item.symbol || item.collection || "NFT";
    if (item.type === "gift") return item.collection || "Подарок";
    return "Stars";
  }

  function itemSubtitle(item) {
    if (item.type === "nft") return item.collection || "";
    return "";
  }

  // ---------- вход на экран ----------

  async function onEnter() {
    els.invGrid.innerHTML = `<div class="inv-loading">Загрузка инвентаря…</div>`;
    els.invEmpty.classList.add("hidden");
    try {
      const data = await window.AppState.api("/api/inventory", { auth: true });
      items = data.items || [];
      await renderGrid();
    } catch (err) {
      els.invGrid.innerHTML = "";
      els.invEmpty.classList.remove("hidden");
      els.invEmpty.querySelector("p").textContent = err.message || "Не удалось загрузить инвентарь";
    }
  }

  // ---------- кнопка "Обновить" рядом с заголовком ----------

  let reloading = false;

  async function handleReloadClick() {
    if (reloading || busy) return;
    reloading = true;
    els.invReloadBtn.classList.add("is-loading");
    try {
      await onEnter();
    } finally {
      reloading = false;
      els.invReloadBtn.classList.remove("is-loading");
    }
  }

  if (els.invReloadBtn) {
    els.invReloadBtn.addEventListener("click", handleReloadClick);
  }

  async function renderGrid() {
    els.invGrid.innerHTML = "";
    if (!items.length) {
      els.invEmpty.classList.remove("hidden");
      els.invEmpty.querySelector("p").textContent =
        "Пока пусто. Открывайте кейсы и получайте предметы — они появятся здесь.";
      return;
    }
    els.invEmpty.classList.add("hidden");

    const fragment = document.createDocumentFragment();
    const cards = await Promise.all(items.map(buildCard));
    cards.forEach((card, i) => {
      card.style.setProperty("--inv-i", i);
      fragment.appendChild(card);
    });
    els.invGrid.appendChild(fragment);
  }

  async function buildCard(item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `inv-card inv-card-${item.type}`;
    card.dataset.id = item.id;

    const bg = cardBackground(item);
    if (bg) card.style.setProperty("--inv-card-bg", bg);

    const iconSrc = await pickIconForGrid(item);

    card.innerHTML = `
      <span class="inv-card-badge">${TYPE_LABELS[item.type] || item.type}</span>
      <span class="inv-card-sheen" aria-hidden="true"></span>
      <span class="inv-card-icon-wrap">
        ${iconSrc ? `<img class="inv-card-icon" src="${iconSrc}" alt="" loading="lazy" />` : `<span class="inv-card-icon-ph">✦</span>`}
      </span>
      <span class="inv-card-shade" aria-hidden="true"></span>
      <span class="inv-card-name">${escapeHtml(itemTitle(item))}</span>
      <span class="inv-card-price">
        <span class="inv-price-chip"><span class="inv-price-star">⭐</span>${item.price_stars}</span>
        <span class="inv-price-chip"><span class="icon-chance-coin" aria-hidden="true"></span>${item.price_gp}</span>
      </span>
    `;
    card.addEventListener("click", () => openManageModal(item));
    return card;
  }

  // ---------- модалка "Управление предметом" ----------

  function openManageModal(item) {
    activeItem = item;
    const iconSrc = pickIconForModal(item);
    els.manageIcon.src = iconSrc || "";
    els.manageIcon.classList.toggle("hidden", !iconSrc);
    els.manageIconBg.style.background = cardBackground(item) || "linear-gradient(160deg, #342f54, #221e3a)";
    if (item.background_png) {
      els.manageIconBg.style.backgroundImage = `url(${item.background_png})`;
      els.manageIconBg.style.backgroundSize = "cover";
      els.manageIconBg.style.backgroundPosition = "center";
    } else {
      els.manageIconBg.style.backgroundImage = "none";
    }

    els.manageName.textContent = itemTitle(item);

    const rows = [];
    rows.push(["Тип", TYPE_LABELS[item.type] || item.type]);
    if (item.type === "nft") {
      if (item.collection) rows.push(["Коллекция", item.collection]);
      if (item.model) rows.push(["Модель", item.model]);
      if (item.background) rows.push(["Фон", item.background]);
      if (item.symbol) rows.push(["Символ", item.symbol]);
    } else if (item.type === "gift" && item.collection) {
      rows.push(["Коллекция", item.collection]);
    }
    rows.push(["Price Stars", `⭐ ${item.price_stars}`]);
    rows.push(["Price GP", `${item.price_gp} GP`]);

    els.manageRows.innerHTML = rows
      .map(([label, value]) => `
        <div class="inv-row">
          <span class="inv-row-label">${escapeHtml(label)}</span>
          <span class="inv-row-value">${escapeHtml(String(value))}</span>
        </div>
      `)
      .join("");

    els.claimBtn.disabled = false;
    els.claimBtn.textContent = "Получить";

    els.manageModal.classList.remove("hidden");
    void els.manageModal.offsetWidth;
    els.manageModal.classList.add("is-open");
  }

  function closeManageModal() {
    els.manageModal.classList.remove("is-open");
    window.setTimeout(() => els.manageModal.classList.add("hidden"), 200);
  }

  els.manageClose.addEventListener("click", closeManageModal);
  els.manageModal.addEventListener("click", (e) => {
    if (e.target === els.manageModal) closeManageModal();
  });

  // ---------- модалка "Обмен предмета" ----------

  function updateExchangePreview() {
    if (!activeItem || !els.exchangePreviewValue) return;
    if (activeCurrency === "gp") {
      els.exchangePreviewValue.innerHTML = `<span class="icon-chance-coin" aria-hidden="true"></span>${activeItem.price_gp} GP`;
    } else {
      els.exchangePreviewValue.innerHTML = `⭐ ${activeItem.price_stars} Stars`;
    }
  }

  function openExchangeModal() {
    if (!activeItem) return;
    activeCurrency = "stars";
    els.currencyToggle.querySelectorAll(".inv-currency-opt").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.currency === activeCurrency);
    });
    updateExchangePreview();
    els.exchangeError.classList.add("hidden");
    els.exchangeConfirm.disabled = false;
    els.exchangeConfirm.textContent = "Обменять";

    els.exchangeModal.classList.remove("hidden");
    void els.exchangeModal.offsetWidth;
    els.exchangeModal.classList.add("is-open");
  }

  function closeExchangeModal() {
    els.exchangeModal.classList.remove("is-open");
    window.setTimeout(() => els.exchangeModal.classList.add("hidden"), 200);
  }

  els.exchangeBtn.addEventListener("click", openExchangeModal);
  els.exchangeClose.addEventListener("click", closeExchangeModal);
  els.exchangeCancel.addEventListener("click", closeExchangeModal);
  els.exchangeModal.addEventListener("click", (e) => {
    if (e.target === els.exchangeModal) closeExchangeModal();
  });

  els.currencyToggle.querySelectorAll(".inv-currency-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCurrency = btn.dataset.currency;
      els.currencyToggle.querySelectorAll(".inv-currency-opt").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      updateExchangePreview();
    });
  });

  els.exchangeConfirm.addEventListener("click", async () => {
    if (busy || !activeItem) return;
    busy = true;
    els.exchangeConfirm.disabled = true;
    els.exchangeConfirm.textContent = "Обмениваем…";
    els.exchangeError.classList.add("hidden");

    try {
      const result = await window.AppState.api(`/api/inventory/${activeItem.id}/exchange`, {
        method: "POST",
        auth: true,
        body: { currency: activeCurrency },
      });

      // Убираем обменянный предмет из локального списка.
      items = items.filter((it) => it.id !== activeItem.id);
      if (result.currency === "gp") {
        window.AppState.setBalance(result.new_balance);
      } else if (result.currency === "stars" && result.new_item) {
        items.unshift(result.new_item);
      }

      closeExchangeModal();
      closeManageModal();
      await renderGrid();
      showToast("Обмен завершён!");
    } catch (err) {
      els.exchangeError.textContent = err.message || "Не удалось выполнить обмен";
      els.exchangeError.classList.remove("hidden");
      els.exchangeConfirm.disabled = false;
      els.exchangeConfirm.textContent = "Обменять";
    } finally {
      busy = false;
    }
  });

  // ---------- "Получить" ----------

  els.claimBtn.addEventListener("click", async () => {
    if (busy || !activeItem) return;
    busy = true;
    els.claimBtn.disabled = true;
    els.claimBtn.textContent = "Отправляем…";
    try {
      await window.AppState.api(`/api/inventory/${activeItem.id}/claim`, { method: "POST", auth: true });
      items = items.filter((it) => it.id !== activeItem.id);
      closeManageModal();
      await renderGrid();
      showToast("Заявка на получение отправлена!");
    } catch (err) {
      els.claimBtn.disabled = false;
      els.claimBtn.textContent = "Получить";
      showToast(err.message || "Не удалось отправить заявку", true);
    } finally {
      busy = false;
    }
  });

  // ---------- toast ----------

  function showToast(text, isError) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " toast-error" : ""}`;
    toast.innerHTML = `
      <span class="toast-text">${escapeHtml(text)}</span>
      <span class="toast-progress"></span>
    `;
    els.toastStack.appendChild(toast);

    void toast.offsetWidth;
    toast.classList.add("is-in");

    const bar = toast.querySelector(".toast-progress");
    const remove = () => {
      toast.classList.remove("is-in");
      toast.classList.add("is-out");
      window.setTimeout(() => toast.remove(), 220);
    };
    bar.addEventListener("animationend", remove);
    // подстраховка, если animationend не сработал
    window.setTimeout(remove, 3400);
  }

  window.InventoryGame = { onEnter };
})();
