/* =========================================================
   EngPilot · 前端
   零构建、零依赖；只与 /api/v1 通信。
   ========================================================= */

(() => {
  "use strict";

  const API = "/api/v1";
  const DAILY_SIZE = 20;
  const WALLPAPER_API = "https://api.yppp.net/api.php";
  const MAX_LOCAL_WALLPAPER = 2.5 * 1024 * 1024;

  const ICONS = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    speak: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 9a4 4 0 010 6M17.5 6.5a7.5 7.5 0 010 11"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    enter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch]);

  const num = (value) => Number(value || 0).toLocaleString("zh-CN");

  const todayKey = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };

  const dateLabel = () => {
    const now = new Date();
    const weekday = "日一二三四五六"[now.getDay()];
    return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${weekday}`;
  };

  const statusLabel = { new: "未学", learning: "学习中", known: "已掌握" };

  /* ---------------- 存储 ---------------- */

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* 配额满了就放弃，不影响主流程 */
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
  };

  const progressKey = (date) => `zhanci:progress:${date}`;

  /* ---------------- 状态 ---------------- */

  const state = {
    meta: null,
    daily: null,
    progress: {},
    todayLoaded: false,
    bank: {
      q: "",
      status: "",
      starred: false,
      sort: "order",
      items: [],
      total: 0,
      cursor: null,
      hasMore: true,
      loading: false,
      loaded: false,
      selecting: false,
      selected: new Set(),
    },
    study: null,
    books: null,
    bookId: store.get("zhanci:book", ""),
    review: null,
    reviewDue: 0,
    reviewStats: null,
    pendingNotes: null,
    noteEditId: null,
    notesPage: { q: "", notes: [], cursor: null, hasMore: true, total: 0, loading: false, loaded: false },
    affixPage: {
      catalog: null,
      tab: "prefix",
      filter: "",
      type: "",
      key: "",
      affix: null,
      words: [],
      total: 0,
      cursor: null,
      hasMore: true,
      loading: false,
      loaded: false,
    },
    settings: Object.assign({ wallpaper: true, rate: 0.9, wallpaperUrl: "" }, store.get("zhanci:settings", {})),
  };

  /* ---------------- 请求 ---------------- */

  async function api(path, options = {}) {
    const config = Object.assign({}, options);
    config.headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {},
    );
    if (config.body && typeof config.body === "object" && !(config.body instanceof ArrayBuffer) && !(config.body instanceof Blob)) {
      config.body = JSON.stringify(config.body);
    }

    let response;
    try {
      response = await fetch(API + path, config);
    } catch {
      throw Object.assign(new Error("无法连接到本地词库，请确认服务已启动"), { code: "NETWORK" });
    }

    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON 响应 */ }

    if (!response.ok || (payload && payload.error)) {
      const error = payload && payload.error;
      throw Object.assign(new Error((error && error.message) || `请求失败（${response.status}）`), {
        code: (error && error.code) || "HTTP_" + response.status,
        details: error && error.details,
      });
    }

    return payload || { data: null };
  }

  /* ---------------- Toast ---------------- */

  function toast(message, type = "info") {
    const root = $("#toast-root");
    const node = document.createElement("div");
    node.className = "toast" + (type === "error" ? " is-error" : "");
    node.textContent = message;
    root.appendChild(node);
    window.setTimeout(() => {
      node.style.opacity = "0";
      node.style.transition = "opacity .2s";
      window.setTimeout(() => node.remove(), 220);
    }, 2400);
  }

  /* ---------------- 壁纸 ---------------- */

  function applyWallpaper() {
    const body = document.body;
    const settings = state.settings;
    if (!settings.wallpaper) {
      body.classList.remove("has-wallpaper");
      body.style.removeProperty("--wallpaper");
      return;
    }

    const url = settings.wallpaperUrl || `${WALLPAPER_API}?_=${Date.now()}`;
    body.style.setProperty("--wallpaper", `url("${url.replace(/"/g, '\\"')}")`);
    body.classList.add("has-wallpaper");
  }

  function nextWallpaper() {
    state.settings.wallpaperUrl = `${WALLPAPER_API}?_=${Date.now()}`;
    saveSettings();
    applyWallpaper();
    toast("已换一张壁纸");
  }

  async function pickLocalWallpaper(file) {
    if (!file) return;
    if (file.size > MAX_LOCAL_WALLPAPER) {
      toast("图片太大（上限 2.5 MB），换一张小一点的", "error");
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).catch(() => null);

    if (!dataUrl) {
      toast("读取图片失败", "error");
      return;
    }

    state.settings.wallpaperUrl = dataUrl;
    state.settings.wallpaper = true;
    saveSettings();
    applyWallpaper();
    toast("壁纸已更新");
  }

  function saveSettings() {
    store.set("zhanci:settings", state.settings);
  }

  /* ---------------- 朗读 ---------------- */

  function speak(word) {
    if (!("speechSynthesis" in window)) {
      toast("当前环境不支持朗读", "error");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = Number(state.settings.rate) || 0.9;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /en[-_]US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang));
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
  }

  /* ---------------- 数据加载 ---------------- */

  function updateReviewBadge() {
    const badge = $("#nav-review-due");
    if (!badge) return;
    const due = Number(state.reviewDue || 0);
    badge.hidden = due <= 0;
    badge.textContent = due > 99 ? "99+" : String(due);
  }

  async function loadBooks() {
    if (state.books) return state.books;
    try {
      const payload = await api("/books");
      state.books = payload.data.books || [];
    } catch {
      state.books = [];
    }

    // 保存的词书被删掉时回退到第一个
    if (state.bookId && !state.books.some((book) => book.id === state.bookId)) {
      state.bookId = "";
      store.set("zhanci:book", "");
    }

    renderBookSelect();
    return state.books;
  }

  function currentBook() {
    const books = state.books || [];
    if (!books.length) return null;
    return books.find((book) => book.id === state.bookId) || books[0];
  }

  function bookParam() {
    const book = currentBook();
    return book ? book.id : "";
  }

  function renderBookSelect() {
    const select = $("#book-select");
    if (!select) return;
    const books = state.books || [];
    const book = currentBook();

    // 只有一个词书时不占位置
    select.hidden = books.length < 2;
    select.innerHTML = books
      .map((item) => `<option value="${esc(item.id)}"${book && item.id === book.id ? " selected" : ""}>${esc(item.name)}</option>`)
      .join("");
  }

  async function switchBook(id) {
    state.bookId = id;
    store.set("zhanci:book", id);
    state.todayLoaded = false;
    state.daily = null;
    state.study = null;
    state.bank.loaded = false;
    state.bank.items = [];
    state.bank.cursor = null;
    state.review = null;
    state.reviewStats = null;
    renderBookSelect();
    await router();
  }

  async function loadMeta() {
    try {
      const payload = await api("/meta");
      state.meta = payload.data;
      const count = state.meta && state.meta.counts ? state.meta.counts.starred : 0;
      const badge = $("#starred-count");
      if (badge) badge.textContent = String(count || 0);
      $("#btn-starred")?.classList.toggle("is-on", state.bank.starred);
      const review = (state.meta && state.meta.review) || {};
      state.reviewDue = Number(review.due || 0);
      updateReviewBadge();
      refreshSettingsCount();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function refreshSettingsCount() {
    const el = $("#settings-word-count");
    if (!el || !state.meta || !state.meta.counts) return;
    el.textContent = num(state.meta.counts.total) + " 词";
  }

  async function loadDaily(force = false) {
    if (state.todayLoaded && !force) return state.daily;
    try {
      const params = new URLSearchParams({ size: String(DAILY_SIZE), date: todayKey() });
      const book = bookParam();
      if (book) params.set("book", book);
      const payload = await api(`/words/daily?${params}`);
      state.daily = payload.data;
      state.progress = store.get(progressKey(todayKey()), {});
      state.todayLoaded = true;
      return state.daily;
    } catch (error) {
      toast(error.message, "error");
      return null;
    }
  }

  function dailyStats() {
    const words = (state.daily && state.daily.words) || [];
    let known = 0;
    let learning = 0;
    for (const word of words) {
      const status = state.progress[word.id];
      if (status === "known") known += 1;
      else if (status === "learning") learning += 1;
    }
    return { total: words.length, known, learning, done: known + learning };
  }

  function saveProgress() {
    store.set(progressKey(todayKey()), state.progress);
  }

  function bumpStreak() {
    const key = "zhanci:streak";
    const current = store.get(key, { lastDate: "", days: 0 });
    if (current.lastDate === todayKey()) return current.days;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = (n) => String(n).padStart(2, "0");
    const yesterdayKey = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
    const days = current.lastDate === yesterdayKey ? Number(current.days || 0) + 1 : 1;
    store.set(key, { lastDate: todayKey(), days });
    return days;
  }

  function streakDays() {
    const current = store.get("zhanci:streak", { lastDate: "", days: 0 });
    return Number(current.days || 0);
  }

  /* ---------------- 路由 ---------------- */

  const routes = {
    home: renderHome,
    today: renderToday,
    bank: renderBankPage,
    study: renderStudyPage,
    review: renderReviewPage,
    notes: renderNotesPage,
    stats: renderStatsPage,
    affix: renderAffix,
    lookup: renderLookup,
  };

  function parseHash() {
    const raw = (location.hash || "#/home").replace(/^#\/?/, "");
    const clean = raw.split("?")[0];
    const slash = clean.indexOf("/");
    const name = slash >= 0 ? clean.slice(0, slash) : clean;
    const param = slash >= 0 ? decodeURIComponent(clean.slice(slash + 1)) : "";
    return { name: routes[name] ? name : "home", param };
  }

  function parseView() {
    return parseHash().name;
  }

  async function router() {
    window.scrollTo(0, 0);
    const { name, param } = parseHash();
    $$("[data-nav]").forEach((link) => {
      const nav = link.dataset.nav;
      const active =
        nav === name ||
        (name === "study" && nav === "today") ||
        (name === "review" && nav === "review") ||
        (name === "affix" && nav === "bank") ||
        (name === "lookup" && nav === "home");
      link.classList.toggle("is-active", active);
    });
    updateReviewBadge();
    closeModal();
    closeSearch();
    await routes[name](param);
  }

  /* ---------------- 首页 ---------------- */

  async function renderHome() {
    const view = $("#view");
    await loadMeta();
    await loadDaily();

    const counts = (state.meta && state.meta.counts) || {};
    const stats = dailyStats();
    const percent = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
    const allDone = stats.total > 0 && stats.done >= stats.total;
    const actionLabel = stats.done === 0 ? "开始今日学习" : allDone ? "再复习一遍" : "继续学习";
    const due = Number(state.reviewDue || 0);

    view.innerHTML = `
      <div class="page-head home-hero">
        <p class="eyebrow">${esc(dateLabel())}</p>
        <h1>今天想怎么背？</h1>
        <p class="sub">每天 20 个词，先回忆后揭晓。词库、音标和学习记录都留在这台电脑上。</p>
        <form class="home-search" id="home-search-form" role="search">
          <label class="search">
            ${ICONS.search}
            <input id="home-search" type="search" placeholder="查一个词，比如 reproduction…" autocomplete="off" spellcheck="false" />
          </label>
        </form>
        <div class="home-tip">
          按 <kbd>/</kbd> 随时查词 · <kbd>Esc</kbd> 关闭搜索结果
        </div>
      </div>

      ${due ? `
        <a class="review-banner" href="#/review">
          <b>${due}</b> 个词到了复习时间，趁热过一遍 →
        </a>
      ` : ""}

      <div class="home-stats">
        <button class="stat-card" type="button" data-action="start-study">
          <b>${stats.done} / ${stats.total}</b>
          <span>今日进度 · ${percent}%</span>
        </button>
        <button class="stat-card" type="button" data-action="go" data-href="#/bank">
          <b>${num((currentBook() || {}).wordCount || counts.total)}</b>
          <span>词库单词</span>
        </button>
        <button class="stat-card" type="button" data-action="go" data-href="#/bank" data-starred="1">
          <b>${num(counts.known)}</b>
          <span>已掌握 · ${num(counts.starred)} 星标</span>
        </button>
      </div>

      <section class="section" style="margin-top:26px">
        <div class="section-head">
          <h2>快速开始</h2>
          <span>今日 ${stats.total} 词 · 同日不变</span>
        </div>
        <div class="today-card panel">
          <div class="today-top">
            <strong>${allDone ? "今日已完成" : "今日词单"}</strong>
            <span>${stats.done} / ${stats.total}</span>
          </div>
          <div class="progress"><i style="width:${percent}%"></i></div>
          <div class="today-actions">
            <button class="btn btn-primary" type="button" data-action="start-study">
              ${ICONS.enter}
              ${actionLabel}
            </button>
            <a class="btn btn-quiet" href="#/lookup">查词</a>
            <a class="btn btn-quiet" href="#/bank">浏览词库</a>
            <span class="streak">连续 <b>${streakDays()}</b> 天</span>
          </div>
        </div>
      </section>
    `;
  }

  /* ---------------- 查词页 ---------------- */

  const EXCHANGE_LABELS = {
    p: "过去式",
    d: "过去分词",
    i: "现在分词",
    "3": "第三人称单数",
    r: "比较级",
    t: "最高级",
    s: "复数",
  };

  const TAG_LABELS = {
    cet4: "CET-4",
    cet6: "CET-6",
    ky: "考研",
    toefl: "TOEFL",
    ielts: "IELTS",
    gre: "GRE",
  };

  function parseExchange(value) {
    if (!value) return [];
    return String(value)
      .split("/")
      .map((part) => {
        const index = part.indexOf(":");
        if (index <= 0) return null;
        const key = part.slice(0, index).trim();
        const word = part.slice(index + 1).trim();
        if (!word) return null;
        return { label: EXCHANGE_LABELS[key] || key, word };
      })
      .filter(Boolean);
  }

  function renderTags(tags) {
    const list = String(tags || "").split(/\s+/).filter(Boolean);
    if (!list.length) return "";
    return list
      .map((tag) => `<span class="tag">${esc(TAG_LABELS[tag] || tag.toUpperCase())}</span>`)
      .join("");
  }

  function renderStars(count) {
    const value = Math.max(0, Math.min(5, Number(count) || 0));
    if (!value) return "";
    const stars = Array.from({ length: 5 }, (_, i) => (i < value ? "★" : "<i>★</i>")).join("");
    return `<span class="stars" title="柯林斯 ${value} 星">${stars}</span>`;
  }

  function renderHints(hints, options = {}) {
    if (!hints || !hints.length) return "";
    return `
      <div class="lookup-block">
        <h3>词缀拆解</h3>
        <div class="hint-list">
          ${hints.map((hint) => {
            const inner = `
              <b>${esc(hint.label)}</b>
              <span>${esc(hint.meaning || "")}</span>
            `;
            const linkable = options.linkable !== false && hint.type && hint.key;
            if (!linkable) {
              return `<span class="hint ${hint.confidence === "low" ? "is-low" : ""}">${inner}</span>`;
            }
            return `
              <a class="hint ${hint.confidence === "low" ? "is-low" : ""} is-link"
                href="#/affix/${esc(hint.type)}/${encodeURIComponent(hint.key)}"
                title="看看还有哪些词用了 ${esc(hint.label)}">${inner}</a>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  /**
   * 学习卡需要词缀拆解，但 /words/daily 不返回 hints。
   * 单独按词请求一次 /affixes/match 并缓存，避免每轮重复打。
   */
  const affixCache = new Map();

  async function loadAffixHints(word) {
    const key = String(word || "").trim().toLowerCase();
    if (!key) return [];
    if (affixCache.has(key)) return affixCache.get(key);
    let hints = [];
    try {
      const payload = await api(`/affixes/match?word=${encodeURIComponent(key)}`);
      hints = (payload.data && payload.data.hints) || [];
    } catch {
      hints = [];
    }
    affixCache.set(key, hints);
    return hints;
  }

  function renderStudyHints(hints) {
    if (!hints || !hints.length) return "";
    return `
      <details class="study-more">
        <summary>词缀拆解</summary>
        <div class="hint-list">
          ${hints.map((hint) => `
            <span class="hint ${hint.confidence === "low" ? "is-low" : ""}">
              <b>${esc(hint.label)}</b>
              <span>${esc(hint.meaning || "")}</span>
            </span>
          `).join("")}
        </div>
      </details>
    `;
  }

  /** 输入中文时，按释义反查词书里的英文单词。 */
  async function renderZhLookup(word) {
    const view = $("#view");
    view.innerHTML = `<div class="lookup"><div class="empty"><strong>正在按释义找「${esc(word)}」…</strong></div></div>`;

    let rows = [];
    try {
      const payload = await api(`/words?q=${encodeURIComponent(word)}&limit=40`);
      rows = (payload.data && payload.data.words) || [];
    } catch (error) {
      view.innerHTML = `
        <div class="lookup">
          <button class="lookup-back" type="button" data-action="lookup-back">← 返回</button>
          <div class="empty"><strong>查询失败</strong><span>${esc(error.message)}</span></div>
        </div>
      `;
      return;
    }

    if (!rows.length) {
      view.innerHTML = `
        <div class="lookup">
          <button class="lookup-back" type="button" data-action="lookup-back">← 返回</button>
          <div class="page-head">
            <p class="eyebrow">中文查词</p>
            <h1>没找到「${esc(word)}」</h1>
            <p class="sub">只匹配词书里 2,084 个词的释义，换个说法试试，或者直接输入英文。</p>
          </div>
        </div>
      `;
      return;
    }

    view.innerHTML = `
      <div class="lookup">
        <button class="lookup-back" type="button" data-action="lookup-back">← 返回</button>
        <div class="page-head">
          <p class="eyebrow">中文查词</p>
          <h1>「${esc(word)}」对应的单词</h1>
          <p class="sub">在词书释义里匹配到 ${rows.length} 个，点一个看详情。</p>
        </div>
        <div class="lookup-list panel">
          ${rows
            .map(
              (item) => `
            <button class="lookup-row" type="button" data-action="lookup-goto" data-word="${esc(item.headword)}">
              <b>${esc(item.headword)}</b>
              <span>${esc(item.translation || "")}</span>
              <em>${esc(statusLabel[item.status] || "")}</em>
            </button>`,
            )
            .join("")}
        </div>
      </div>
    `;
  }

  async function renderLookup(param) {
    const view = $("#view");
    const word = String(param || "").trim();

    // 输入中文时按释义反查英文单词
    if (word && /[\u3400-\u9fff]/.test(word)) {
      await renderZhLookup(word);
      return;
    }

    if (!word) {
      view.innerHTML = `
        <div class="lookup">
          <div class="page-head">
            <p class="eyebrow">查词</p>
            <h1>查一个词</h1>
            <p class="sub">输入英文查词典，输入中文可以按释义反查词书里的词。</p>
          </div>
          <form id="lookup-form" role="search">
            <label class="search">
              ${ICONS.search}
              <input id="lookup-input" type="search" placeholder="输入英文单词或中文释义，回车查询…" autocomplete="off" spellcheck="false" autofocus />
            </label>
          </form>
        </div>
      `;
      return;
    }

    view.innerHTML = `<div class="lookup"><div class="empty"><strong>正在查「${esc(word)}」…</strong></div></div>`;

    let data;
    try {
      const payload = await api(`/dict/${encodeURIComponent(word)}`);
      data = payload.data;
    } catch (error) {
      view.innerHTML = `
        <div class="lookup">
          <button class="lookup-back" type="button" data-action="lookup-back">← 返回</button>
          <div class="empty"><strong>查询失败</strong><span>${esc(error.message)}</span></div>
        </div>
      `;
      return;
    }

    const entry = data.entry;
    const dict = data.dict;
    const headword = (entry && entry.headword) || data.word || word;
    const phonetic = (entry && (entry.phoneticUk || entry.phoneticUs)) || (dict && dict.phonetic) || "";
    const translation = (entry && entry.translation) || (dict && dict.translation) || "";
    const definition = (dict && dict.definition) || (entry && entry.definitionEn) || "";
    const exchange = parseExchange((entry && entry.exchange) || (dict && dict.exchange) || "");
    const tags = (entry && entry.tags) || (dict && dict.tags) || "";
    const collins = dict ? dict.collins : entry ? entry.collins : 0;
    const status = entry ? state.progress[entry.id] || entry.status || "new" : null;
    const lines = String(definition).split("\\n").filter((line) => line.trim());

    view.innerHTML = `
      <div class="lookup">
        <button class="lookup-back" type="button" data-action="lookup-back">← 返回</button>

        ${data.found ? `
          <div class="lookup-card panel">
            <div class="lookup-head">
              <div>
                <h1 class="lookup-word">${esc(headword)}</h1>
                ${phonetic ? `<div class="lookup-phonetic">${esc(phonetic)}</div>` : ""}
              </div>
              <button class="speak-btn" type="button" data-action="lookup-speak" data-word="${esc(headword)}" title="朗读">${ICONS.speak}</button>
            </div>

            ${data.lemmatized ? `
              <div class="lookup-lemma">「${esc(word)}」是「${esc(data.lemma || headword)}」的变形，下面显示原词释义。</div>
            ` : ""}

            ${translation ? `
              <div class="lookup-block">
                <h3>中文释义</h3>
                <p class="lookup-translation">${esc(translation)}</p>
              </div>
            ` : ""}

            ${lines.length ? `
              <div class="lookup-block">
                <h3>英文释义</h3>
                <ul class="lookup-en">
                  ${lines.map((line) => `<li>${esc(line)}</li>`).join("")}
                </ul>
              </div>
            ` : ""}

            ${exchange.length ? `
              <div class="lookup-block">
                <h3>词形变化</h3>
                <div class="exchange-grid">
                  ${exchange.map((item) => `<span><b>${esc(item.label)}</b> ${esc(item.word)}</span>`).join("")}
                </div>
              </div>
            ` : ""}

            ${(tags || collins || (dict && dict.frq)) ? `
              <div class="lookup-block">
                <h3>标签</h3>
                <div class="tag-row" style="align-items:center">
                  ${renderTags(tags)}
                  ${renderStars(collins)}
                  ${dict && dict.frq ? `<span class="tag">词频 ${num(dict.frq)}</span>` : ""}
                </div>
              </div>
            ` : ""}

            ${renderHints(data.hints)}

            <div class="lookup-actions">
              ${entry ? `
                <div class="seg" data-id="${esc(entry.id)}">
                  ${["new", "learning", "known"].map((value) => `
                    <button type="button" data-action="set-status" data-status="${value}" class="${status === value ? "is-active" : ""}">${statusLabel[value]}</button>
                  `).join("")}
                </div>
                <button class="btn btn-ghost" type="button" data-action="lookup-star" data-id="${esc(entry.id)}" data-starred="${entry.starred ? "true" : "false"}">
                  ${entry.starred ? "取消星标" : "加星"}
                </button>
              ` : `
                <span class="sub">这个词不在当前词书里，只显示离线词典释义。</span>
              `}
              <button class="btn btn-ghost" type="button" data-action="open-notes" data-id="${entry ? esc(entry.id) : ""}" data-word="${esc(headword)}">
                笔记
              </button>
            </div>
          </div>
        ` : `
          <div class="empty" style="padding:56px 0">
            <strong>没有查到「${esc(word)}」</strong>
            <span>拼写可能不对，或者换成词根再试一次。</span>
          </div>
          ${renderHints(data.hints)}
        `}
      </div>
    `;

    if (state.pendingNotes) {
      state.pendingNotes = null;
      openNotesPanel({ wordId: entry ? entry.id : "", headword });
    }
  }

  /* ---------------- 今日 ---------------- */

  async function renderToday() {
    const view = $("#view");
    view.innerHTML = '<div class="empty"><strong>正在加载今日词单…</strong></div>';
    await loadMeta();
    const daily = await loadDaily();
    if (!daily) {
      view.innerHTML = `<div class="empty"><strong>词库没有加载出来</strong><span>请检查本地服务后重试</span></div>`;
      return;
    }

    const stats = dailyStats();
    const percent = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
    const allDone = stats.total > 0 && stats.done >= stats.total;
    const actionLabel = stats.done === 0 ? "开始今日学习" : allDone ? "再复习一遍" : "继续学习";

    view.innerHTML = `
      <div class="page-head">
        <p class="eyebrow">${esc(dateLabel())}</p>
        <h1>今天 <span class="thin">· ${stats.total} 个词</span></h1>
        <p class="sub">看一遍，想一想，再揭晓。认识就过，不认识就留到下一轮。</p>
      </div>

      <section class="today-card panel">
        <div class="today-top">
          <strong>${allDone ? "今日已完成" : "今日进度"}</strong>
          <span>${stats.done} / ${stats.total}</span>
        </div>
        <div class="progress"><i style="width:${percent}%"></i></div>
        <div class="today-actions">
          <button class="btn btn-primary" type="button" data-action="start-study">
            ${ICONS.enter}
            ${actionLabel}
          </button>
          <a class="btn btn-quiet" href="#/bank">浏览词库</a>
          <span class="streak">连续 <b>${streakDays()}</b> 天</span>
        </div>
      </section>

      ${Number(state.reviewDue || 0) ? `
        <a class="review-banner" href="#/review">
          <b>${state.reviewDue}</b> 个词到了复习时间 →
        </a>
      ` : ""}

      <section class="section">
        <div class="section-head">
          <h2>今日词单</h2>
          <span>按日期固定，明天会换一批</span>
        </div>
        ${renderWordList(daily.words, { showIndex: true })}
      </section>
    `;
  }

  function renderWordList(words, options = {}) {
    if (!words || !words.length) {
      return '<div class="empty"><strong>这里还没有单词</strong><span>换个筛选条件试试</span></div>';
    }

    return `
      <ul class="word-list">
        ${words.map((word, index) => {
          const status = state.progress[word.id] || word.status || "new";
          const phonetic = (word.phoneticUs || word.phoneticUk || "").trim();
          const selected = options.selectable && state.bank.selected.has(word.id);
          return `
            <li${options.selectable ? ' class="is-selectable"' : ""}>
              ${options.selectable ? `
                <span class="word-check ${selected ? "is-checked" : ""}" data-action="select-word" data-id="${esc(word.id)}" role="checkbox" aria-checked="${selected ? "true" : "false"}" tabindex="0"></span>
              ` : ""}
              <button class="word-row" type="button" data-action="open-word" data-id="${esc(word.id)}">
                ${options.showIndex ? `<span class="word-index">${String(index + 1).padStart(2, "0")}</span>` : ""}
                <span class="word-main">
                  <span class="word-head">
                    <b>${esc(word.headword)}</b>
                    ${phonetic ? `<span class="word-phonetic">${esc(phonetic)}</span>` : ""}
                  </span>
                  <span class="word-translation">${esc(word.translation || "暂无释义")}</span>
                </span>
                <span class="word-side">
                  <span class="status-dot ${status === "known" ? "is-known" : status === "learning" ? "is-learning" : ""}" title="${statusLabel[status] || status}"></span>
                  <span class="star-btn ${word.starred ? "is-starred" : ""}" role="button" tabindex="0" data-action="toggle-star" data-id="${esc(word.id)}" title="${word.starred ? "取消星标" : "加星"}">${ICONS.star}</span>
                </span>
              </button>
            </li>
          `;
        }).join("")}
      </ul>
    `;
  }

  /* ---------------- 词库 ---------------- */

  function bankQuery() {
    const bank = state.bank;
    const params = new URLSearchParams();
    params.set("limit", "50");
    params.set("sort", bank.sort);
    const book = bookParam();
    if (book) params.set("book", book);
    if (bank.q) params.set("q", bank.q);
    if (bank.status) params.set("status", bank.status);
    if (bank.starred) params.set("starred", "1");
    if (bank.cursor) params.set("cursor", bank.cursor);
    return params.toString();
  }

  async function loadBank(reset = false) {
    const bank = state.bank;
    if (bank.loading) return;
    if (!reset && !bank.hasMore) return;
    if (reset) {
      bank.cursor = null;
      bank.hasMore = true;
      bank.items = [];
      bank.loaded = false;
    }

    bank.loading = true;
    renderBankList();
    try {
      const payload = await api(`/words?${bankQuery()}`);
      const words = (payload.data && payload.data.words) || [];
      const meta = payload.meta || {};
      bank.items = reset ? words : bank.items.concat(words);
      bank.cursor = meta.nextCursor || null;
      bank.hasMore = Boolean(meta.hasMore);
      bank.total = Number(meta.total || bank.items.length);
      bank.loaded = true;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      bank.loading = false;
      renderBankList();
    }
  }

  async function renderBankPage() {
    const view = $("#view");
    const bank = state.bank;
    if (!bank.loaded) {
      view.innerHTML = `
        <div class="page-head">
          <p class="eyebrow">词库</p>
          <h1>全部单词 <span class="thin">· ${state.meta ? num(state.meta.counts.total) : "—"}</span></h1>
          <p class="sub">按状态筛选或搜索释义，也可以 <a class="text-link" href="#/affix">按词缀浏览 →</a></p>
        </div>
        ${renderBankToolbar()}
        <div id="bank-list"><div class="empty"><strong>正在加载…</strong></div></div>
      `;
      await loadBank(true);
      if (bank.loaded) return renderBankPage();
      view.innerHTML = `
        <div class="page-head">
          <p class="eyebrow">词库</p>
          <h1>全部单词</h1>
        </div>
        <div class="empty"><strong>词库没有加载出来</strong><span>稍后再试一次</span></div>
      `;
      return;
    }

    view.innerHTML = `
      <div class="page-head">
        <p class="eyebrow">词库</p>
        <h1>全部单词 <span class="thin">· ${num(bank.total)}</span></h1>
        <p class="sub">按状态筛选或搜索释义，也可以 <a class="text-link" href="#/affix">按词缀浏览 →</a></p>
      </div>
      ${renderBankToolbar()}
      <div id="bank-list"></div>
    `;
    renderBankList();
  }

  function renderBankToolbar() {
    const bank = state.bank;
    const chips = [
      { key: "", label: "全部", active: !bank.status && !bank.starred },
      { key: "new", label: "未学", active: bank.status === "new" && !bank.starred },
      { key: "learning", label: "学习中", active: bank.status === "learning" && !bank.starred },
      { key: "known", label: "已掌握", active: bank.status === "known" && !bank.starred },
      { key: "starred", label: "星标", active: bank.starred },
    ];

    return `
      <div class="bank-toolbar">
        <label class="search">
          ${ICONS.search}
          <input id="bank-search" type="search" placeholder="搜索单词或释义…" value="${esc(bank.q)}" autocomplete="off" />
        </label>
        <div class="chips">
          ${chips.map((chip) => `
            <button class="chip ${chip.active ? "is-active" : ""}" type="button"
              data-action="bank-chip" data-chip="${chip.key}">${chip.label}</button>
          `).join("")}
        </div>
        <select class="select" id="bank-sort" aria-label="排序">
          <option value="order" ${bank.sort === "order" ? "selected" : ""}>词书顺序</option>
          <option value="az" ${bank.sort === "az" ? "selected" : ""}>A → Z</option>
          <option value="recent" ${bank.sort === "recent" ? "selected" : ""}>最近添加</option>
          <option value="starred" ${bank.sort === "starred" ? "selected" : ""}>星标优先</option>
        </select>
      </div>
      <div class="bank-meta">
        <span id="bank-count">${num(state.bank.total)} 个词</span>
        <span id="bank-filter-note">${state.bank.starred ? "只看星标" : state.bank.status ? statusLabel[state.bank.status] : "全部状态"}</span>
        <button class="link-btn" type="button" data-action="enter-select">多选</button>
      </div>
      ${renderSelectionBar()}
    `;
  }

  function renderSelectionBar() {
    const bank = state.bank;
    if (!bank.selecting) return "";
    const count = bank.selected.size;
    return `
      <div class="selection-bar">
        <span class="selection-count">已选 <b>${count}</b> 个</span>
        <span class="selection-actions">
          <button class="btn btn-ghost btn-compact" type="button" data-action="select-all">全选本页</button>
          <button class="btn btn-ghost btn-compact" type="button" data-action="select-none">清空</button>
          <button class="btn btn-ghost btn-compact" type="button" data-action="batch-star" data-starred="1" ${count ? "" : "disabled"}>加星</button>
          <button class="btn btn-ghost btn-compact" type="button" data-action="batch-star" data-starred="0" ${count ? "" : "disabled"}>取消星标</button>
          <button class="btn btn-ghost btn-compact btn-danger" type="button" data-action="batch-delete" ${count ? "" : "disabled"}>删除</button>
          <button class="btn btn-ghost btn-compact" type="button" data-action="exit-select">退出多选</button>
        </span>
      </div>
    `;
  }

  function renderBankList() {
    const host = $("#bank-list");
    if (!host) return;
    const bank = state.bank;

    if (!bank.loaded) {
      host.innerHTML = '<div class="empty"><strong>正在加载…</strong></div>';
      return;
    }

    if (!bank.items.length) {
      host.innerHTML = '<div class="empty"><strong>没有找到匹配的单词</strong><span>换个关键词或筛选条件</span></div>';
      return;
    }

    const count = $("#bank-count");
    if (count) count.textContent = `${num(bank.total)} 个词`;

    host.innerHTML = renderWordList(bank.items, { selectable: bank.selecting }) + (bank.hasMore
      ? `<button class="load-more" type="button" data-action="load-more" ${bank.loading ? "disabled" : ""}>${bank.loading ? "加载中…" : "加载更多"}</button>`
      : "");
  }

  async function batchStarWords(ids, starred) {
    if (!ids.length) return;
    try {
      await api("/words/batch-star", { method: "POST", body: { ids, starred } });
      toast(`${starred ? "已加星" : "已取消星标"} ${ids.length} 个词`);
      state.bank.selected = new Set();
      loadMeta();
      state.bank.loaded = false;
      await renderBankPage();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function batchDeleteSelected() {
    const ids = [...state.bank.selected];
    if (!ids.length) return;
    if (!window.confirm(`删除选中的 ${ids.length} 个词？这个操作不可撤销。`)) return;
    try {
      const payload = await api("/words/batch-delete", { method: "POST", body: { ids } });
      toast(`已删除 ${num((payload.data && payload.data.deleted) || ids.length)} 个词`);
      state.bank.selected = new Set();
      state.bank.loaded = false;
      loadMeta();
      await renderBankPage();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------------- 学习 ---------------- */

  function startStudy() {
    if (!state.daily) return;
    const words = state.daily.words || [];
    let index = words.findIndex((word) => !state.progress[word.id]);
    if (index < 0) index = 0;
    state.study = { words, index, revealed: false, known: 0, learning: 0, done: false };
    location.hash = "#/study";
  }

  async function renderStudyPage() {
    const view = $("#view");
    if (!state.daily) await loadDaily();
    if (!state.daily) {
      location.hash = "#/today";
      return;
    }

    let study = state.study;
    if (!study || !study.words.length) {
      const words = state.daily.words || [];
      let index = words.findIndex((word) => !state.progress[word.id]);
      if (index < 0) index = 0;
      study = state.study = { words, index, revealed: false, known: 0, learning: 0, done: false };
    }

    if (study.index >= study.words.length) {
      study.done = true;
    }

    if (study.done) {
      const days = streakDays();
      view.innerHTML = `
        <div class="done-view">
          <div class="done-mark">${ICONS.check}</div>
          <h1>这一轮完成了</h1>
          <p class="sub">认识 ${study.known} 个，不认识 ${study.learning} 个。不认识的已经标记为「学习中」。</p>
          <div class="done-stats">
            <div><b>${study.known}</b><span>认识</span></div>
            <div><b>${study.learning}</b><span>不认识</span></div>
            <div><b>${days}</b><span>连续天数</span></div>
          </div>
          <div class="done-actions">
            <button class="btn btn-primary" type="button" data-action="restart-study">再来一轮</button>
            <a class="btn btn-ghost" href="#/today">回到今日</a>
          </div>
        </div>
      `;
      return;
    }

    const word = study.words[study.index];
    const phonetic = (word.phoneticUs || word.phoneticUk || "").trim();
    const total = study.words.length;
    const percent = Math.round((study.index / total) * 100);
    const exchange = parseExchange(word.exchange || "");
    const definitionLines = String(word.definitionEn || "")
      .split("\\n")
      .map((line) => line.trim())
      .filter(Boolean);

    view.innerHTML = `
      <div class="study-view">
        <div class="study-bar">
          <button class="btn btn-quiet" type="button" data-action="exit-study" title="退出学习">${ICONS.close}</button>
          <div class="progress"><i style="width:${percent}%"></i></div>
          <span>${study.index + 1} / ${total}</span>
        </div>

        <div class="study-card panel" data-action="reveal">
          <p class="eyebrow">${esc(word.pos || "CET-6")}</p>
          <h2 class="study-word">${esc(word.headword)}</h2>
          ${phonetic ? `<div class="study-phonetic">${esc(phonetic)}</div>` : ""}
          <button class="speak-btn" type="button" data-action="speak" title="朗读">${ICONS.speak}</button>

          ${study.revealed ? `
            <div class="study-answer">
              <p class="study-translation">${esc(word.translation || "暂无释义")}</p>
              ${word.note ? `<div class="study-note">${esc(word.note)}</div>` : ""}

              ${(word.tags || word.collins) ? `
                <div class="study-meta">
                  ${renderTags(word.tags)}
                  ${renderStars(word.collins)}
                </div>
              ` : ""}

              ${exchange.length ? `
                <details class="study-more">
                  <summary>词形变化</summary>
                  <div class="exchange-grid">
                    ${exchange.map((item) => `<span><b>${esc(item.label)}</b> ${esc(item.word)}</span>`).join("")}
                  </div>
                </details>
              ` : ""}

              ${definitionLines.length ? `
                <details class="study-more">
                  <summary>英文释义</summary>
                  <ul class="lookup-en">
                    ${definitionLines.map((line) => `<li>${esc(line)}</li>`).join("")}
                  </ul>
                </details>
              ` : ""}

              <div id="study-affix"></div>
            </div>
          ` : `
            <div class="study-hint">按 <kbd>空格</kbd> 揭晓释义</div>
          `}
        </div>

        <div class="study-controls">
          <button class="btn btn-again" type="button" data-action="mark" data-status="learning">
            不认识 <kbd class="sr-hidden">1</kbd>
          </button>
          <button class="btn btn-know" type="button" data-action="mark" data-status="known">
            ${study.revealed ? "认识" : "已经认识"}
          </button>
        </div>
      </div>
    `;

    if (study.revealed) {
      const holder = $("#study-affix");
      if (holder) {
        const hints = await loadAffixHints(word.headword);
        if (holder.isConnected) holder.innerHTML = renderStudyHints(hints);
      }
    }
  }

  async function markStudy(status) {
    const study = state.study;
    if (!study || study.done) return;
    const word = study.words[study.index];
    if (!word) return;

    state.progress[word.id] = status;
    saveProgress();
    if (status === "known") study.known += 1;
    else study.learning += 1;

    // 认识的词进入记忆曲线，不认识的 10 分钟后再来
    const rating = status === "known" ? "good" : "again";
    try {
      await api(`/review/${encodeURIComponent(word.id)}`, { method: "POST", body: { rating } });
    } catch (error) {
      toast("复习卡没有建上：" + error.message, "error");
    }

    try {
      await api(`/words/${encodeURIComponent(word.id)}`, { method: "PATCH", body: { status } });
    } catch (error) {
      toast("状态没有同步到词库：" + error.message, "error");
    }

    study.index += 1;
    study.revealed = false;
    if (study.index >= study.words.length) {
      study.done = true;
      bumpStreak();
      loadMeta();
    }
    renderStudyPage();
  }

  /* ---------------- 复习（记忆曲线） ---------------- */

  const RATING_OPTIONS = [
    { key: "again", label: "忘了", note: "10 分钟后再来" },
    { key: "hard", label: "勉强", note: "小步推进" },
    { key: "good", label: "记得", note: "按曲线走" },
    { key: "easy", label: "太简单", note: "拉长间隔" },
  ];

  async function loadReviewStats() {
    try {
      const book = bookParam();
      const payload = await api(`/review/stats${book ? `?book=${encodeURIComponent(book)}` : ""}`);
      state.reviewStats = payload.data;
      state.reviewDue = Number(payload.data.due || 0);
    } catch {
      state.reviewStats = null;
      state.reviewDue = 0;
    }
    updateReviewBadge();
    return state.reviewStats;
  }

  function intervalLabel(days) {
    const value = Number(days || 0);
    if (!value) return "10 分钟后";
    if (value < 30) return `${value} 天后`;
    if (value < 365) return `${Math.round(value / 30)} 个月后`;
    return `${Math.round(value / 365)} 年后`;
  }

  async function loadReviewQueue(size = 50) {
    const book = bookParam();
    const payload = await api(`/review/queue?size=${size}${book ? `&book=${encodeURIComponent(book)}` : ""}`);
    return payload.data.words || [];
  }

  async function renderReviewPage() {
    const view = $("#view");
    view.innerHTML = '<div class="empty"><strong>正在取出到期的卡片…</strong></div>';

    const stats = await loadReviewStats();
    let words = [];
    try {
      words = await loadReviewQueue();
    } catch (error) {
      view.innerHTML = `<div class="empty"><strong>复习队列没有加载出来</strong><span>${esc(error.message)}</span></div>`;
      return;
    }

    if (!words.length) {
      state.review = null;
      view.innerHTML = renderReviewEmpty(stats);
      return;
    }

    if (!state.review || state.review.done) {
      state.review = { words, index: 0, revealed: false, done: false, reviewed: 0, good: 0, again: 0 };
    } else {
      // 保留进度，但刷新卡片内容（间隔可能在别的页面被改过）
      state.review.words = words;
    }
    renderReviewCard();
  }

  function renderReviewEmpty(stats) {
    const cards = (stats && stats.cards) || { total: 0, mature: 0, learning: 0 };
    const today = (stats && stats.today) || { reviewed: 0, correct: 0 };
    const streak = (stats && stats.streak) || 0;

    return `
      <div class="page-head">
        <p class="eyebrow">记忆曲线</p>
        <h1>复习</h1>
        <p class="sub">到期的词会按间隔出现：忘了 10 分钟后再来，记得就往后推。</p>
      </div>

      <div class="home-stats">
        <div class="stat-card">
          <b>${num(today.reviewed)}</b>
          <span>今天已复习</span>
        </div>
        <div class="stat-card">
          <b>${num(cards.total)}</b>
          <span>复习卡</span>
        </div>
        <div class="stat-card">
          <b>${num(streak)}</b>
          <span>连续天数</span>
        </div>
      </div>

      <div class="empty" style="margin-top:26px">
        <strong>${cards.total ? "今天没有到期的复习" : "还没有复习卡"}</strong>
        <span>${cards.total
          ? "新的到期卡片会按间隔自动出现，明天再来看看。"
          : "在「今日」学完一轮后，认识的词会进入复习队列，之后按间隔出现。"}</span>
        <div style="margin-top:18px">
          <a class="btn btn-primary" href="#/today">去学今日 ${DAILY_SIZE} 词</a>
        </div>
      </div>
    `;
  }

  function renderReviewCard() {
    const view = $("#view");
    const review = state.review;
    if (!review) {
      location.hash = "#/review";
      return;
    }

    if (review.index >= review.words.length) {
      review.done = true;
      view.innerHTML = renderReviewDone();
      loadReviewStats();
      return;
    }

    const word = review.words[review.index];
    const total = review.words.length;
    const percent = Math.round((review.index / total) * 100);
    const phonetic = (word.phoneticUs || word.phoneticUk || "").trim();
    const stage = Number((word.review && word.review.stage) || 0);
    const reps = Number((word.review && word.review.reps) || 0);

    view.innerHTML = `
      <div class="study-view">
        <div class="study-bar">
          <button class="btn btn-quiet" type="button" data-action="exit-review" title="退出复习">${ICONS.close}</button>
          <div class="progress"><i style="width:${percent}%"></i></div>
          <span>${review.index + 1} / ${total}</span>
        </div>

        <div class="study-card panel" data-action="review-reveal">
          <p class="eyebrow">${reps ? `复习过 ${reps} 次 · ` : ""}${esc(word.pos || "CET-6")}</p>
          <h2 class="study-word">${esc(word.headword)}</h2>
          ${phonetic ? `<div class="study-phonetic">${esc(phonetic)}</div>` : ""}
          <button class="speak-btn" type="button" data-action="review-speak" title="朗读">${ICONS.speak}</button>

          ${review.revealed ? `
            <div class="study-answer">
              <p class="study-translation">${esc(word.translation || "暂无释义")}</p>
              ${word.note ? `<div class="study-note">${esc(word.note)}</div>` : ""}
              <p class="review-tip">按 <kbd>1</kbd>–<kbd>4</kbd> 评分，也可以点下面的按钮</p>
            </div>
          ` : `
            <div class="study-hint">先在心里过一遍，按 <kbd>空格</kbd> 揭晓</div>
          `}
        </div>

        ${review.revealed ? `
          <div class="review-ratings">
            ${RATING_OPTIONS.map((option, index) => `
              <button class="rate-btn" type="button" data-action="review-rate" data-rating="${option.key}">
                <b>${option.label}</b>
                <span>${option.note}</span>
                <kbd>${index + 1}</kbd>
              </button>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderReviewDone() {
    const review = state.review || { reviewed: 0, good: 0, again: 0 };
    return `
      <div class="done-view">
        <div class="done-mark">${ICONS.check}</div>
        <h1>复习完成</h1>
        <p class="sub">这一轮复习了 ${review.reviewed} 张卡，记得 ${review.good} 张，需要重来 ${review.again} 张。</p>
        <div class="done-stats">
          <div><b>${review.reviewed}</b><span>复习</span></div>
          <div><b>${review.good}</b><span>记得</span></div>
          <div><b>${review.again}</b><span>忘了</span></div>
        </div>
        <div class="done-actions">
          <a class="btn btn-primary" href="#/today">回到今日</a>
          <button class="btn btn-ghost" type="button" data-action="restart-review">再看一轮</button>
        </div>
      </div>
    `;
  }

  async function rateReview(rating) {
    const review = state.review;
    if (!review || review.done) return;
    const word = review.words[review.index];
    if (!word) return;

    review.reviewed += 1;
    if (rating === "again") review.again += 1;
    else if (rating === "good" || rating === "easy") review.good += 1;

    try {
      const payload = await api(`/review/${encodeURIComponent(word.id)}`, {
        method: "POST",
        body: { rating },
      });
      const next = (payload.data && payload.data.review) || {};
      const label = rating === "again" ? "10 分钟后再来" : `下次 ${intervalLabel(next.interval)}`;
      toast(`${word.headword} · ${label}`);
    } catch (error) {
      toast("评分没有保存：" + error.message, "error");
    }

    review.index += 1;
    review.revealed = false;
    renderReviewCard();
  }

  function restartReview() {
    state.review = null;
    renderReviewPage();
  }

  /* ---------------- 笔记 ---------------- */

  let notesPanelTarget = null;

  async function fetchNotes(query = {}) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value) params.set(key, String(value));
    });
    const suffix = params.toString();
    return api(`/notes${suffix ? `?${suffix}` : ""}`);
  }

  function noteTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderNoteRow(note, options = {}) {
    const editing = state.noteEditId === note.id;
    return `
      <li class="note-item${editing ? " is-editing" : ""}" data-note-id="${esc(note.id)}">
        ${options.showWord ? `
          <a class="note-word" href="#/lookup/${encodeURIComponent(note.headword)}">${esc(note.headword)}</a>
        ` : ""}
        ${editing ? `
          <textarea class="note-edit-input" rows="3" maxlength="5000">${esc(note.content)}</textarea>
          <div class="note-meta">
            <span></span>
            <span class="note-ops">
              <button type="button" data-action="note-save-edit" data-id="${esc(note.id)}">保存</button>
              <button type="button" data-action="note-cancel-edit">取消</button>
            </span>
          </div>
        ` : `
          <p class="note-content">${esc(note.content)}</p>
          <div class="note-meta">
            <span>${esc(noteTime(note.updatedAt))}</span>
            <span class="note-ops">
              <button type="button" data-action="note-edit" data-id="${esc(note.id)}">编辑</button>
              <button type="button" data-action="note-delete" data-id="${esc(note.id)}">删除</button>
            </span>
          </div>
        `}
      </li>
    `;
  }

  async function openNotesPanel(target) {
    notesPanelTarget = target || {};
    state.noteEditId = null;

    openModal(modalShell(
      "笔记",
      notesPanelTarget.headword || "全部笔记",
      '<div id="notes-panel-body"><div class="empty small"><strong>正在加载笔记…</strong></div></div>',
    ));
    await refreshNotesPanel();
  }

  async function refreshNotesPanel() {
    const body = $("#notes-panel-body");
    if (!body) return;

    const target = notesPanelTarget || {};
    let notes = [];
    try {
      const payload = await fetchNotes(target.headword ? { word: target.headword, limit: 100 } : { limit: 100 });
      notes = payload.data.notes || [];
    } catch (error) {
      body.innerHTML = `<div class="empty small"><strong>笔记没有加载出来</strong><span>${esc(error.message)}</span></div>`;
      return;
    }

    body.innerHTML = `
      <form class="note-form" id="note-form">
        <textarea id="note-input" rows="3" maxlength="5000" placeholder="记点什么：词根、例句、易混词…"></textarea>
        <div class="note-form-actions">
          <span>${notes.length} 条</span>
          <button class="btn btn-primary" type="submit">保存笔记</button>
        </div>
      </form>
      ${notes.length
        ? `<ul class="note-list">${notes.map((note) => renderNoteRow(note)).join("")}</ul>`
        : '<div class="empty small"><strong>这个词还没有笔记</strong></div>'}
    `;
  }

  async function saveNote() {
    const input = $("#note-input");
    const content = (input && input.value ? input.value : "").trim();
    if (!content) {
      toast("先写点内容再保存", "error");
      return;
    }

    const target = notesPanelTarget || {};
    const body = content ? { content } : {};
    if (target.wordId) body.wordId = target.wordId;
    else if (target.headword) body.headword = target.headword;

    try {
      await api("/notes", { method: "POST", body });
      toast("笔记已保存");
      if (input) input.value = "";
      await refreshNotesPanel();
    } catch (error) {
      toast("保存失败：" + error.message, "error");
    }
  }

  function startEditNote(id) {
    state.noteEditId = id;
    refreshNotesPanel();
  }

  async function saveEditNote(id) {
    const item = document.querySelector(`.note-item[data-note-id="${id}"]`);
    const box = item && item.querySelector(".note-edit-input");
    const content = (box && box.value ? box.value : "").trim();
    if (!content) {
      toast("内容不能为空", "error");
      return;
    }

    try {
      await api(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: { content } });
      state.noteEditId = null;
      toast("笔记已更新");
      await refreshNotesPanel();
    } catch (error) {
      toast("更新失败：" + error.message, "error");
    }
  }

  async function removeNote(id) {
    try {
      await api(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.noteEditId = null;
      toast("笔记已删除");
      if (parseView() === "notes") await loadNotesPage(true);
      else await refreshNotesPanel();
    } catch (error) {
      toast("删除失败：" + error.message, "error");
    }
  }

  /* ---------------- 笔记本页 ---------------- */

  async function renderNotesPage() {
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <p class="eyebrow">笔记本</p>
        <h1>笔记 <span class="thin" id="notes-total"></span></h1>
        <p class="sub">写在单词上的东西：词根、例句、易混词。点单词回到它的词条。</p>
      </div>

      <label class="search notes-search">
        ${ICONS.search}
        <input id="notes-search" type="search" placeholder="搜索笔记内容或单词…" autocomplete="off" spellcheck="false" value="${esc(state.notesPage.q)}" />
      </label>

      <div id="notes-page-body"><div class="empty"><strong>正在加载…</strong></div></div>
    `;

    if (!state.notesPage.loaded) await loadNotesPage(true);
    else renderNotesList();
  }

  async function loadNotesPage(reset = false) {
    const page = state.notesPage;
    if (page.loading) return;
    page.loading = true;

    if (reset) {
      page.notes = [];
      page.cursor = null;
      page.hasMore = true;
    }

    try {
      const payload = await fetchNotes({ q: page.q, limit: 50, cursor: page.cursor });
      page.notes = reset ? payload.data.notes : page.notes.concat(payload.data.notes);
      page.cursor = payload.meta.nextCursor;
      page.hasMore = Boolean(payload.meta.nextCursor);
      page.total = payload.meta.total;
      page.loaded = true;
    } catch (error) {
      $("#notes-page-body").innerHTML = `<div class="empty"><strong>笔记没有加载出来</strong><span>${esc(error.message)}</span></div>`;
      page.loading = false;
      return;
    }

    page.loading = false;
    renderNotesList();
  }

  function renderNotesList() {
    const page = state.notesPage;
    const holder = $("#notes-page-body");
    if (!holder) return;

    const total = $("#notes-total");
    if (total) total.textContent = page.total ? `· ${num(page.total)} 条` : "";

    if (!page.notes.length) {
      holder.innerHTML = page.q
        ? `<div class="empty"><strong>没有匹配「${esc(page.q)}」的笔记</strong><span>换个关键词试试</span></div>`
        : `<div class="empty"><strong>还没有笔记</strong><span>在查词页或词条详情里点「笔记」就能写第一条。</span></div>`;
      return;
    }

    holder.innerHTML = `
      <ul class="note-list">
        ${page.notes.map((note) => renderNoteRow(note, { showWord: true })).join("")}
      </ul>
      ${page.hasMore ? '<button class="load-more" type="button" data-action="notes-load-more">加载更多</button>' : ""}
    `;
  }

  /* ---------------- 统计 ---------------- */

  async function renderStatsPage() {
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <p class="eyebrow">统计</p>
        <h1>学习统计</h1>
      </div>
      <div class="empty"><strong>正在统计…</strong></div>
    `;

    const stats = await loadReviewStats();
    if (!stats) {
      view.innerHTML = `
        <div class="page-head">
          <p class="eyebrow">统计</p>
          <h1>学习统计</h1>
        </div>
        <div class="empty"><strong>统计没有加载出来</strong><span>稍后再试一次</span></div>
      `;
      return;
    }

    const cards = stats.cards || { total: 0, mature: 0, learning: 0 };
    const today = stats.today || { reviewed: 0, correct: 0 };
    const streak = Number(stats.streak || 0);
    const due = Number(stats.due || 0);
    const daily = stats.daily || [];
    const accuracy = today.reviewed ? Math.round((today.correct / today.reviewed) * 100) : null;

    const maxReviewed = Math.max(1, ...daily.map((day) => Number(day.reviewed || 0)));
    const activeDays = daily.filter((day) => Number(day.reviewed || 0) > 0).length;
    const totalReviewed = daily.reduce((sum, day) => sum + Number(day.reviewed || 0), 0);
    const totalCorrect = daily.reduce((sum, day) => sum + Number(day.correct || 0), 0);
    const periodAccuracy = totalReviewed ? Math.round((totalCorrect / totalReviewed) * 100) : null;

    const bars = daily
      .map((day) => {
        const reviewed = Number(day.reviewed || 0);
        const correct = Number(day.correct || 0);
        const height = reviewed ? Math.max(8, Math.round((reviewed / maxReviewed) * 100)) : 0;
        const ratio = reviewed ? correct / reviewed : 0;
        const tone = !reviewed ? "is-empty" : ratio >= 0.8 ? "is-good" : ratio >= 0.5 ? "is-mid" : "is-low";
        const tip = `${day.date}：复习 ${reviewed} 个，对 ${correct} 个`;
        return `
          <div class="stat-bar" title="${esc(tip)}">
            <span class="stat-bar-fill ${tone}" style="height:${height}%"></span>
          </div>
        `;
      })
      .join("");

    const first = daily[0] ? daily[0].date.slice(5) : "";
    const last = daily.length ? daily[daily.length - 1].date.slice(5) : "";

    const todayLine = today.reviewed
      ? `今天复习 ${num(today.reviewed)} 个${accuracy !== null ? `，正确率 ${accuracy}%` : ""}`
      : "今天还没开始复习";
    const headLine = streak > 0 ? `连续 <b>${num(streak)}</b> 天 · ${todayLine}` : todayLine;

    view.innerHTML = `
      <div class="page-head">
        <p class="eyebrow">统计</p>
        <h1>学习统计 <span class="thin">· ${num(cards.total)} 张卡片</span></h1>
        <p class="sub">${headLine}</p>
      </div>

      <div class="stats-grid">
        <div class="stats-card"><b>${num(cards.mature)}</b><span>已成熟 · 间隔 ≥ 21 天</span></div>
        <div class="stats-card"><b>${num(cards.learning)}</b><span>巩固中</span></div>
        <div class="stats-card"><b>${num(due)}</b><span>今天到期</span></div>
        <div class="stats-card"><b>${periodAccuracy === null ? "—" : periodAccuracy + "%"}</b><span>近 30 天正确率</span></div>
      </div>

      <div class="panel stats-panel">
        <div class="stats-panel-head">
          <h3>近 30 天</h3>
          <span class="sub">${activeDays} 天有复习 · 共 ${num(totalReviewed)} 次</span>
        </div>
        ${totalReviewed
          ? `<div class="stat-chart">${bars}</div>
             <div class="stat-axis"><span>${esc(first)}</span><span>${esc(last)}</span></div>
             <div class="stat-legend">
               <span><i class="is-good"></i>正确率 ≥ 80%</span>
               <span><i class="is-mid"></i>50%–80%</span>
               <span><i class="is-low"></i>&lt; 50%</span>
             </div>`
          : `<div class="empty"><strong>这 30 天还没有复习记录</strong><span>学几个词，明天到期的卡片会出现在这里。</span></div>`}
      </div>

      ${streak > 0 ? `
        <div class="panel streak-panel">
          <div class="streak-mark">${ICONS.check}</div>
          <div>
            <strong>连续 ${num(streak)} 天</strong>
            <span class="sub">每天复习一点点，比一次背很多更管用。</span>
          </div>
        </div>
      ` : ""}
    `;
  }

  /* ---------------- 词缀 ---------------- */

  const AFFIX_TYPES = [
    { key: "prefix", label: "前缀" },
    { key: "suffix", label: "后缀" },
    { key: "root", label: "词根" },
  ];

  const AFFIX_TYPE_LABEL = { prefix: "前缀", suffix: "后缀", root: "词根" };

  async function loadAffixCatalog() {
    const page = state.affixPage;
    if (page.catalog) return page.catalog;
    const payload = await api("/affixes");
    page.catalog = payload.data;
    return page.catalog;
  }

  function affixLists(catalog) {
    return {
      prefix: (catalog && catalog.prefixes) || [],
      suffix: (catalog && catalog.suffixes) || [],
      root: (catalog && catalog.roots) || [],
    };
  }

  async function renderAffix(param) {
    const raw = String(param || "");
    const slash = raw.indexOf("/");
    const type = slash >= 0 ? raw.slice(0, slash) : "";
    const key = slash >= 0 ? raw.slice(slash + 1) : "";

    if (type && key) {
      await renderAffixWordsPage(type, key);
      return;
    }

    const view = $("#view");
    const page = state.affixPage;
    try {
      await loadAffixCatalog();
    } catch (error) {
      view.innerHTML = `<div class="empty"><strong>词缀目录没有加载出来</strong><span>${esc(error.message)}</span></div>`;
      return;
    }

    const lists = affixLists(page.catalog);
    const total = lists.prefix.length + lists.suffix.length + lists.root.length;

    view.innerHTML = `
      <div class="page-head">
        <p class="eyebrow">词缀索引</p>
        <h1>词缀 <span class="thin">· ${num(total)} 个</span></h1>
        <p class="sub">把单词拆成前缀、后缀、词根，记一个词缀等于记住一串词。</p>
      </div>

      <label class="search affix-search">
        ${ICONS.search}
        <input id="affix-filter" type="search" placeholder="过滤词缀或含义，比如 un / 否定…" autocomplete="off" spellcheck="false" value="${esc(page.filter)}" />
      </label>

      <div class="chips affix-tabs">
        ${AFFIX_TYPES.map((item) => `
          <button class="chip ${page.tab === item.key ? "is-active" : ""}" type="button"
            data-action="affix-tab" data-type="${item.key}">${item.label} ${lists[item.key].length}</button>
        `).join("")}
      </div>

      <div id="affix-grid" class="affix-grid"></div>
    `;

    renderAffixGrid();
  }

  function renderAffixGrid() {
    const host = $("#affix-grid");
    if (!host) return;

    const page = state.affixPage;
    const lists = affixLists(page.catalog);
    const q = page.filter.trim().toLowerCase();
    const items = (lists[page.tab] || []).filter((item) => {
      if (!q) return true;
      return (
        String(item.label || "").toLowerCase().includes(q) ||
        String(item.key || "").toLowerCase().includes(q) ||
        String(item.meaning || "").toLowerCase().includes(q)
      );
    });

    if (!items.length) {
      host.innerHTML = `<div class="empty"><strong>没有匹配「${esc(page.filter)}」的词缀</strong><span>换个关键词试试，比如 un、-able、spect</span></div>`;
      return;
    }

    host.innerHTML = items
      .map((item) => {
        const examples = (item.examples || []).slice(0, 4);
        return `
          <a class="affix-card" href="#/affix/${esc(page.tab)}/${encodeURIComponent(item.key)}">
            <span class="affix-card-head">
              <b>${esc(item.label)}</b>
              <span class="affix-count">${num(item.count)} 词</span>
            </span>
            <span class="affix-meaning">${esc(item.meaning || "")}</span>
            ${examples.length ? `<span class="affix-examples">${examples.map(esc).join(" · ")}</span>` : ""}
          </a>
        `;
      })
      .join("");
  }

  async function loadAffixWords(reset = false) {
    const page = state.affixPage;
    if (page.loading) return;
    page.loading = true;

    if (reset) {
      page.words = [];
      page.cursor = null;
      page.hasMore = true;
    }

    const params = new URLSearchParams();
    params.set("limit", "60");
    if (page.cursor) params.set("cursor", page.cursor);

    try {
      const payload = await api(
        `/affixes/${encodeURIComponent(page.type)}/${encodeURIComponent(page.key)}/words?${params}`,
      );
      page.affix = payload.data.affix;
      page.words = reset ? payload.data.words : page.words.concat(payload.data.words);
      page.total = payload.meta.total;
      page.cursor = payload.meta.nextCursor;
      page.hasMore = Boolean(payload.meta.nextCursor);
      page.loaded = true;
    } finally {
      page.loading = false;
    }
  }

  async function renderAffixWordsPage(type, key) {
    const view = $("#view");
    const page = state.affixPage;

    if (page.type !== type || page.key !== key) {
      page.type = type;
      page.key = key;
      page.affix = null;
      page.loaded = false;
    }

    if (!page.loaded) {
      view.innerHTML = '<div class="lookup"><div class="empty"><strong>正在加载词缀…</strong></div></div>';
      try {
        await loadAffixWords(true);
      } catch (error) {
        view.innerHTML = `
          <div class="lookup">
            <button class="lookup-back" type="button" data-action="affix-back">← 词缀目录</button>
            <div class="empty"><strong>没有找到「${esc(key)}」这个词缀</strong><span>${esc(error.message)}</span></div>
          </div>
        `;
        return;
      }
    }

    const affix = page.affix || { label: key, meaning: "" };
    view.innerHTML = `
      <div class="lookup">
        <button class="lookup-back" type="button" data-action="affix-back">← 词缀目录</button>

        <div class="page-head">
          <p class="eyebrow">${esc(AFFIX_TYPE_LABEL[type] || type)}</p>
          <h1>${esc(affix.label)} <span class="thin">· ${num(page.total)} 个词</span></h1>
          <p class="sub">${esc(affix.meaning || "这个词缀还没有释义")}</p>
        </div>

        <div id="affix-words"></div>
      </div>
    `;
    renderAffixWordList();
  }

  function renderAffixWordList() {
    const host = $("#affix-words");
    if (!host) return;
    const page = state.affixPage;
    host.innerHTML =
      renderWordList(page.words) +
      (page.hasMore
        ? `<button class="load-more" type="button" data-action="affix-load-more" ${page.loading ? "disabled" : ""}>${page.loading ? "加载中…" : "加载更多"}</button>`
        : "");
  }

  /* ---------------- 详情弹层 ---------------- */

  function openModal(html, options = {}) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal ${options.wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div></div>`;
    const backdrop = $(".modal-backdrop", root);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) closeModal();
    });
    return root;
  }

  function closeModal() {
    const root = $("#modal-root");
    if (root) root.innerHTML = "";
  }

  function modalShell(title, subtitle, bodyHtml, actionsHtml) {
    return `
      <div class="modal-head">
        <div>
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
        </div>
        <button class="modal-close" type="button" data-action="close-modal" title="关闭">${ICONS.close}</button>
      </div>
      ${bodyHtml}
      ${actionsHtml || ""}
    `;
  }

  async function openWordDetail(id) {
    let word = findWord(id);
    try {
      const payload = await api(`/words/${encodeURIComponent(id)}`);
      word = payload.data;
      replaceWord(word);
    } catch (error) {
      toast(error.message, "error");
      return;
    }

    const phonetic = (word.phoneticUs || word.phoneticUk || "").trim();
    const status = state.progress[word.id] || word.status || "new";

    let reviewInfo = null;
    try {
      const payload = await api(`/review/${encodeURIComponent(word.id)}`);
      reviewInfo = payload.data;
    } catch {
      reviewInfo = null;
    }

    openModal(modalShell(
      word.headword,
      phonetic || "暂无音标",
      `
        <button class="btn btn-quiet" type="button" data-action="modal-speak" data-word="${esc(word.headword)}" style="margin-bottom:10px">
          ${ICONS.speak} 朗读
        </button>
        <p class="detail-translation">${esc(word.translation || "暂无释义")}</p>
        ${word.note ? `<div class="detail-note">${esc(word.note)}</div>` : ""}
        <div class="detail-meta">
          <span class="tag">${esc(word.pos || "未标词性")}</span>
          <span class="tag">${word.source === "custom" ? "手动添加" : "词书"}</span>
          <span class="tag ${status === "known" ? "is-known" : status === "learning" ? "is-learning" : ""}">${statusLabel[status]}</span>
          ${word.starred ? '<span class="tag">已星标</span>' : ""}
        </div>
        <div style="margin-top:18px">
          <div class="seg" data-id="${esc(word.id)}">
            ${["new", "learning", "known"].map((value) => `
              <button type="button" data-action="set-status" data-status="${value}" class="${status === value ? "is-active" : ""}">${statusLabel[value]}</button>
            `).join("")}
          </div>
        </div>
        ${reviewInfo ? `
          <div class="detail-review">
            <span>${esc(reviewLabel(reviewInfo))}</span>
            ${reviewInfo.started ? `
              <button class="link-btn" type="button" data-action="reset-review" data-id="${esc(word.id)}" data-word="${esc(word.headword)}">重新开始学</button>
            ` : ""}
          </div>
        ` : ""}
      `,
      `
        <div class="modal-actions">
          <button class="btn btn-quiet btn-danger" type="button" data-action="delete-word" data-id="${esc(word.id)}">删除</button>
          <button class="btn btn-ghost" type="button" data-action="toggle-star" data-id="${esc(word.id)}" data-in-modal="1">
            ${word.starred ? "取消星标" : "加星"}
          </button>
          <button class="btn btn-ghost" type="button" data-action="open-notes" data-id="${esc(word.id)}" data-word="${esc(word.headword)}">
            笔记
          </button>
          <button class="btn btn-primary" type="button" data-action="close-modal">完成</button>
        </div>
      `,
    ));
  }

  /**
   * 词条弹层里的记忆曲线状态文案。
   * 数据来自 GET /review/:wordId，没建卡时 started 为 false。
   */
  function reviewLabel(info) {
    const card = info && info.review;
    if (!info || !info.started || !card) {
      return "还没进记忆曲线：在学习页标记「认识 / 不认识」时会自动建卡。";
    }

    const due = card.dueAt ? new Date(card.dueAt) : null;
    const diff = due ? due.getTime() - Date.now() : 0;
    let when;
    if (!due) when = "还没排期";
    else if (diff <= 0) when = "现在就该复习";
    else if (diff < 3600000) when = `${Math.max(1, Math.round(diff / 60000))} 分钟后复习`;
    else if (diff < 86400000) when = `${Math.round(diff / 3600000)} 小时后复习`;
    else when = `${Math.round(diff / 86400000)} 天后复习`;

    const stage = card.stage >= 5 ? "熟练" : card.stage >= 3 ? "巩固中" : "刚起步";
    const parts = [when, stage, `复习 ${card.reps} 次`];
    if (card.lapses > 0) parts.push(`忘了 ${card.lapses} 次`);
    return parts.join(" · ");
  }

  async function resetReviewCard(id, headword) {
    if (!window.confirm(`把「${headword}」移出记忆曲线，并标记为未学？`)) return;
    try {
      await api(`/review/reset/${encodeURIComponent(id)}`, { method: "POST" });
      toast("已重置，这个词会重新排队");
      state.review = null;
      state.daily = null;
      state.todayLoaded = false;
      state.bank.loaded = false;
      loadMeta();
      closeModal();
      if (parseView() === "bank") await renderBankPage();
      else if (parseView() === "today") await renderToday();
    } catch (error) {
      toast("重置失败：" + error.message, "error");
    }
  }

  function findWord(id) {
    if (state.daily && state.daily.words) {
      const found = state.daily.words.find((word) => word.id === id);
      if (found) return found;
    }
    return state.bank.items.find((word) => word.id === id) || null;
  }

  function replaceWord(word) {
    if (!word) return;
    if (state.daily && state.daily.words) {
      const index = state.daily.words.findIndex((item) => item.id === word.id);
      if (index >= 0) state.daily.words[index] = Object.assign({}, state.daily.words[index], word);
    }
    const bankIndex = state.bank.items.findIndex((item) => item.id === word.id);
    if (bankIndex >= 0) state.bank.items[bankIndex] = Object.assign({}, state.bank.items[bankIndex], word);
  }

  /* ---------------- 添加单词 ---------------- */

  function openAddWord() {
    openModal(modalShell(
      "添加单词",
      "会加入当前词书，重复的词会被拦下",
      `
        <form id="add-word-form">
          <div class="field">
            <label for="add-word">单词</label>
            <input id="add-word" name="word" required autocomplete="off" spellcheck="false" />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="add-pos">词性</label>
              <input id="add-pos" name="pos" placeholder="n. / v. / adj." autocomplete="off" />
            </div>
            <div class="field">
              <label for="add-phonetic">音标</label>
              <input id="add-phonetic" name="phoneticUs" placeholder="可选" autocomplete="off" />
            </div>
          </div>
          <div class="field">
            <label for="add-translation">释义</label>
            <textarea id="add-translation" name="translation" rows="2" placeholder="可选，稍后也能补"></textarea>
          </div>
          <div class="field">
            <label for="add-note">笔记</label>
            <input id="add-note" name="note" placeholder="可选" autocomplete="off" />
          </div>
        </form>
      `,
      `
        <div class="modal-actions">
          <button class="btn btn-quiet" type="button" data-action="close-modal">取消</button>
          <button class="btn btn-primary" type="button" data-action="submit-add">添加</button>
        </div>
      `,
    ));
    window.setTimeout(() => $("#add-word")?.focus(), 30);
  }

  async function submitAddWord() {
    const form = $("#add-word-form");
    if (!form) return;
    const data = Object.fromEntries(new FormData(form).entries());
    if (!String(data.word || "").trim()) {
      toast("先填单词", "error");
      return;
    }

    try {
      await api("/words", {
        method: "POST",
        body: {
          word: data.word.trim(),
          pos: data.pos || "",
          phoneticUs: data.phoneticUs || "",
          translation: data.translation || "",
          note: data.note || "",
        },
      });
      closeModal();
      toast("已添加");
      state.todayLoaded = false;
      loadMeta();
      if (parseView() === "bank") loadBank(true);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------------- 设置 ---------------- */

  function openSettings() {
    const settings = state.settings;
    openModal(modalShell(
      "设置",
      "所有数据都保存在这台电脑上",
      `
        <div class="settings-group">
          <h3>外观</h3>
          <div class="setting-row">
            <div><strong>背景壁纸</strong><small>在线壁纸，断网时自动显示纯色</small></div>
            <button class="switch ${settings.wallpaper ? "is-on" : ""}" type="button" data-action="toggle-wallpaper" aria-label="壁纸开关"></button>
          </div>
          <div class="setting-row">
            <div><strong>换一张</strong><small>从在线壁纸库重新取一张</small></div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost" type="button" data-action="next-wallpaper" ${settings.wallpaper ? "" : "disabled"}>换一张</button>
              <button class="btn btn-ghost" type="button" data-action="local-wallpaper" ${settings.wallpaper ? "" : "disabled"}>本地图片</button>
            </div>
          </div>
        </div>

        <div class="settings-group">
          <h3>朗读</h3>
          <div class="setting-row">
            <div><strong>语速</strong><small>${settings.rate.toFixed(1)}×，使用系统英文语音</small></div>
            <input class="range" type="range" min="0.6" max="1.3" step="0.1" value="${settings.rate}" data-action="rate" />
          </div>
        </div>

        <div class="settings-group">
          <h3>导入</h3>
          <label class="import-drop" for="import-file">
            <span>选择 txt 文件</span>
            <small>每行一个单词，支持「单词 释义」格式</small>
          </label>
          <input id="import-file" type="file" accept=".txt,text/plain" hidden />
          <div id="import-result"></div>
          <div id="import-history"></div>
        </div>

        <div class="settings-group">
          <h3>关于</h3>
          <div class="setting-row">
            <div><strong>EngPilot 1.0</strong><small>本地 CET-6 词库 · 数据保存在本机</small></div>
            <span class="tag" id="settings-word-count">${state.meta ? num(state.meta.counts.total) + " 词" : "—"}</span>
          </div>
        </div>
      `,
      `<div class="modal-actions"><button class="btn btn-primary" type="button" data-action="close-modal">关闭</button></div>`,
    ), { wide: true });

    $("#import-file").addEventListener("change", onImportFile);
    loadImportHistory();
  }

  async function loadImportHistory() {
    const host = $("#import-history");
    if (!host) return;
    host.innerHTML = '<p class="import-summary">正在读取导入记录…</p>';

    let imports = [];
    try {
      const payload = await api("/imports?limit=10");
      imports = payload.data.imports || [];
    } catch (error) {
      host.innerHTML = `<p class="import-summary">读取导入记录失败：${esc(error.message)}</p>`;
      return;
    }

    if (!imports.length) {
      host.innerHTML = '<p class="import-summary">还没有导入过文件。每次导入都会记在这里，导错了可以撤销。</p>';
      return;
    }

    host.innerHTML = `
      <div class="import-history">
        <div class="import-history-head">
          <span>最近导入</span>
          <span class="sub">撤销会删掉那次新增的词</span>
        </div>
        <ul class="import-history-list">
          ${imports.map((item) => `
            <li class="import-history-item">
              <div class="import-history-main">
                <b>${esc(item.filename || "未命名文件")}</b>
                <span class="sub">${esc(noteTime(item.createdAt))} · 新增 ${num(item.inserted)} · 补全 ${num(item.enriched)} · 重复 ${num(item.duplicated)}${item.invalid ? ` · 无效 ${num(item.invalid)}` : ""}</span>
              </div>
              ${item.inserted > 0
                ? `<button class="btn btn-ghost btn-compact" type="button" data-action="rollback-import" data-id="${esc(item.id)}" data-count="${item.inserted}">撤销</button>`
                : '<span class="sub">无新增</span>'}
            </li>
          `).join("")}
        </ul>
      </div>
    `;
  }

  async function rollbackImport(id, count) {
    const label = count > 0 ? `这次导入新增了 ${count} 个词` : "这次导入";
    if (!window.confirm(`撤销后会删除${count > 0 ? "这 " + count + " 个" : "这批"}词，确定？`)) return;
    try {
      const payload = await api(`/imports/${encodeURIComponent(id)}/rollback`, { method: "POST" });
      toast(`已撤销：删除 ${num(payload.data.deleted || 0)} 个词`);
      loadMeta();
      loadImportHistory();
    } catch (error) {
      toast("撤销失败：" + error.message, "error");
    }
  }

  async function onImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const host = $("#import-result");
    host.innerHTML = '<p class="import-summary">正在解析…</p>';

    try {
      const buffer = await file.arrayBuffer();
      const query = new URLSearchParams({ dryRun: "1", filename: file.name, mode: "merge" });
      const payload = await api(`/words/import?${query.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      });
      const data = payload.data;
      host.innerHTML = `
        <div class="import-summary">
          共 <b>${num(data.total)}</b> 个词：新增 <b>${num(data.new)}</b>，
          可补全 <b>${num(data.enrichable)}</b>，重复 <b>${num(data.duplicates)}</b>，
          无法解析 <b>${num(data.invalid)}</b>
          ${data.truncated ? "<br>文件过长，本次只解析了前面一部分" : ""}
        </div>
        ${data.preview && data.preview.length ? `
          <div class="import-preview">
            <table>
              <thead><tr><th>单词</th><th>释义</th><th>动作</th></tr></thead>
              <tbody>
                ${data.preview.map((row) => `
                  <tr>
                    <td>${esc(row.headword)}</td>
                    <td>${esc(row.translation || "—")}</td>
                    <td>${row.action === "insert" ? "新增" : row.action === "enrich" ? "补全" : "重复"}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        ` : ""}
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-action="cancel-import">取消</button>
          <button class="btn btn-primary" type="button" data-action="confirm-import" data-name="${esc(file.name)}" ${data.new + data.enrichable > 0 ? "" : "disabled"}>
            确认导入
          </button>
        </div>
      `;
      host.dataset.buffer = "";
      pendingImport = { buffer, filename: file.name };
    } catch (error) {
      host.innerHTML = `<p class="import-summary" style="color:var(--danger)">${esc(error.message)}</p>`;
    }
  }

  let pendingImport = null;

  async function confirmImport() {
    if (!pendingImport) return;
    const { buffer, filename } = pendingImport;
    try {
      const query = new URLSearchParams({ filename, mode: "merge" });
      const payload = await api(`/words/import?${query.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      });
      const data = payload.data;
      pendingImport = null;
      $("#import-result").innerHTML = `
        <p class="import-summary">导入完成：新增 <b>${num(data.inserted)}</b>，补全 <b>${num(data.enriched)}</b>，重复 <b>${num(data.duplicated)}</b>。</p>
      `;
      toast("导入完成");
      state.todayLoaded = false;
      state.bank.loaded = false;
      loadMeta();
      loadImportHistory();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------------- 全局事件 ---------------- */

  async function toggleStar(id) {
    const word = findWord(id);
    if (!word) return;
    const next = !word.starred;
    try {
      const payload = await api(`/words/${encodeURIComponent(id)}`, { method: "PATCH", body: { starred: next } });
      replaceWord(payload.data);
      loadMeta();
      if (parseView() === "today") await renderToday();
      else if (parseView() === "bank") {
        if (state.bank.starred && !next) {
          state.bank.items = state.bank.items.filter((item) => item.id !== id);
          state.bank.total = Math.max(0, state.bank.total - 1);
        }
        renderBankList();
      } else if (parseView() === "lookup") {
        await renderLookup(routeParts().param);
      }
      if ($("#modal-root").innerHTML) {
        if (id === (findWord(id) && findWord(id).id)) openWordDetail(id);
      }
      toast(next ? "已星标" : "已取消星标");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function setWordStatus(id, status) {
    try {
      const payload = await api(`/words/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
      replaceWord(payload.data);
      state.progress[id] = status;
      saveProgress();
      if (parseView() === "today") await renderToday();
      else if (parseView() === "bank") renderBankList();
      const active = $(".seg button.is-active");
      $$(".seg button").forEach((button) => button.classList.toggle("is-active", button.dataset.status === status));
      loadMeta();
      if (active) toast("状态已更新");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function deleteWord(id) {
    const word = findWord(id);
    if (!word) return;
    if (!window.confirm(`删除「${word.headword}」？这个操作不可撤销。`)) return;
    try {
      await api(`/words/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.bank.items = state.bank.items.filter((item) => item.id !== id);
      state.bank.total = Math.max(0, state.bank.total - 1);
      state.daily && state.daily.words && (state.daily.words = state.daily.words.filter((item) => item.id !== id));
      closeModal();
      if (parseView() === "bank") renderBankList();
      else if (parseView() === "today") await renderToday();
      loadMeta();
      toast("已删除");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /* ---------------- 全局搜索 ---------------- */

  let searchSeq = 0;

  function hideSearchPanel() {
    const panel = $("#search-panel");
    if (!panel) return;
    panel.hidden = true;
    panel.innerHTML = "";
  }

  function closeSearch() {
    hideSearchPanel();
    const input = $("#global-search");
    if (input) input.value = "";
  }

  function goLookup(word) {
    const value = String(word || "").trim();
    if (!value) return;
    closeSearch();
    location.hash = "#/lookup/" + encodeURIComponent(value);
  }

  function searchItem(attrs, title, sub, note) {
    return `<button class="search-item" type="button" ${attrs}>
      <b>${esc(title)}</b><span>${esc(sub || "")}</span><em>${esc(note || "")}</em>
    </button>`;
  }

  function renderSearchPanel(data) {
    const panel = $("#search-panel");
    if (!panel) return;
    const results = (data && data.results) || {};
    const book = results.book || [];
    const dict = results.dict || [];
    const affix = results.affix || [];
    const notes = results.notes || [];
    const empty = !(book.length || dict.length || affix.length || notes.length);
    const q = (data && data.q) || "";

    if (empty) {
      panel.innerHTML = `
        <div class="search-empty">没有找到「${esc(q)}」</div>
        <div class="search-footer">回车查看完整查词结果</div>
      `;
      panel.hidden = false;
      return;
    }

    let html = "";
    if (book.length) {
      html += `<div class="search-group"><h4>我的词书</h4>${book
        .map((word) =>
          searchItem(
            `data-action="search-book" data-word="${esc(word.headword)}"`,
            word.headword,
            word.translation,
            statusLabel[word.status] || "词书",
          ),
        )
        .join("")}</div>`;
    }
    if (dict.length) {
      html += `<div class="search-group"><h4>词典</h4>${dict
        .map((row) => searchItem(`data-action="search-dict" data-word="${esc(row.word)}"`, row.word, row.translation, "词典"))
        .join("")}</div>`;
    }
    if (affix.length) {
      html += `<div class="search-group"><h4>词缀</h4>${affix
        .map((item) =>
          searchItem(
            `data-action="search-affix" data-type="${esc(item.type)}" data-key="${esc(item.key)}" data-label="${esc(item.label)}" data-meaning="${esc(item.meaning || "")}"`,
            item.label,
            item.meaning,
            `${item.count} 词`,
          ),
        )
        .join("")}</div>`;
    }
    if (notes.length) {
      html += `<div class="search-group"><h4>笔记</h4>${notes
        .map((note) => searchItem(`data-action="search-note" data-word="${esc(note.headword)}"`, note.headword || "笔记", note.content, "笔记"))
        .join("")}</div>`;
    }
    html += `<div class="search-footer">回车查看「${esc(q)}」的完整释义</div>`;

    panel.innerHTML = html;
    panel.hidden = false;
  }

  async function runSearch(raw) {
    const q = String(raw || "").trim();
    const panel = $("#search-panel");
    if (!panel) return;
    const seq = ++searchSeq;
    if (!q) {
      hideSearchPanel();
      return;
    }
    panel.hidden = false;
    panel.innerHTML = '<div class="search-empty">搜索中…</div>';
    try {
      const payload = await api(`/search?q=${encodeURIComponent(q)}&limit=5`);
      if (seq !== searchSeq) return;
      renderSearchPanel(payload.data);
    } catch (error) {
      if (seq !== searchSeq) return;
      panel.innerHTML = `<div class="search-empty">${esc(error.message)}</div>`;
    }
  }

  function moveSearchActive(delta) {
    const items = $$(".search-item");
    if (!items.length) return;
    const current = items.findIndex((item) => item.classList.contains("is-active"));
    let next = current + delta;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items.forEach((item, index) => item.classList.toggle("is-active", index === next));
    items[next].scrollIntoView({ block: "nearest" });
  }

  function submitSearch(raw) {
    const q = String(raw || "").trim();
    if (!q) return;
    const active = $(".search-item.is-active");
    if (active && active.dataset.action === "search-affix") {
      toast(`${active.dataset.label} · ${active.dataset.meaning || ""}（${active.querySelector("em").textContent}）`);
      return;
    }
    if (active && active.dataset.word) {
      goLookup(active.dataset.word);
      return;
    }
    goLookup(q);
  }

  function bindSearch() {
    const input = $("#global-search");
    if (!input) return;

    input.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => runSearch(input.value), 180);
    });
    input.addEventListener("focus", () => {
      if (input.value.trim()) runSearch(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSearchActive(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSearchActive(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        submitSearch(input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
        input.blur();
      }
    });

    document.addEventListener("pointerdown", (event) => {
      const panel = $("#search-panel");
      if (!panel || panel.hidden) return;
      if (event.target.closest(".nav-search")) return;
      hideSearchPanel();
    });

    document.addEventListener("submit", (event) => {
      if (event.target.id === "home-search-form") {
        event.preventDefault();
        goLookup($("#home-search")?.value);
      } else if (event.target.id === "lookup-form") {
        event.preventDefault();
        goLookup($("#lookup-input")?.value);
      } else if (event.target.id === "note-form") {
        event.preventDefault();
        saveNote();
      }
    });
  }

  function bindEvents() {
    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;

      if (action === "close-modal") {
        // 只有点背景空白或关闭按钮才关闭；弹层内部（输入框、普通文字）不关
        const insideModal = event.target.closest(".modal");
        const isCloseButton = event.target.closest(".modal-close");
        if (!insideModal || isCloseButton) closeModal();
        return;
      }
      if (action === "go") {
        const href = target.dataset.href || "#/home";
        if (href === "#/bank") {
          state.bank.starred = target.dataset.starred === "1";
          state.bank.status = "";
          state.bank.loaded = false;
          $("#btn-starred")?.classList.toggle("is-on", state.bank.starred);
        }
        location.hash = href;
        return;
      }
      if (action === "lookup-back") {
        location.hash = "#/home";
        return;
      }
      if (action === "lookup-goto") {
        const value = String(target.dataset.word || "").trim();
        if (value) location.hash = "#/lookup/" + encodeURIComponent(value);
        return;
      }
      if (action === "lookup-speak") {
        speak(target.dataset.word);
        return;
      }
      if (action === "lookup-star") {
        const id = target.dataset.id;
        const next = target.dataset.starred !== "true";
        try {
          await api(`/words/${encodeURIComponent(id)}`, { method: "PATCH", body: { starred: next } });
          toast(next ? "已星标" : "已取消星标");
          loadMeta();
          await renderLookup(routeParts().param);
        } catch (error) {
          toast(error.message, "error");
        }
        return;
      }
      if (action === "search-book" || action === "search-dict") {
        goLookup(target.dataset.word);
        return;
      }
      if (action === "search-note") {
        state.pendingNotes = target.dataset.word;
        goLookup(target.dataset.word);
        return;
      }
      if (action === "search-affix") {
        const type = target.dataset.type;
        const key = target.dataset.key;
        if (type && key) {
          hideSearchPanel();
          location.hash = `#/affix/${type}/${encodeURIComponent(key)}`;
        } else {
          toast(`${target.dataset.label} · ${target.dataset.meaning || ""}`);
        }
        return;
      }
      if (action === "start-study") {
        await loadDaily();
        startStudy();
        return;
      }
      if (action === "open-word") {
        event.preventDefault();
        if (state.bank.selecting) {
          const wordId = target.dataset.id;
          if (state.bank.selected.has(wordId)) state.bank.selected.delete(wordId);
          else state.bank.selected.add(wordId);
          renderBankPage();
          return;
        }
        openWordDetail(target.dataset.id);
        return;
      }
      if (action === "toggle-star") {
        event.preventDefault();
        event.stopPropagation();
        toggleStar(target.dataset.id);
        return;
      }
      if (action === "load-more") {
        loadBank(false);
        return;
      }
      if (action === "bank-chip") {
        const chip = target.dataset.chip;
        state.bank.status = chip === "starred" ? "" : chip;
        state.bank.starred = chip === "starred";
        state.bank.loaded = false;
        $("#btn-starred")?.classList.toggle("is-on", state.bank.starred);
        await renderBankPage();
        return;
      }
      if (action === "reveal") {
        if (target.classList.contains("study-card") && state.study && !state.study.revealed) {
          state.study.revealed = true;
          renderStudyPage();
        }
        return;
      }
      if (action === "mark") {
        markStudy(target.dataset.status);
        return;
      }
      if (action === "speak") {
        event.stopPropagation();
        const word = state.study && state.study.words[state.study.index];
        if (word) speak(word.headword);
        return;
      }
      if (action === "exit-study") {
        state.study = null;
        location.hash = "#/today";
        return;
      }
      if (action === "restart-study") {
        state.study = null;
        startStudy();
        return;
      }
      if (action === "review-reveal") {
        if (target.classList.contains("study-card") && state.review && !state.review.revealed) {
          state.review.revealed = true;
          renderReviewCard();
        }
        return;
      }
      if (action === "review-rate") {
        if (state.review && state.review.revealed) rateReview(target.dataset.rating);
        return;
      }
      if (action === "review-speak") {
        event.stopPropagation();
        const card = state.review && state.review.words[state.review.index];
        if (card) speak(card.headword);
        return;
      }
      if (action === "exit-review") {
        state.review = null;
        location.hash = "#/today";
        return;
      }
      if (action === "restart-review") {
        restartReview();
        return;
      }
      if (action === "start-review") {
        state.review = null;
        location.hash = "#/review";
        return;
      }
      if (action === "open-notes") {
        openNotesPanel({
          wordId: target.dataset.id || "",
          headword: target.dataset.word || "",
        });
        return;
      }
      if (action === "note-edit") {
        startEditNote(target.dataset.id);
        return;
      }
      if (action === "note-save-edit") {
        saveEditNote(target.dataset.id);
        return;
      }
      if (action === "note-cancel-edit") {
        state.noteEditId = null;
        refreshNotesPanel();
        return;
      }
      if (action === "note-delete") {
        removeNote(target.dataset.id);
        return;
      }
      if (action === "notes-load-more") {
        loadNotesPage(false);
        return;
      }
      if (action === "notes-search") {
        state.notesPage.loaded = false;
        state.notesPage.q = target.dataset.q || "";
        loadNotesPage(true);
        return;
      }
      if (action === "rollback-import") {
        rollbackImport(target.dataset.id, Number(target.dataset.count || 0));
        return;
      }
      if (action === "enter-select") {
        state.bank.selecting = true;
        state.bank.selected = new Set();
        renderBankPage();
        return;
      }
      if (action === "exit-select") {
        state.bank.selecting = false;
        state.bank.selected = new Set();
        renderBankPage();
        return;
      }
      if (action === "select-word") {
        const wordId = target.dataset.id;
        if (state.bank.selected.has(wordId)) state.bank.selected.delete(wordId);
        else state.bank.selected.add(wordId);
        renderBankPage();
        return;
      }
      if (action === "select-all") {
        state.bank.items.forEach((word) => state.bank.selected.add(word.id));
        renderBankPage();
        return;
      }
      if (action === "select-none") {
        state.bank.selected.clear();
        renderBankPage();
        return;
      }
      if (action === "batch-star") {
        batchStarWords([...state.bank.selected], target.dataset.starred === "1");
        return;
      }
      if (action === "batch-delete") {
        batchDeleteSelected();
        return;
      }
      if (action === "reset-review") {
        resetReviewCard(target.dataset.id, target.dataset.word || "");
        return;
      }
      if (action === "affix-tab") {
        state.affixPage.tab = target.dataset.type || "prefix";
        renderAffix("");
        return;
      }
      if (action === "affix-back") {
        location.hash = "#/affix";
        return;
      }
      if (action === "affix-load-more") {
        loadAffixWords(false)
          .then(renderAffixWordList)
          .catch((error) => toast(error.message, "error"));
        return;
      }
      if (action === "submit-add") {
        submitAddWord();
        return;
      }
      if (action === "set-status") {
        const id = target.closest(".seg")?.dataset.id;
        if (id) setWordStatus(id, target.dataset.status);
        return;
      }
      if (action === "delete-word") {
        deleteWord(target.dataset.id);
        return;
      }
      if (action === "modal-speak") {
        speak(target.dataset.word);
        return;
      }
      if (action === "toggle-wallpaper") {
        state.settings.wallpaper = !state.settings.wallpaper;
        saveSettings();
        applyWallpaper();
        target.classList.toggle("is-on", state.settings.wallpaper);
        $$("[data-action='next-wallpaper'],[data-action='local-wallpaper']").forEach((button) => {
          button.disabled = !state.settings.wallpaper;
        });
        return;
      }
      if (action === "next-wallpaper") {
        nextWallpaper();
        return;
      }
      if (action === "local-wallpaper") {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addEventListener("change", () => pickLocalWallpaper(input.files[0]));
        input.click();
        return;
      }
      if (action === "cancel-import") {
        pendingImport = null;
        $("#import-result").innerHTML = "";
        return;
      }
      if (action === "confirm-import") {
        confirmImport();
        return;
      }
    });

    document.addEventListener("input", (event) => {
      const target = event.target;
      if (target.id === "bank-search") {
        state.bank.q = target.value.trim();
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(async () => {
          state.bank.loaded = false;
          await loadBank(true);
        }, 260);
      }
      if (target.id === "notes-search") {
        const value = target.value.trim();
        window.clearTimeout(notesTimer);
        notesTimer = window.setTimeout(() => {
          state.notesPage.q = value;
          loadNotesPage(true);
        }, 240);
      }
      if (target.id === "affix-filter") {
        const value = target.value;
        window.clearTimeout(affixTimer);
        affixTimer = window.setTimeout(() => {
          state.affixPage.filter = value;
          renderAffixGrid();
        }, 160);
      }
      if (target.dataset.action === "rate") {
        state.settings.rate = Number(target.value);
        saveSettings();
        const label = target.closest(".setting-row")?.querySelector("small");
        if (label) label.textContent = `${state.settings.rate.toFixed(1)}×，使用系统英文语音`;
      }
    });

    document.addEventListener("change", (event) => {
      if (event.target.id === "bank-sort") {
        state.bank.sort = event.target.value;
        state.bank.loaded = false;
        loadBank(true);
      }
    });

    document.addEventListener("keydown", (event) => {
      const tag = (event.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select";

      if (event.key === "Escape") {
        closeSearch();
        closeModal();
        return;
      }
      if (typing) return;

      if (event.key === "/") {
        event.preventDefault();
        $("#global-search")?.focus();
        return;
      }

      const view = parseView();

      if (view === "review") {
        if (event.key === " ") {
          event.preventDefault();
          if (state.review && !state.review.revealed) {
            state.review.revealed = true;
            renderReviewCard();
          }
          return;
        }
        const rateIndex = ["1", "2", "3", "4"].indexOf(event.key);
        if (rateIndex >= 0) {
          event.preventDefault();
          if (state.review && state.review.revealed) rateReview(RATING_OPTIONS[rateIndex].key);
          return;
        }
        return;
      }

      const onStudy = view === "study";
      if (!onStudy) return;

      if (event.key === " ") {
        event.preventDefault();
        if (state.study && !state.study.revealed) {
          state.study.revealed = true;
          renderStudyPage();
        }
        return;
      }
      if (event.key === "1") {
        event.preventDefault();
        markStudy("learning");
        return;
      }
      if (event.key === "2" || event.key === "Enter") {
        event.preventDefault();
        markStudy("known");
      }
    });

    $("#btn-starred").addEventListener("click", async () => {
      state.bank.starred = !state.bank.starred;
      state.bank.status = "";
      state.bank.loaded = false;
      $("#btn-starred").classList.toggle("is-on", state.bank.starred);
      if (parseView() !== "bank") location.hash = "#/bank";
      else await renderBankPage();
    });

    $("#btn-add").addEventListener("click", openAddWord);
    $("#btn-settings").addEventListener("click", openSettings);
    $("#book-select").addEventListener("change", (event) => switchBook(event.target.value));

    bindSearch();
    window.addEventListener("hashchange", router);
  }

  let searchTimer = 0;
  let notesTimer = 0;
  let affixTimer = 0;

  /* ---------------- 启动 ---------------- */

  async function boot() {
    applyWallpaper();
    bindEvents();
    if (location.hash === "" || location.hash === "#/" || location.hash === "#") location.hash = "#/home";
    await loadMeta();
    await loadBooks();
    await router();
  }

  boot().catch((error) => {
    console.error(error);
    toast(error.message || "启动失败", "error");
  });
})();