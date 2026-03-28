const cacheCount = document.getElementById("cacheCount");
const cacheSize = document.getElementById("cacheSize");
const clearCacheBtn = document.getElementById("clearCache");
const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("test");
const toggleBtn = document.getElementById("toggleVisibility");
const eyeIcon = document.getElementById("eyeIcon");
const eyeOffIcon = document.getElementById("eyeOffIcon");
const statusToast = document.getElementById("status");
const statusText = document.getElementById("statusText");
const statusIconSuccess = document.getElementById("statusIconSuccess");
const statusIconError = document.getElementById("statusIconError");

function showStatus(msg, type) {
  statusText.textContent = msg;
  statusToast.className = `status-toast visible ${type}`;
  statusIconSuccess.style.display = type === "success" ? "" : "none";
  statusIconError.style.display = type === "error" ? "" : "none";
}

chrome.storage.local.get("apiKey", (data) => {
  if (data.apiKey) {
    apiKeyInput.value = data.apiKey;
  }
});

toggleBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  eyeIcon.style.display = isPassword ? "none" : "";
  eyeOffIcon.style.display = isPassword ? "" : "none";
  toggleBtn.title = isPassword ? "Hide key" : "Show key";
});

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus("API key cannot be empty.", "error");
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    showStatus("Key saved.", "success");
  });
});

testBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus("Enter an API key first.", "error");
    return;
  }

  showStatus("Testing connection...", "neutral");
  testBtn.disabled = true;

  try {
    const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const detail = body?.detail;
      const raw =
        (typeof detail === "string" ? detail : detail?.message) ||
        body?.message ||
        "";
      if (resp.status === 401) {
        throw new Error("Invalid API key.");
      }
      throw new Error(raw || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    showStatus(`Connected \u2014 ${data.voices.length} voices available.`, "success");
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      showStatus("Network error \u2014 check your internet connection.", "error");
    } else {
      showStatus(err.message, "error");
    }
  } finally {
    testBtn.disabled = false;
  }
});

// --- Cache ---

function loadCacheStats() {
  chrome.runtime.sendMessage({ type: "get-cache-stats" }, (stats) => {
    if (chrome.runtime.lastError || !stats) {
      cacheCount.textContent = "0";
      cacheSize.textContent = "0 MB";
      return;
    }
    cacheCount.textContent = stats.count;
    cacheSize.textContent = `${stats.estimatedSizeMB} MB`;
  });
}

loadCacheStats();

clearCacheBtn.addEventListener("click", () => {
  clearCacheBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "clear-cache" }, () => {
    loadCacheStats();
    clearCacheBtn.disabled = false;
  });
});
