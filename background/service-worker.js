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
let offscreenCreated = false;

// --- State Persistence ---
// MV3 service workers can be terminated at any time. We persist critical
// reading state to chrome.storage.session (survives restarts, cleared on
// browser close) so "paragraph-done" messages can resume playback.

async function saveState() {
  await chrome.storage.session.set({
    gwState: state,
    gwParagraphs: paragraphs,
    gwCurrentIndex: currentIndex,
    gwActiveTabId: activeTabId,
    gwSelectedVoiceId: selectedVoiceId,
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

// Restore on startup (service worker wake)
restoreState();

// --- Offscreen Document ---

async function ensureOffscreen() {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Playing ElevenLabs TTS audio for article reading",
  });
  offscreenCreated = true;
}

// --- Helpers ---

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get("apiKey", (data) => resolve(data.apiKey || null));
  });
}

async function getSelectedVoice() {
  return new Promise((resolve) => {
    chrome.storage.local.get("voiceId", (data) =>
      resolve(data.voiceId || null)
    );
  });
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function fetchTTS(text, apiKey, voiceId) {
  // Check cache first
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

  // Cache the response
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
  const apiKey = await getApiKey();
  if (!apiKey) {
    chrome.runtime.sendMessage({
      type: "error",
      message: "No API key set. Open settings to add your ElevenLabs key.",
    }).catch(() => {});
    return;
  }

  const voiceId = await getSelectedVoice();
  if (!voiceId) {
    chrome.runtime.sendMessage({
      type: "error",
      message: "No voice selected. Choose a voice from the popup.",
    }).catch(() => {});
    return;
  }
  selectedVoiceId = voiceId;

  try {
    await ensureOffscreen();
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "error",
      message: `Failed to create audio context: ${err.message}`,
    }).catch(() => {});
    return;
  }

  // Ask content script to extract text
  try {
    const response = await sendToTab(tabId, { type: "extract-text" });
    if (!response || !response.paragraphs || response.paragraphs.length === 0) {
      chrome.runtime.sendMessage({
        type: "error",
        message: "Could not extract any readable text from this page.",
      }).catch(() => {});
      return;
    }
    paragraphs = response.paragraphs;
    currentIndex = 0;
    state = State.READING;
    await saveState();
    broadcastState();
    await playCurrentParagraph(apiKey, voiceId);
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "error",
      message: `Extraction failed: ${err.message}`,
    }).catch(() => {});
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
      chrome.runtime.sendMessage({
        type: "error",
        message: `TTS failed: ${err.message}`,
      }).catch(() => {});
      await stopReading();
      return;
    }
  }

  await ensureOffscreen();

  // Send audio to offscreen document for playback
  chrome.runtime.sendMessage({
    type: "offscreen-play",
    audioBase64: base64,
  }).catch(() => {});

  // Tell content script to highlight the current paragraph
  sendToTab(activeTabId, {
    type: "highlight",
    paragraphIndex: currentIndex,
  }).catch(() => {});

  // Start prefetching next paragraph
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

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "start":
      if (state !== State.IDLE) {
        stopReading().then(() => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) startReading(tabs[0].id);
          });
        });
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) startReading(tabs[0].id);
        });
      }
      return false;

    case "pause":
      if (state === State.READING) {
        state = State.PAUSED;
        saveState();
        broadcastState();
        chrome.runtime.sendMessage({ type: "offscreen-pause" }).catch(() => {});
      }
      return false;

    case "resume":
      if (state === State.PAUSED) {
        state = State.READING;
        saveState();
        broadcastState();
        chrome.runtime.sendMessage({ type: "offscreen-resume" }).catch(() => {});
      }
      return false;

    case "next":
      if (state === State.READING || state === State.PAUSED) {
        // Stop current audio, advance to next paragraph
        chrome.runtime.sendMessage({ type: "offscreen-stop" }).catch(() => {});
        state = State.READING;
        currentIndex++;
        if (currentIndex >= paragraphs.length) {
          stopReading();
        } else {
          saveState().then(() =>
            getApiKey().then((apiKey) => {
              playCurrentParagraph(apiKey, selectedVoiceId);
            })
          );
        }
      }
      return false;

    case "stop":
      stopReading();
      return false;

    case "paragraph-done":
      if (state === State.READING) {
        currentIndex++;
        if (currentIndex >= paragraphs.length) {
          stopReading();
        } else {
          saveState().then(() =>
            getApiKey().then((apiKey) => {
              playCurrentParagraph(apiKey, selectedVoiceId);
            })
          );
        }
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
      getApiKey().then(async (apiKey) => {
        if (!apiKey) {
          sendResponse({ error: "No API key set." });
          return;
        }
        try {
          const voices = await fetchVoices(apiKey);
          sendResponse({ voices });
        } catch (err) {
          sendResponse({ error: err.message });
        }
      });
      return true; // async sendResponse

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
      return true; // async sendResponse

    case "clear-cache":
      AudioCache.clear().then(() => {
        sendResponse({ ok: true });
      }).catch(() => {
        sendResponse({ ok: false });
      });
      return true; // async sendResponse
  }
});
