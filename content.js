"use strict";

const STORAGE_KEY = "yt_ad_reloader_position";
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes — treat as new session

function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v");
}

function getVideoElement() {
    return document.querySelector(".html5-video-container video.video-stream.html5-main-video");
}

function getProgressBar() {
    return document.querySelector(".ytp-progress-bar");
}

function savePosition(videoId, timestamp) {
    const data = { videoId, timestamp, savedAt: Date.now() };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadPosition() {
    const raw = sessionStorage.getItem(STORAGE_KEY);

    if (!raw)
        return null;

    try {
        const data = JSON.parse(raw);
        if (Date.now() - data.savedAt > STALE_THRESHOLD_MS) {
            sessionStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return data;
    }
    catch {
        return null;
    }
}

function clearPosition() {
    sessionStorage.removeItem(STORAGE_KEY);
}

// During normal playback: <div class="ytp-progress-bar" draggable="true">
// During an ad:           <div class="ytp-progress-bar">  ← draggable removed
// A MutationObserver on the progress bar's attributes fires the instant
// YouTube strips the draggable attribute, giving us a zero-latency signal.
let progressBarObserver = null;
let reloadScheduled = false;
let adInProgress = false;
let rootObserver = null;
let observedProgressBar = null;

function isAdPlaying() {
    const bar = getProgressBar();

    if (!bar)
        return false;

    return !bar.hasAttribute("draggable");
}

function startAdWatcher() {
    if (progressBarObserver) {
        progressBarObserver.disconnect();
        progressBarObserver = null;
    }

    reloadScheduled = false;

    const attachToProgressBar = (bar) => {

        progressBarObserver = new MutationObserver((mutations) => {
            if (reloadScheduled)
                return;

            for (const mutation of mutations) {
                if (mutation.type !== "attributes" || mutation.attributeName !== "draggable")
                    continue;

                const draggableRemoved = !bar.hasAttribute("draggable");

                if (!draggableRemoved) {
                    // draggable restored — ad ended (shouldn't normally reach here due to reload,
                    // but guards against false positives e.g. mid-seek flicker)
                    adInProgress = false;

                    log("draggable restored — content resumed");

                    continue;
                }

                // draggable was just removed → ad started
                log("Ad detected (draggable removed from .ytp-progress-bar) — reloading…");

                reloadScheduled = true;
                adInProgress = true;

                // Final timestamp write before reload
                const videoId = getVideoId();
                const video = getVideoElement();

                if (videoId && video && video.currentTime > 2) {
                    savePosition(videoId, video.currentTime);
                    log(`Saved position at ${formatTime(video.currentTime)}`);
                }

                setTimeout(() => window.location.reload(), 150);

                return;
            }
        });

        progressBarObserver.observe(bar, {
            attributes: true,
            attributeFilter: ["draggable"],
        });

        log("Ad watcher attached to .ytp-progress-bar");

        // Check immediately in case the page loaded mid-ad
        if (isAdPlaying()) {
            log("Ad already playing on init — reloading…");

            reloadScheduled = true;
            adInProgress = true;

            const videoId = getVideoId();
            const video = getVideoElement();

            if (videoId && video && video.currentTime > 2) {
                savePosition(videoId, video.currentTime);
            }

            setTimeout(() => window.location.reload(), 150);
        }
    };

    const bar = getProgressBar();

    if (bar) {
        attachToProgressBar(bar);
    } else {
        // Progress bar not in DOM yet (page still loading) — wait for it
        const waitObserver = new MutationObserver(() => {
            const b = getProgressBar();

            if (b) {
                waitObserver.disconnect();
                attachToProgressBar(b);
            }
        });

        waitObserver.observe(document.body, { childList: true, subtree: true });
    }
}

function startRootObserver() {
    if (rootObserver) {
        rootObserver.disconnect();
    }

    rootObserver = new MutationObserver(() => {
        const currentBar = getProgressBar();

        if (!currentBar) return;

        if (currentBar !== observedProgressBar) {
            observedProgressBar = currentBar;

            log("Progress bar replaced by YouTube");

            startAdWatcher();
        }
    });

    rootObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

let trackingInterval = null;
let lastTrackedVideoId = null;

function startTracking() {
    if (trackingInterval)
        clearInterval(trackingInterval);

    trackingInterval = setInterval(() => {
        const videoId = getVideoId();

        if (!videoId)
            return;

        // Navigated to a new video — clear stale save
        if (lastTrackedVideoId && lastTrackedVideoId !== videoId) 
            clearPosition();

        lastTrackedVideoId = videoId;

        if (adInProgress)
            return; // never overwrite content timestamp with ad position

        const video = getVideoElement();

        if (!video || video.paused || video.ended)
            return;

        const ts = video.currentTime;

        if (ts > 2)
            savePosition(videoId, ts);

    }, 1000);
}

function seekToSavedPosition(videoId) {
    const saved = loadPosition();

    if (!saved)
        return;

    if (saved.videoId !== videoId) {
        clearPosition();
        return;
    }

    if (saved.timestamp < 2) {
        clearPosition();
        return;
    }

    const trySeek = (video) => {
        const attempt = () => {
            if (video.duration && saved.timestamp < video.duration - 2) {
                video.currentTime = saved.timestamp;

                log(`Resumed at ${formatTime(saved.timestamp)}`);

                clearPosition();
            }
        };

        if (video.readyState >= 1) 
            attempt();
        else 
            video.addEventListener("loadedmetadata", attempt, { once: true });
    };

    const video = getVideoElement();

    if (video)
        trySeek(video);
    else {
        const observer = new MutationObserver(() => {
            const v = getVideoElement();

            if (v) {
                observer.disconnect();
                trySeek(v);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }
}

let currentUrl = window.location.href;

function onUrlChange() {

    const newUrl = window.location.href;

    if (newUrl === currentUrl)
        return;

    const oldVideoId = new URLSearchParams(new URL(currentUrl).search).get("v");
    const newVideoId = new URLSearchParams(new URL(newUrl).search).get("v");

    currentUrl = newUrl;

    if (newVideoId && newVideoId !== oldVideoId) {
        clearPosition();
        adInProgress = false;
        log(`New video (${newVideoId}) — cleared stale position`);
    }

    if (newVideoId)
        init();
}

document.addEventListener("yt-navigate-finish", () => {
    log(`YouTube navigation: ${window.location.href}`);
    onUrlChange();
});

function init() {
    const videoId = getVideoId();

    if (!videoId) {
        log("Not on a watch page");
        return;
    }

    log(`Initializing for ${videoId}`);

    adInProgress = false;

    startTracking();
    startAdWatcher();
    startRootObserver();
    seekToSavedPosition(videoId);
}

function log(msg) {
    console.log(`[YT Ad Reloader] ${msg}`);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        : `${m}:${String(s).padStart(2, "0")}`;
}

if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
else 
    init();