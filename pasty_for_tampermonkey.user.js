 // ==UserScript==
 // @name         Pasty for Tampermonkey
 // @namespace    local.pasty
 // @version      0.1.0
 // @description  Open clipboard URLs in new tabs
 // @match        https://*/*
 // @run-at       document-idle
 // @noframes
 // @grant        GM_openInTab
 // ==/UserScript==

 (() => {
   'use strict';

   let busy = false;

   document.addEventListener('keydown', async (event) => {
     // Alt + - で発火
     if (!(event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.code === 'Minus')) return;
     if (event.repeat || busy) return;

     event.preventDefault();
     busy = true;

     try {
       const text = await navigator.clipboard.readText();
       const urls = (text.match(
         /(?:https?|ttps?):\/\/[-_.!~*'()a-zA-Z0-9;/?:@&=+$,%#]+/gi
       ) || []).map(url =>
         /^ttps?:/i.test(url) ? 'h' + url : url
       );

       if (!urls.length) {
         throw new Error('クリップボードにURLがありません');
       }

       if (urls.length > 50 &&
           !confirm(`${urls.length}件のタブを開きますか？`)) return;

       for (const url of urls) {
         GM_openInTab(url, { active: false });
       }
     } catch (error) {
       alert(`Pasty: ${error.message}`);
     } finally {
       busy = false;
     }
   }, true);
 })();
