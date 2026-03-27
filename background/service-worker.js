// GhostWhisperer — Background Service Worker
// Orchestrates TTS API calls, paragraph queue, and prefetch.
// Audio playback is routed through an offscreen document to avoid autoplay restrictions.
// Reading state is persisted to chrome.storage.session so it survives service worker restarts.

importScripts("audio-cache.js");

const State = {
  IDLE: "idle",
  READING: "reading",
  PAUSED: "paused",
};

let state = State.IDLE;
let paragraphs = [];
let currentIndex = 0;
let prefetchedAudio = null; // { index, base64 }
let activeTabId = null;
let selectedVoiceId = null;
let cachedApiKey = null;

// --- State Persistence ---
// MV3 service workers can be terminated at any time. We persist critical
// reading state to chrome.storage.session so "paragraph-done" messages
// can resume playback after a restart.

async function saveFullState() {
  await chrome.storage.session.set({
    gwState: state,
    gwParagraphs: paragraphs,
    gwCurrentIndex: currentIndex,
    gwActiveTabId: activeTabId,
    gwSelectedVoiceId: selectedVoiceId,
  });
}

async function saveProgress() {
  await chrome.storage.session.set({
    gwState: state,
    gwCurrentIndex: currentIndex,
  });
}

async function restoreState() {
  const data = await chrome.storage.session.get([
    "gwState",
    "gwParagraphs",
    "gwCurrentIndex",
    "gwActiveTabId",
    "gwSelectedVoiceId",
  ]);
  if (data.gwState && data.gwState !== State.IDLE) {
    state = data.gwState;
    paragraphs = data.gwParagraphs || [];
    currentIndex = data.gwCurrentIndex || 0;
    activeTabId = data.gwActiveTabId || null;
    selectedVoiceId = data.gwSelectedVoiceId || null;
  }
}

async function clearPersistedState() {
  await chrome.storage.session.remove([
    "gwState",
    "gwParagraphs",
    "gwCurrentIndex",
    "gwActiveTabId",
    "gwSelectedVoiceId",
  ]);
}

restoreState();

// --- Offscreen Document ---

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Playing ElevenLabs TTS audio for article reading",
  });
}

// --- Helpers ---

function broadcastError(msg) {
  chrome.runtime.sendMessage({ type: "error", message: msg }).catch(() => {});
}

async function getConfig() {
  const data = await chrome.storage.local.get(["apiKey", "voiceId"]);
  return { apiKey: data.apiKey || null, voiceId: data.voiceId || null };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

async function fetchTTS(text, apiKey, voiceId) {
  const cached = await AudioCache.get(text, voiceId);
  if (cached) return cached;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(
      body.detail?.message || `ElevenLabs API error: ${resp.status}`
    );
  }

  const buffer = await resp.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);

  AudioCache.put(text, voiceId, base64).catch(() => {});

  return base64;
}

async function fetchVoices(apiKey) {
  const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch voices: ${resp.status}`);
  }
  const data = await resp.json();
  return data.voices.map((v) => ({ id: v.voice_id, name: v.name }));
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function broadcastState() {
  const msg = {
    type: "state-update",
    state,
    currentIndex,
    totalParagraphs: paragraphs.length,
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (activeTabId) {
    sendToTab(activeTabId, msg).catch(() => {});
  }
}

// --- Prefetch ---

async function prefetchNext(apiKey, voiceId) {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= paragraphs.length) {
    prefetchedAudio = null;
    return;
  }
  try {
    const base64 = await fetchTTS(paragraphs[nextIndex], apiKey, voiceId);
    if (currentIndex + 1 === nextIndex) {
      prefetchedAudio = { index: nextIndex, base64 };
    }
  } catch (_) {
    prefetchedAudio = null;
  }
}

// --- Core playback flow ---

async function startReading(tabId) {
  activeTabId = tabId;

  const [config] = await Promise.all([getConfig(), ensureOffscreen()]);

  if (!config.apiKey) {
    broadcastError("No API key set. Open settings to add your ElevenLabs key.");
    return;
  }
  if (!config.voiceId) {
    broadcastError("No voice selected. Choose a voice from the popup.");
    return;
  }

  cachedApiKey = config.apiKey;
  selectedVoiceId = config.voiceId;

  try {
    const response = await sendToTab(tabId, { type: "extract-text" });
    if (!response || !response.paragraphs || response.paragraphs.length === 0) {
      broadcastError("Could not extract any readable text from this page.");
      return;
    }
    paragraphs = response.paragraphs;
    currentIndex = 0;
    state = State.READING;
    await saveFullState();
    broadcastState();
    await playCurrentParagraph(cachedApiKey, selectedVoiceId);
  } catch (err) {
    broadcastError(`Extraction failed: ${err.message}`);
  }
}

async function playCurrentParagraph(apiKey, voiceId) {
  if (currentIndex >= paragraphs.length) {
    await stopReading();
    return;
  }

  broadcastState();

  let base64;
  if (prefetchedAudio && prefetchedAudio.index === currentIndex) {
    base64 = prefetchedAudio.base64;
    prefetchedAudio = null;
  } else {
    try {
      base64 = await fetchTTS(paragraphs[currentIndex], apiKey, voiceId);
    } catch (err) {
      broadcastError(`TTS failed: ${err.message}`);
      await stopReading();
      return;
    }
  }

  chrome.runtime.sendMessage({
    type: "offscreen-play",
    audioBase64: base64,
  }).catch(() => {});

  sendToTab(activeTabId, {
    type: "highlight",
    paragraphIndex: currentIndex,
  }).catch(() => {});

  prefetchNext(apiKey, voiceId);
}

async function stopReading() {
  state = State.IDLE;
  paragraphs = [];
  currentIndex = 0;
  prefetchedAudio = null;
  await clearPersistedState();
  broadcastState();
  chrome.runtime.sendMessage({ type: "offscreen-stop" }).catch(() => {});
  if (activeTabId) {
    sendToTab(activeTabId, { type: "stop" }).catch(() => {});
  }
}

function advanceToNext() {
  currentIndex++;
  if (currentIndex >= paragraphs.length) {
    stopReading();
  } else {
    const apiKey = cachedApiKey;
    const voiceId = selectedVoiceId;
    saveProgress().then(() => {
      if (!apiKey) {
        getConfig().then((config) => {
          cachedApiKey = config.apiKey;
          playCurrentParagraph(cachedApiKey, voiceId);
        });
      } else {
        playCurrentParagraph(apiKey, voiceId);
      }
    });
  }
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "start": {
      const doStart = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) startReading(tabs[0].id);
        });
      };
      if (state !== State.IDLE) {
        stopReading().then(doStart);
      } else {
        doStart();
      }
      return false;
    }

    case "pause":
      if (state === State.READING) {
        state = State.PAUSED;
        saveProgress();
        broadcastState();
        chrome.runtime.sendMessage({ type: "offscreen-pause" }).catch(() => {});
      }
      return false;

    case "resume":
      if (state === State.PAUSED) {
        state = State.READING;
        saveProgress();
        broadcastState();
        chrome.runtime.sendMessage({ type: "offscreen-resume" }).catch(() => {});
      }
      return false;

    case "next":
      if (state === State.READING || state === State.PAUSED) {
        chrome.runtime.sendMessage({ type: "offscreen-stop" }).catch(() => {});
        state = State.READING;
        advanceToNext();
      }
      return false;

    case "stop":
      stopReading();
      return false;

    case "paragraph-done":
      if (state === State.READING) {
        advanceToNext();
      }
      return false;

    case "get-state":
      sendResponse({
        state,
        currentIndex,
        totalParagraphs: paragraphs.length,
      });
      return false;

    case "get-voices":
      getConfig().then(async (config) => {
        if (!config.apiKey) {
          sendResponse({ error: "No API key set." });
          return;
        }
        try {
          const voices = await fetchVoices(config.apiKey);
          sendResponse({ voices });
        } catch (err) {
          sendResponse({ error: err.message });
        }
      });
      return true;

    case "set-voice":
      chrome.storage.local.set({ voiceId: message.voiceId });
      selectedVoiceId = message.voiceId;
      return false;

    case "set-speed":
      chrome.runtime.sendMessage({
        type: "offscreen-set-speed",
        speed: message.speed,
      }).catch(() => {});
      return false;

    case "get-cache-stats":
      AudioCache.getStats().then((stats) => {
        sendResponse(stats);
      }).catch(() => {
        sendResponse({ count: 0, estimatedSizeMB: 0 });
      });
      return true;

    case "clear-cache":
      AudioCache.clear().then(() => {
        sendResponse({ ok: true });
      }).catch(() => {
        sendResponse({ ok: false });
      });
      return true;
  }
});
