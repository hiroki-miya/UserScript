// ==UserScript==
// @name         YouTube Playlist Auto Skip by Keywords
// @namespace    https://github.com/hiroki-miya
// @version      1.0
// @description  プレイリスト再生中に特定キーワードを含む動画を自動スキップ
// @author       hiroki-miya
// @match        https://www.youtube.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ★ここにスキップしたいキーワードを追加してください
    const skipKeywords = [
        '#shorts',
        'Every Stock NEWS',
        '楽天証券マーケットＮＥＷＳ',
        '個人投資家向けオンライン会社説明会',
        // ピクテの投信
        '＞｜新興イン',
        '＞｜iTrust新興国株式',
        '＞｜グロイン',
        '＞｜iTrust世界株式',
        '＞｜iTrust日本株式',
        '＞｜ポラリス',
        '＞｜クアトロ',
        // 他のキーワードを追加
    ];

    // 動画をスキップする関数
    function skipVideo(reason) {
        const video = document.querySelector('video');
        const nextButton = document.querySelector('.ytp-next-button');

        if (nextButton && video) {
            console.log(`[Auto Skip] スキップしました: ${reason}`);
            // 次の動画へ
            nextButton.click();
        }
    }

    // タイトルをチェックする関数
    function checkTitle() {
        const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
                           document.querySelector('h1.title yt-formatted-string') ||
                           document.querySelector('h1 yt-formatted-string');

        if (titleElement && titleElement.textContent.trim()) {
            const title = titleElement.textContent.trim();
            console.log(`[Auto Skip] タイトルをチェック: ${title}`);

            // キーワードチェック
            for (const keyword of skipKeywords) {
                if (title.includes(keyword)) {
                    skipVideo(`キーワード「${keyword}」が含まれています: ${title}`);
                    return true;
                }
            }
        }
        return false;
    }

    // タイトル要素を監視
    let titleObserver = null;
    let lastCheckedTitle = '';

    function observeTitle() {
        // 既存の監視を停止
        if (titleObserver) {
            titleObserver.disconnect();
        }

        const titleElement = document.querySelector('h1.ytd-watch-metadata') ||
                           document.querySelector('h1.title') ||
                           document.querySelector('#title h1');

        if (titleElement) {
            console.log('[Auto Skip] タイトル要素の監視を開始');

            titleObserver = new MutationObserver(() => {
                const currentTitle = titleElement.textContent.trim();

                // タイトルが変わった時だけチェック
                if (currentTitle && currentTitle !== lastCheckedTitle) {
                    lastCheckedTitle = currentTitle;
                    console.log('[Auto Skip] タイトルが変更されました');

                    // 少し待ってからチェック（タイトル更新が完全に終わるまで）
                    setTimeout(() => {
                        checkTitle();
                    }, 100);
                }
            });

            titleObserver.observe(titleElement, {
                childList: true,
                subtree: true,
                characterData: true
            });

            // 初回チェック
            setTimeout(() => {
                checkTitle();
            }, 500);
        } else {
            // タイトル要素がまだない場合、少し待ってから再試行
            setTimeout(observeTitle, 500);
        }
    }

    // 動画が変わったことを検知
    let currentVideoId = null;

    function onVideoChange() {
        const videoId = new URLSearchParams(window.location.search).get('v');

        if (videoId && videoId !== currentVideoId) {
            currentVideoId = videoId;
            console.log(`[Auto Skip] 動画が変わりました: ${videoId}`);

            // タイトル監視を再開
            lastCheckedTitle = '';
            observeTitle();
        }
    }

    // YouTubeの独自イベントを監視
    document.addEventListener('yt-navigate-finish', () => {
        console.log('[Auto Skip] yt-navigate-finish イベント検知');
        setTimeout(onVideoChange, 100);
    });

    // URLの変化を監視
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            console.log('[Auto Skip] URL変化検知');
            onVideoChange();
        }
    }).observe(document, { subtree: true, childList: true });

    // video要素の変化も監視
    const videoObserver = new MutationObserver(() => {
        const video = document.querySelector('video');
        if (video && !video.dataset.skipWatching) {
            video.dataset.skipWatching = 'true';
            video.addEventListener('loadedmetadata', () => {
                console.log('[Auto Skip] 動画メタデータ読み込み完了');
                setTimeout(onVideoChange, 500);
            });
        }
    });

    videoObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 定期的に動画IDをチェック（プレイリスト自動遷移対応）
    setInterval(() => {
        onVideoChange();
    }, 500);

    // 初回チェック
    setTimeout(() => {
        onVideoChange();
    }, 1000);

    console.log('[Auto Skip] スクリプトが有効になりました');
    console.log('[Auto Skip] スキップキーワード:', skipKeywords);
})();
