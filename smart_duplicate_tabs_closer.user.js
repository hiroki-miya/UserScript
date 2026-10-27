// ==UserScript==
// @name         Smart Duplicate Tabs Closer
// @namespace    local.smart-duplicate-tabs
// @version      2.0.0
// @description  Close newly opened duplicate tabs; compact site/page rules and a settings dialog.
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        window.close
// @grant        window.onurlchange
// ==/UserScript==

(() => {
  'use strict';

  const STORE = 'sdtc.settings.v2';
  const TAB_FIELD = '__smartDuplicateTabsV2';
  const OLD_TAB_FIELD = '__smartDuplicateTabsV1';
  const NEW_TAB_WINDOW_MS = 4500;
  const CHECK_DELAYS_MS = [0, 180, 900];

  const MODES = [
    ['exact', 'URL完全一致'],
    ['noQuery', 'クエリ除外'],
    ['noHash', 'ハッシュ除外'],
    ['path', 'クエリ・ハッシュ除外'],
    ['urlAndTitle', 'URL and タイトル'],
    ['urlOrTitle', 'URL or タイトル'],
    ['title', 'タイトル一致'],
    ['origin', 'ドメイン一致'],
    ['normalized', 'URL正規化']
  ];
  const ACTIONS = [
    ['close', '自動クローズ'],
    ['detect', '検知のみ'],
    ['ignore', '完全除外']
  ];
  const MODE_VALUES = new Set(MODES.map(([id]) => id));
  const ACTION_VALUES = new Set(ACTIONS.map(([id]) => id));
  const COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

  // URL正規化モードの動作（必要ならここを編集）
  const NORMALIZE = {
    ignoreHash: false,
    ignoreQuery: false,
    ignoreWww: false,
    ignoreTrailingSlash: false,
    lowercasePath: false,
    sortQuery: true,
    ignoreParams: ['utm_*', 'gclid', 'fbclid', 'msclkid'],
    keepParams: null
  };

  const PROTECTED_DEFAULTS = [
    '*://outlook.office.com/*',
    '*://outlook.office365.com/*',
    '*://outlook.live.com/*',
    '*://outlook.cloud.microsoft/*',
    '*://teams.microsoft.com/*',
    '*://*.teams.microsoft.com/*',
    '*://teams.cloud.microsoft/*',
    '*://*.teams.cloud.microsoft/*',
    '*://teams.live.com/*',
    '*://teams.microsoft365.com/*'
  ];

  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

  function defaultSettings() {
    return {
      version: 2,
      autoClose: true,
      defaultMode: 'exact',
      rules: PROTECTED_DEFAULTS.map(pattern => ({
        id: newId(), pattern, mode: 'inherit', action: 'detect'
      }))
    };
  }

  function sortKey(pattern) {
    return String(pattern || '')
      .trim()
      .replace(/^(?:https?|\*):\/\//i, '')
      .replace(/^www\./i, '')
      .toLowerCase();
  }

  // 表示順はドメイン→パスの文字列順。判定優先順位とは独立している。
  function sortRules(rules) {
    return rules.slice().sort((a, b) => {
      if (!a.pattern.trim()) return b.pattern.trim() ? 1 : 0;
      if (!b.pattern.trim()) return -1;
      return COLLATOR.compare(sortKey(a.pattern), sortKey(b.pattern)) ||
        COLLATOR.compare(a.pattern, b.pattern) ||
        COLLATOR.compare(a.id, b.id);
    });
  }

  function sanitizeSettings(raw) {
    if (!raw || typeof raw !== 'object') return defaultSettings();
    const seen = new Set();
    const rules = [];
    for (const candidate of Array.isArray(raw.rules) ? raw.rules : []) {
      if (!candidate || typeof candidate !== 'object') continue;
      let id = typeof candidate.id === 'string' ? candidate.id : newId();
      if (seen.has(id)) id = newId();
      seen.add(id);
      rules.push({
        id,
        pattern: typeof candidate.pattern === 'string' ? candidate.pattern : '',
        mode: candidate.mode === 'inherit' || MODE_VALUES.has(candidate.mode)
          ? candidate.mode : 'inherit',
        action: ACTION_VALUES.has(candidate.action) ? candidate.action : 'close'
      });
    }
    return {
      version: 2,
      autoClose: typeof raw.autoClose === 'boolean' ? raw.autoClose : true,
      defaultMode: MODE_VALUES.has(raw.defaultMode) ? raw.defaultMode : 'exact',
      rules: sortRules(rules)
    };
  }

  function migrateOldSettings() {
    const next = defaultSettings();
    next.autoClose = GM_getValue('autoClose', true) !== false;
    const globalMode = GM_getValue('globalMode', 'exact');
    if (MODE_VALUES.has(globalMode)) next.defaultMode = globalMode;

    function put(pattern, mode, action) {
      if (typeof pattern !== 'string' || !pattern.trim()) return;
      const existing = next.rules.find(r => r.pattern === pattern);
      if (existing) {
        if (mode !== 'inherit') existing.mode = mode;
        if (action === 'detect') existing.action = 'detect';
      } else {
        next.rules.push({ id: newId(), pattern, mode, action });
      }
    }

    const oldSiteModes = GM_getValue('siteModes', {});
    if (oldSiteModes && typeof oldSiteModes === 'object') {
      for (const [origin, mode] of Object.entries(oldSiteModes)) {
        if (!MODE_VALUES.has(mode)) continue;
        try {
          const parsed = new URL(origin);
          put(parsed.origin + '/*', mode, 'close');
        } catch { /* 古い不正な設定をスキップ */ }
      }
    }
    const oldProtected = GM_getValue('protectedURLs', []);
    if (Array.isArray(oldProtected)) {
      for (const pattern of oldProtected) put(pattern, 'inherit', 'detect');
    }
    return sanitizeSettings(next);
  }

  function readSettings() {
    const value = GM_getValue(STORE, null);
    if (value && value.version === 2) return sanitizeSettings(value);
    const migrated = migrateOldSettings();
    GM_setValue(STORE, migrated);
    return migrated;
  }

  function saveSettings(settings) {
    settings.rules = sortRules(settings.rules);
    GM_setValue(STORE, sanitizeSettings(settings));
  }

  function validPattern(pattern) {
    // ドメインまで入力されていない途中状態は適用しない。
    if (typeof pattern !== 'string') return false;
    const m = /^(?:https?|\*):\/\/([^\s/?#]+)(?:\/[^\s]*)?$/i.exec(pattern.trim());
    return !!m && m[1] !== '*';
  }

  function patternMatches(pattern, url) {
    if (!validPattern(pattern)) return false;
    let pat = pattern.trim();
    if (/^(?:https?|\*):\/\/[^/]+$/i.test(pat)) pat += '/*';
    const escaped = pat.split('*').map(part =>
      part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('.*');
    try { return new RegExp('^' + escaped + '$', 'i').test(url); }
    catch { return false; }
  }

  // より具体的なページ/パスが、サイト全体のルールに勝つ。
  function specificity(pattern) {
    const bare = String(pattern).replace(/^(?:https?|\*):\/\//i, '');
    const slash = bare.indexOf('/');
    const path = slash >= 0 ? bare.slice(slash + 1) : '';
    const literalPath = path.replace(/\*/g, '').length;
    const literalTotal = bare.replace(/\*/g, '').length;
    const wildcardCount = (bare.match(/\*/g) || []).length;
    return (literalPath > 0 ? 100000 : 0) + literalPath * 1000 +
      literalTotal * 10 - wildcardCount * 5 +
      (pattern.startsWith('*://') ? 0 : 2);
  }

  function policyFor(url, settings) {
    let best = null;
    let score = -Infinity;
    for (const rule of settings.rules) {
      if (!patternMatches(rule.pattern, url)) continue;
      const candidate = specificity(rule.pattern);
      if (candidate > score || (candidate === score && best &&
          COLLATOR.compare(rule.pattern, best.pattern) < 0)) {
        best = rule;
        score = candidate;
      }
    }
    return {
      action: best ? best.action : 'close',
      mode: best && best.mode !== 'inherit' ? best.mode : settings.defaultMode
    };
  }

  function matchParam(pattern, key) {
    const rx = '^' + String(pattern).split('*').map(part =>
      part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('.*') + '$';
    return new RegExp(rx, 'i').test(key);
  }

  function normalizedURL(input) {
    const u = new URL(input);
    if (NORMALIZE.ignoreWww) u.hostname = u.hostname.replace(/^www\./i, '');
    if (NORMALIZE.ignoreHash) u.hash = '';
    if (NORMALIZE.ignoreTrailingSlash && u.pathname !== '/') {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    if (NORMALIZE.lowercasePath) u.pathname = u.pathname.toLowerCase();
    if (NORMALIZE.ignoreQuery) {
      u.search = '';
    } else {
      const pairs = [...u.searchParams.entries()].filter(([name]) => {
        if (Array.isArray(NORMALIZE.keepParams)) {
          return NORMALIZE.keepParams.some(p => matchParam(p, name));
        }
        return !NORMALIZE.ignoreParams.some(p => matchParam(p, name));
      });
      if (NORMALIZE.sortQuery) {
        pairs.sort((a, b) => COLLATOR.compare(a[0], b[0]) || COLLATOR.compare(a[1], b[1]));
      }
      const params = new URLSearchParams();
      for (const [name, value] of pairs) params.append(name, value);
      u.search = params.toString();
    }
    return u.href;
  }

  function urlKey(url, mode) {
    if (mode === 'exact') return url;
    const u = new URL(url);
    switch (mode) {
      case 'noQuery': u.search = ''; return u.href;
      case 'noHash': u.hash = ''; return u.href;
      case 'path': return u.origin + u.pathname;
      case 'origin': return u.origin;
      case 'normalized': return normalizedURL(url);
      default: return url;
    }
  }

  function duplicate(a, b, mode) {
    if (!a.url || !b.url || a.id === b.id) return false;
    const bothTitles = !!(a.title && b.title && a.title === b.title);
    const sameOrigin = new URL(a.url).origin === new URL(b.url).origin;
    const titlesMatch = bothTitles && sameOrigin;
    const urlsMatch = urlKey(a.url, 'exact') === urlKey(b.url, 'exact');
    switch (mode) {
      case 'title': return titlesMatch;
      case 'urlAndTitle': return urlsMatch && bothTitles;
      case 'urlOrTitle': return urlsMatch || titlesMatch;
      default: return urlKey(a.url, mode) === urlKey(b.url, mode);
    }
  }

  function older(a, b) {
    return a.createdAt !== b.createdAt
      ? a.createdAt < b.createdAt : String(a.id) < String(b.id);
  }

  const gmGetTab = () => new Promise(resolve => GM_getTab(resolve));
  const gmSaveTab = tab => new Promise(resolve => GM_saveTab(tab, resolve));
  const gmGetTabs = () => new Promise(resolve => GM_getTabs(resolve));

  // ---------------------------- 設定画面 ----------------------------
  let modalHost = null;
  function openSettings() {
    if (modalHost) return;
    const state = readSettings();
    const host = document.createElement('div');
    host.id = 'sdtc-settings-host';
    host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { color-scheme: dark; font: 13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
        * { box-sizing: border-box; }
        .backdrop { position:fixed;inset:0;background:rgba(0,0,0,.66);display:flex;
          align-items:center;justify-content:center;padding:16px; }
        .panel { --bg:#181818;--line:#343434;--text:#f3f3f3;--muted:#a6a6a6;
          --field:#222;--fieldline:#454545;background:var(--bg);color:var(--text);
          border:1px solid var(--line);border-radius:16px;width:min(900px,100%);
          max-height:92vh;overflow:auto;box-shadow:0 16px 60px #0009;padding:18px 20px; }
        .header { display:flex;justify-content:space-between;align-items:center;gap:12px;
          margin-bottom:10px; }
        .heading { font-weight:700;font-size:15px;letter-spacing:.1px; }
        .close { font-size:20px;line-height:1;background:none;border:0;color:var(--muted);
          cursor:pointer;padding:4px 8px; }
        .global-row { display:flex;align-items:center;justify-content:space-between;min-height:53px;
          gap:16px;font-weight:600; }
        .global-row + .global-row { border-top:1px solid #ffffff09; }
        select,input[type=text] { font:inherit;color:var(--text);background:var(--field);
          border:1px solid var(--fieldline);border-radius:8px;outline:none;min-height:32px; }
        select:focus,input[type=text]:focus { border-color:#8eabed; }
        select { padding:5px 26px 5px 10px; cursor:pointer;width:100%; }
        .global-row select { width:min(315px,50vw); }
        .toggle { appearance:none;width:21px;height:21px;border:2px solid #888;border-radius:50%;
          background:transparent;cursor:pointer;position:relative;flex:none;margin:0 2px 0 0; }
        .toggle:checked { background:#f6f6f6;border-color:#f6f6f6; }
        .toggle:checked:after { content:'✓';position:absolute;top:-4px;left:3px;color:#161616;
          font-size:18px;font-weight:700; }
        .divider { border-top:1px solid var(--line);margin:13px 0 15px; }
        .rules-title { display:flex;align-items:center;justify-content:space-between;
          gap:10px;margin-bottom:9px; }
        .rules-title strong { font-size:13px; }
        button { font:inherit; }
        .add { background:transparent;border:1px solid var(--fieldline);color:var(--text);
          padding:5px 11px;border-radius:8px;cursor:pointer;white-space:nowrap; }
        .add:hover,.close:hover,.remove:hover { background:#4444; }
        .scroll { overflow:auto;max-height:50vh; }
        .rule-grid { min-width:610px;display:grid;grid-template-columns:minmax(225px,1fr)
          164px 124px 28px;gap:7px;align-items:center; }
        .column-head { color:var(--muted);font-size:11px;margin-bottom:5px; }
        #ruleRows { display:flex;flex-direction:column; }
        .rule-row { margin-bottom:5px; }
        .url { width:100%;padding:5px 8px; }
        .invalid { border-color:#e66!important; }
        .remove { color:var(--muted);background:none;border:0;border-radius:6px;
          cursor:pointer;font-size:19px;line-height:27px;width:28px;height:30px; }
        .note { color:var(--muted);font-size:11px;margin-top:9px; }
        .help { color:#ffb0b0;font-size:11px;margin-top:5px; }
        @media(prefers-color-scheme:light) {
          :host { color-scheme: light; }
          .panel { --bg:#fff;--line:#e4e4e4;--text:#171717;--muted:#666;
            --field:#fafafa;--fieldline:#ccc;box-shadow:0 16px 60px #0004; }
          .global-row + .global-row { border-top-color:#00000009; }
          .toggle:checked { background:#202020;border-color:#202020; }
          .toggle:checked:after { color:white; }
        }
      </style>
      <div class="backdrop" id="backdrop">
        <section class="panel" role="dialog" aria-modal="true" aria-label="Smart Duplicate Tabs Closer 設定">
          <div class="header"><div class="heading">⚙ Smart Duplicate Tabs Closer</div>
            <button class="close" id="close" type="button" title="閉じる" aria-label="閉じる">×</button></div>
          <div class="global-row"><label for="autoClose">自動クローズ</label>
            <input type="checkbox" class="toggle" id="autoClose" aria-label="自動クローズ"></div>
          <div class="global-row"><label for="defaultMode">標準の比較方法</label>
            <select id="defaultMode" aria-label="標準の比較方法"></select></div>
          <div class="divider"></div>
          <div class="rules-title"><strong>サイト・ページ別ルール</strong>
            <button type="button" class="add" id="add">＋ 追加</button></div>
          <div class="scroll">
            <div class="rule-grid column-head"><span>URLパターン</span><span>比較方法</span>
              <span>重複時の動作</span><span></span></div>
            <div id="ruleRows"></div>
          </div>
          <div id="validation" class="help" aria-live="polite"></div>
          <div class="note">変更は自動保存。URLパターンは入力確定時にドメイン・パス順で自動整列します。</div>
        </section>
      </div>`;

    const $ = id => shadow.getElementById(id);
    const option = (id, label) => {
      const el = document.createElement('option');
      el.value = id;
      el.textContent = label;
      return el;
    };
    const commit = () => saveSettings(state);

    function close() {
      if (!modalHost) return;
      // URL入力欄からフォーカスを移さずに閉じても編集内容を失わない。
      commit();
      window.removeEventListener('keydown', keyHandler, true);
      modalHost.remove();
      modalHost = null;
    }
    function keyHandler(event) { if (event.key === 'Escape') close(); }
    $('close').addEventListener('click', close);
    $('backdrop').addEventListener('click', event => {
      if (event.target === $('backdrop')) close();
    });
    window.addEventListener('keydown', keyHandler, true);

    const enabled = $('autoClose');
    enabled.checked = state.autoClose;
    enabled.addEventListener('change', () => {
      state.autoClose = enabled.checked;
      commit();
    });

    const defaultMode = $('defaultMode');
    MODES.forEach(([id, label]) => defaultMode.append(option(id, label)));
    defaultMode.value = state.defaultMode;
    defaultMode.addEventListener('change', () => {
      state.defaultMode = defaultMode.value;
      commit();
    });

    function showValidation() {
      const count = state.rules.filter(rule =>
        rule.pattern.trim() && !validPattern(rule.pattern)).length;
      $('validation').textContent = count
        ? `${count} 件のURLパターンは未完成または不正のため判定に使いません。` : '';
    }

    // 既存の入力欄を再生成せずCSSの表示順だけ変更する。
    // 別のプルダウンをクリックした瞬間に操作対象が消える問題を防ぐ。
    function reorderRowsInPlace() {
      state.rules = sortRules(state.rules);
      const nodes = new Map(Array.from($('ruleRows').children,
        node => [node.dataset.ruleId, node]));
      state.rules.forEach((rule, index) => {
        const node = nodes.get(rule.id);
        if (node) node.style.order = String(index);
      });
    }

    function renderRows(focusId = null) {
      state.rules = sortRules(state.rules);
      const holder = $('ruleRows');
      holder.replaceChildren();
      for (const rule of state.rules) {
        const row = document.createElement('div');
        row.className = 'rule-grid rule-row';
        row.dataset.ruleId = rule.id;

        const url = document.createElement('input');
        url.type = 'text';
        url.className = 'url';
        url.placeholder = '*://example.com/*';
        url.value = rule.pattern;
        url.title = '例: *://example.com/* または https://example.com/page';
        url.setAttribute('aria-label', 'URLパターン');
        if (rule.pattern && !validPattern(rule.pattern)) {
          url.classList.add('invalid');
        }
        url.addEventListener('input', () => {
          rule.pattern = url.value;
          url.classList.toggle('invalid', !!rule.pattern && !validPattern(rule.pattern));
          showValidation();
        });
        url.addEventListener('blur', () => {
          rule.pattern = url.value.trim();
          url.value = rule.pattern;
          commit();
          reorderRowsInPlace();
          showValidation();
        });
        url.addEventListener('keydown', event => {
          if (event.key === 'Enter') url.blur();
        });

        const mode = document.createElement('select');
        mode.setAttribute('aria-label', '比較方法');
        mode.append(option('inherit', '標準'));
        MODES.forEach(([id, label]) => mode.append(option(id, label)));
        mode.value = rule.mode;
        mode.addEventListener('change', () => {
          rule.mode = mode.value;
          commit();
        });

        const action = document.createElement('select');
        action.setAttribute('aria-label', '重複時の動作');
        ACTIONS.forEach(([id, label]) => action.append(option(id, label)));
        action.value = rule.action;
        action.addEventListener('change', () => {
          rule.action = action.value;
          commit();
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.textContent = '×';
        remove.title = 'ルールを削除';
        remove.setAttribute('aria-label', 'ルールを削除');
        remove.addEventListener('click', () => {
          state.rules = state.rules.filter(x => x.id !== rule.id);
          commit();
          renderRows();
        });

        row.append(url, mode, action, remove);
        holder.append(row);
        if (focusId === rule.id) {
          url.focus();
          // add時の空白行は入力待ち。blurしたら確定/ソートする。
        }
      }
      showValidation();
    }

    $('add').addEventListener('click', () => {
      const added = { id: newId(), pattern: '', mode: 'inherit', action: 'close' };
      state.rules.push(added);
      renderRows(added.id);
    });

    modalHost = host;
    (document.body || document.documentElement).append(host);
    renderRows();
  }

  GM_registerMenuCommand('⚙ 設定を開く', openSettings);

  // ---------------------------- 重複判定 ----------------------------
  let myTabObject = null;
  let mine = null;
  let canAutoClose = false;
  let closing = false;
  let previousReportedKey = '';
  let saveChain = Promise.resolve();
  let checkChain = Promise.resolve();
  let updateTimer = null;

  function updateRegistration() {
    if (!mine || !myTabObject) return Promise.resolve();
    const url = location.href;
    const title = document.title || '';
    if (mine.url === url && mine.title === title) return saveChain;
    mine.url = url;
    mine.title = title;
    myTabObject[TAB_FIELD] = mine;
    saveChain = saveChain.catch(() => {}).then(() => gmSaveTab(myTabObject));
    return saveChain;
  }

  function checkDuplicates() {
    checkChain = checkChain.catch(() => {}).then(async () => {
      if (!mine || closing) return;
      await updateRegistration();
      const currentURL = location.href;
      const settings = readSettings();
      const policy = policyFor(currentURL, settings);
      if (policy.action === 'ignore') return;

      const tabMap = await gmGetTabs();
      const matches = Object.values(tabMap || {})
        .map(tab => tab && tab[TAB_FIELD])
        .filter(tab => tab && tab.id && tab.url && tab.id !== mine.id &&
          policyFor(tab.url, settings).action !== 'ignore' &&
          duplicate(mine, tab, policy.mode));
      if (!matches.length) return;

      const report = currentURL + '\n' + policy.mode;
      if (previousReportedKey !== report) {
        previousReportedKey = report;
        console.info('[Smart Duplicate Tabs Closer] 重複検知', {
          url: currentURL, mode: policy.mode, action: policy.action,
          count: matches.length
        });
      }

      const olderMatch = matches.some(tab => older(tab, mine));
      // 既存の保護サイトを巻き込むURLまたはタイトル一致判定も安全側で処理。
      const hasProtectedOld = matches.some(tab => older(tab, mine) &&
        policyFor(tab.url, settings).action === 'detect');
      if (!settings.autoClose || policy.action !== 'close' ||
          !canAutoClose || !olderMatch || hasProtectedOld ||
          Date.now() - mine.createdAt > NEW_TAB_WINDOW_MS ||
          location.href !== currentURL) return;

      closing = true;
      console.info('[Smart Duplicate Tabs Closer] 新しい重複タブを閉じます:', currentURL);
      window.close();
    }).catch(error => {
      console.warn('[Smart Duplicate Tabs Closer] 重複判定失敗:', error);
    });
    return checkChain;
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(async () => {
      try {
        await updateRegistration();
        if (canAutoClose && Date.now() - mine.createdAt <= NEW_TAB_WINDOW_MS) {
          void checkDuplicates();
        }
      } catch (error) {
        console.warn('[Smart Duplicate Tabs Closer] 登録更新失敗:', error);
      }
    }, 80);
  }

  function watchTitle() {
    if (!document.head) return;
    let titleNode = null;
    const titleObserver = new MutationObserver(scheduleUpdate);
    function attach() {
      const found = document.head.querySelector('title');
      if (found === titleNode) return;
      titleObserver.disconnect();
      titleNode = found;
      if (titleNode) {
        titleObserver.observe(titleNode, {
          subtree: true, childList: true, characterData: true
        });
      }
      scheduleUpdate();
    }
    const headObserver = new MutationObserver(attach);
    headObserver.observe(document.head, { childList: true });
    attach();
  }

  function navigationType() {
    try {
      const entries = performance.getEntriesByType('navigation');
      if (entries && entries[0]) return entries[0].type;
      if (performance.navigation && performance.navigation.type === 1) return 'reload';
    } catch { /* no-op */ }
    return 'navigate';
  }

  async function main() {
    myTabObject = (await gmGetTab()) || {};
    const previous = myTabObject[TAB_FIELD];
    const legacy = myTabObject[OLD_TAB_FIELD];
    const wasRegistered = !!(previous && previous.id);
    if (wasRegistered) {
      mine = previous;
    } else if (legacy && legacy.id) {
      // v1からの移行で既存タブを「新規」と誤認して閉じない。
      mine = {
        id: String(legacy.id),
        createdAt: Number(legacy.createdAt) || Date.now(),
        url: legacy.url || '', title: legacy.title || ''
      };
    } else {
      mine = {
        id: newId(), createdAt: Date.now(), url: '', title: ''
      };
    }

    // 初回登録の新規タブだけ閉じる。既存タブの再読み込みは閉じない。
    canAutoClose = !wasRegistered && !(legacy && legacy.id) &&
      navigationType() !== 'reload' && navigationType() !== 'back_forward';
    mine.url = location.href;
    mine.title = document.title || '';
    myTabObject[TAB_FIELD] = mine;
    await gmSaveTab(myTabObject);

    const startWatching = () => {
      watchTitle();
      scheduleUpdate();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startWatching, { once: true });
    } else {
      startWatching();
    }
    if (window.onurlchange === null) {
      window.addEventListener('urlchange', scheduleUpdate);
    }
    window.addEventListener('hashchange', scheduleUpdate);
    window.addEventListener('popstate', scheduleUpdate);

    if (canAutoClose) {
      for (const delay of CHECK_DELAYS_MS) {
        setTimeout(() => { if (!closing) void checkDuplicates(); }, delay);
      }
    }
  }

  void main().catch(error => {
    console.warn('[Smart Duplicate Tabs Closer] 起動失敗:', error);
  });
})();
