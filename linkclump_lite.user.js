 // ==UserScript==
 // @name         Linkclump Lite
 // @namespace    local.linkclump
 // @version      0.4.0
 // @description  Lightweight link selection and batch opening
 // @match        https://*/*
 // @match        http://*/*
 // @run-at       document-idle
 // @grant        GM_openInTab
 // @grant        GM_getValue
 // @grant        GM_setValue
 // @grant        GM_registerMenuCommand
 // @grant        GM_addValueChangeListener
 // ==/UserScript==

 (() => {
   'use strict';

   // ===== 設定 =====

   const DEFAULT_KEY = 'L';
   const KEY_STORAGE = 'triggerKey';

   const MIN_DRAG = 8;
   const MAX_TABS = 30;

   // 緑枠の最大更新頻度：25fps
   const PREVIEW_INTERVAL = 40;

   // リンク検索用の空間インデックスのセル幅
   const CELL_SIZE = 192;

   const BOX_COLOR = '#2684ff';
   const LINK_COLOR = '#16a34a';

   // ===== キー設定 =====

   function normalizeKey(value) {
     const key = String(value).toUpperCase();
     return /^[A-Z]$/.test(key) ? key : DEFAULT_KEY;
   }

   let triggerKey = normalizeKey(
     GM_getValue(KEY_STORAGE, DEFAULT_KEY)
   );

   let triggerCode = `Key${triggerKey}`;

   function setTriggerKey(value) {
     triggerKey = normalizeKey(value);
     triggerCode = `Key${triggerKey}`;
     keyHeld = false;
     cleanup();
   }

   // 他のタブ・iframeで変更された設定も反映
   GM_addValueChangeListener(
     KEY_STORAGE,
     (_key, _oldValue, newValue) => {
       setTriggerKey(newValue);
     }
   );

   if (window === window.top) {
     GM_registerMenuCommand('選択キーを変更', () => {
       const input = prompt(
         'リンク選択キー（A～Z）',
         triggerKey
       );

       if (input === null) return;

       const key = input.trim().toUpperCase();

       if (!/^[A-Z]$/.test(key)) {
         alert('A～Zの1文字を指定してください');
         return;
       }

       setTriggerKey(key);
       GM_setValue(KEY_STORAGE, key);

       alert(`選択キーを ${key} に変更しました`);
     });
   }

   // ===== 状態 =====

   let keyHeld = false;
   let start = null;
   let dragActive = false;
   let currentArea = null;

   let overlay = null;
   let selectionBox = null;
   let highlightLayer = null;
   let highlightBoxes = [];

   let cache = null;
   let cacheDirty = true;
   let cacheVersion = 0;
   let querySerial = 0;

   let paintedRecords = [];
   let paintedVersion = -1;

   let previewTimer = null;
   let previewFrame = 0;
   let lastPreviewTime = 0;

   let observer = null;
   let suppressClick = false;

   // ===== 共通処理 =====

   function rect(x1, y1, x2, y2) {
     return {
       left: Math.min(x1, x2),
       top: Math.min(y1, y2),
       right: Math.max(x1, x2),
       bottom: Math.max(y1, y2)
     };
   }

   function overlaps(a, b) {
     return a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top;
   }

   function isEditable(target) {
     return target instanceof Element &&
       !!target.closest(
         'input, textarea, select, ' +
         '[contenteditable], [role="textbox"]'
       );
   }

   function cellRange(a, max) {
     return Math.max(
       0,
       Math.min(max - 1, Math.floor(a / CELL_SIZE))
     );
   }

   // ===== リンク位置キャッシュ =====
   // ドラッグ開始後に原則1回だけ実行する。

   function buildCache() {
     const records = [];
     const cells = new Map();

     const vw = window.innerWidth;
     const vh = window.innerHeight;

     const cols = Math.max(
       1, Math.ceil(vw / CELL_SIZE)
     );

     const rows = Math.max(
       1, Math.ceil(vh / CELL_SIZE)
     );

     const anchors = document.querySelectorAll('a[href]');

     for (const anchor of anchors) {
       const raw = anchor.getAttribute('href');

       if (!raw || raw.trim().startsWith('#')) {
         continue;
       }

       const url = anchor.href;

       if (!/^https?:\/\//i.test(url)) {
         continue;
       }

       const fragments = [];

       for (const r of anchor.getClientRects()) {
         // ビューポート外は記録しない
         if (
           r.width <= 0 ||
           r.height <= 0 ||
           r.right <= 0 ||
           r.bottom <= 0 ||
           r.left >= vw ||
           r.top >= vh
         ) continue;

         fragments.push({
           left: r.left,
           top: r.top,
           right: r.right,
           bottom: r.bottom,
           width: r.width,
           height: r.height
         });
       }

       if (!fragments.length) continue;

       const index = records.length;

       const record = {
         index,
         url,
         fragments,
         lastQuery: 0
       };

       records.push(record);

       // 各リンクを空間インデックスに登録
       for (const r of fragments) {
         const x1 = cellRange(r.left, cols);
         const x2 = cellRange(r.right, cols);
         const y1 = cellRange(r.top, rows);
         const y2 = cellRange(r.bottom, rows);

         for (let y = y1; y <= y2; y++) {
           for (let x = x1; x <= x2; x++) {
             const id = y * cols + x;

             let bucket = cells.get(id);

             if (!bucket) {
               bucket = [];
               cells.set(id, bucket);
             }

             bucket.push(index);
           }
         }
       }
     }

     cache = {
       records,
       cells,
       cols,
       rows,
       version: ++cacheVersion
     };

     cacheDirty = false;
   }

   // ===== 空間インデックス検索 =====
   // 選択矩形が交差するセルのみ走査する。

   function collectLinks(area) {
     if (!cache || cacheDirty) {
       buildCache();
     }

     const { records, cells, cols, rows } = cache;

     const x1 = cellRange(area.left, cols);
     const x2 = cellRange(area.right, cols);
     const y1 = cellRange(area.top, rows);
     const y2 = cellRange(area.bottom, rows);

     const queryId = ++querySerial;
     const candidates = [];

     for (let y = y1; y <= y2; y++) {
       for (let x = x1; x <= x2; x++) {
         const bucket = cells.get(y * cols + x);

         if (!bucket) continue;

         for (const index of bucket) {
           const record = records[index];

           // 複数セルへの重複登録を排除
           if (record.lastQuery === queryId) {
             continue;
           }

           record.lastQuery = queryId;

           if (record.fragments.some(
             r => overlaps(area, r)
           )) {
             candidates.push(record);
           }
         }
       }
     }

     // DOM上の出現順を維持
     candidates.sort((a, b) => a.index - b.index);

     // 同一URLは最初の1件だけ採用
     const seen = new Set();
     const selected = [];

     for (const record of candidates) {
       if (seen.has(record.url)) continue;

       seen.add(record.url);
       selected.push(record);
     }

     return selected;
   }

   // ===== オーバーレイ =====

   function ensureOverlay() {
     if (overlay) return;

     overlay = document.createElement('div');

     overlay.style.cssText = [
       'position:fixed',
       'inset:0',
       'z-index:2147483647',
       'pointer-events:none',
       'overflow:hidden'
     ].join(';');

     selectionBox = document.createElement('div');

     selectionBox.style.cssText = [
       'position:absolute',
       'left:0',
       'top:0',
       'box-sizing:border-box',
       `border:2px solid ${BOX_COLOR}`,
       'background:rgba(38,132,255,0.08)',
       'pointer-events:none'
     ].join(';');

     highlightLayer = document.createElement('div');

     highlightLayer.style.cssText = [
       'position:absolute',
       'inset:0',
       'pointer-events:none'
     ].join(';');

     overlay.append(
       selectionBox,
       highlightLayer
     );

     document.documentElement.appendChild(overlay);
   }

   // 青い枠だけはマウス移動に即時追従
   function updateSelection(area) {
     ensureOverlay();

     selectionBox.style.transform =
       `translate(${area.left}px,${area.top}px)`;

     selectionBox.style.width =
       `${area.right - area.left}px`;

     selectionBox.style.height =
       `${area.bottom - area.top}px`;
   }

   // ===== 個別リンクの緑枠 =====

   function updateHighlights(selected) {
     const version = cache.version;

     // 選択リンクが同じならDOM更新を省略
     if (
       version === paintedVersion &&
       selected.length === paintedRecords.length &&
       selected.every(
         (record, i) => record === paintedRecords[i]
       )
     ) {
       return;
     }

     paintedVersion = version;
     paintedRecords = selected;

     let used = 0;

     for (const record of selected) {
       for (const r of record.fragments) {
         let box = highlightBoxes[used];

         if (!box) {
           box = document.createElement('div');

           box.style.cssText = [
             'position:absolute',
             'left:0',
             'top:0',
             'box-sizing:border-box',
             'pointer-events:none',
             `border:2px solid ${LINK_COLOR}`,
             'background:rgba(22,163,74,0.10)',
             'border-radius:2px'
           ].join(';');

           highlightLayer.appendChild(box);
           highlightBoxes.push(box);
         }

         box.style.display = 'block';

         box.style.transform =
           `translate(${r.left}px,${r.top}px)`;

         box.style.width = `${r.width}px`;
         box.style.height = `${r.height}px`;

         used++;
       }
     }

     // 使わなくなった枠は削除せず再利用
     for (let i = used; i < highlightBoxes.length; i++) {
       highlightBoxes[i].style.display = 'none';
     }
   }

   // ===== プレビューの間引き =====

   function schedulePreview() {
     if (!dragActive) return;

     if (previewTimer !== null || previewFrame) {
       return;
     }

     const elapsed = performance.now() - lastPreviewTime;

     const delay = Math.max(
       0,
       PREVIEW_INTERVAL - elapsed
     );

     previewTimer = setTimeout(() => {
       previewTimer = null;

       previewFrame = requestAnimationFrame(() => {
         previewFrame = 0;

         if (!dragActive || !currentArea) return;

         const selected = collectLinks(currentArea);

         updateHighlights(selected);

         lastPreviewTime = performance.now();
       });
     }, delay);
   }

   // ===== DOM・座標変更の検知 =====

   function invalidateGeometry() {
     if (!dragActive) return;

     cacheDirty = true;
     schedulePreview();
   }

   function startTracking() {
     ensureOverlay();

     cacheDirty = true;
     lastPreviewTime = 0;

     // スクロールコンテナ内の移動にも対応
     window.addEventListener(
       'scroll',
       invalidateGeometry,
       { capture: true, passive: true }
     );

     window.addEventListener(
       'resize',
       invalidateGeometry,
       { passive: true }
     );

     // ドラッグ中だけDOM変更を監視
     observer = new MutationObserver(invalidateGeometry);

     observer.observe(
       document.body || document.documentElement,
       {
         subtree: true,
         childList: true,
         attributes: true,
         attributeFilter: [
           'href',
           'class',
           'style',
           'hidden'
         ]
       }
     );
   }

   // ===== 後片付け =====

   function cleanup() {
     if (previewTimer !== null) {
       clearTimeout(previewTimer);
       previewTimer = null;
     }

     if (previewFrame) {
       cancelAnimationFrame(previewFrame);
       previewFrame = 0;
     }

     observer?.disconnect();
     observer = null;

     window.removeEventListener(
       'scroll',
       invalidateGeometry,
       true
     );

     window.removeEventListener(
       'resize',
       invalidateGeometry
     );

     overlay?.remove();

     overlay = null;
     selectionBox = null;
     highlightLayer = null;
     highlightBoxes = [];

     // ドラッグ終了後はキャッシュも解放
     cache = null;
     cacheDirty = true;

     paintedRecords = [];
     paintedVersion = -1;

     start = null;
     currentArea = null;
     dragActive = false;
   }

   function blockNextClick() {
     suppressClick = true;

     // mouseup直後のclickイベントだけを抑止
     setTimeout(() => {
       suppressClick = false;
     }, 0);
   }

   // ===== キーボード =====

   window.addEventListener('keydown', e => {
     if (e.code !== triggerCode) return;
     if (e.ctrlKey || e.altKey || e.metaKey) return;
     if (isEditable(e.target)) return;

     keyHeld = true;
   }, true);

   window.addEventListener('keyup', e => {
     if (e.code !== triggerCode) return;

     keyHeld = false;

     if (start) {
       if (dragActive) blockNextClick();
       cleanup();
     }
   }, true);

   // ===== マウス操作 =====

   window.addEventListener('mousedown', e => {
     if (!keyHeld || e.button !== 0) return;
     if (e.ctrlKey || e.altKey || e.metaKey) return;
     if (isEditable(e.target)) return;

     start = {
       x: e.clientX,
       y: e.clientY
     };

     e.preventDefault();
     e.stopImmediatePropagation();
   }, true);

   window.addEventListener('mousemove', e => {
     if (!start) return;

     if (!(e.buttons & 1)) {
       cleanup();
       return;
     }

     const dx = e.clientX - start.x;
     const dy = e.clientY - start.y;

     if (
       !dragActive &&
       Math.hypot(dx, dy) < MIN_DRAG
     ) return;

     if (!dragActive) {
       dragActive = true;
       startTracking();
     }

     currentArea = rect(
       start.x,
       start.y,
       e.clientX,
       e.clientY
     );

     updateSelection(currentArea);
     schedulePreview();

     e.preventDefault();
     e.stopImmediatePropagation();
   }, true);

   window.addEventListener('mouseup', e => {
     if (!start || e.button !== 0) return;

     if (!dragActive || !keyHeld) {
       cleanup();
       return;
     }

     e.preventDefault();
     e.stopImmediatePropagation();

     blockNextClick();

     const area = rect(
       start.x,
       start.y,
       e.clientX,
       e.clientY
     );

     // 未処理のDOM変更も確認
     if (observer?.takeRecords().length) {
       cacheDirty = true;
     }

     // 最新のキャッシュで最終判定
     const urls = collectLinks(area).map(
       record => record.url
     );

     cleanup();

     if (!urls.length) return;

     if (
       urls.length > MAX_TABS &&
       !confirm(`${urls.length}件のタブを開きますか？`)
     ) return;

     for (const url of urls) {
       GM_openInTab(url, { active: false });
     }
   }, true);

   // 選択後の意図しないリンククリックを防止
   window.addEventListener('click', e => {
     if (!suppressClick) return;

     suppressClick = false;

     e.preventDefault();
     e.stopImmediatePropagation();
   }, true);

   // フォーカスを失ったら状態を解除
   window.addEventListener('blur', () => {
     keyHeld = false;

     if (dragActive) blockNextClick();
     cleanup();
   });

 })();
