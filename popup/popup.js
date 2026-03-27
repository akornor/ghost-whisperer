const playBtn = document.getElementById("playBtn");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");
const nextBtn = document.getElementById("nextBtn");
const stopBtn = document.getElementById("stopBtn");
const voiceSelect = document.getElementById("voiceSelect");
const speedSlider = document.getElementById("speedSlider");
const speedLabel = document.getElementById("speedLabel");
const statusBar = document.getElementById("statusBar");
const statusDot = document.getElementById("statusDot");
const progressFill = document.getElementById("progressFill");
const errorDiv = document.getElementById("error");
const settingsLink = document.getElementById("settingsLink");

let currentState = "idle";

// --- UI Updates ---

function updateUI(state, currentIndex, totalParagraphs) {
  currentState = state;
  errorDiv.style.display = "none";

  // Progress bar
  const progress = totalParagraphs > 0
    ? ((currentIndex + 1) / totalParagraphs) * 100
    : 0;

  switch (state) {
    case "idle":
      statusBar.textContent = "Ready to read";
      statusDot.className = "status-dot";
      playBtn.disabled = false;
      playIcon.style.display = "";
      pauseIcon.style.display = "none";
      playBtn.title = "Play";
      nextBtn.disabled = true;
      stopBtn.disabled = true;
      progressFill.style.width = "0%";
      progressFill.classList.remove("active");
      break;

    case "reading":
      statusBar.textContent = `${currentIndex + 1} of ${totalParagraphs}`;
      statusDot.className = "status-dot reading";
      playBtn.disabled = false;
      playIcon.style.display = "none";
      pauseIcon.style.display = "";
      playBtn.title = "Pause";
      nextBtn.disabled = false;
      stopBtn.disabled = false;
      progressFill.style.width = `${progress}%`;
      progressFill.classList.add("active");
      break;

    case "paused":
      statusBar.textContent = `Paused \u00B7 ${currentIndex + 1} of ${totalParagraphs}`;
      statusDot.className = "status-dot paused";
      playBtn.disabled = false;
      playIcon.style.display = "";
      pauseIcon.style.display = "none";
      playBtn.title = "Resume";
      nextBtn.disabled = false;
      stopBtn.disabled = false;
      progressFill.style.width = `${progress}%`;
      progressFill.classList.add("active");
      break;
  }
}

function showError(msg) {
  errorDiv.textContent = msg;
  errorDiv.style.display = "block";
}

// --- Init ---

chrome.runtime.sendMessage({ type: "get-state" }, (resp) => {
  if (resp) {
    updateUI(resp.state, resp.currentIndex, resp.totalParagraphs);
  }
});

chrome.runtime.sendMessage({ type: "get-voices" }, (resp) => {
  if (chrome.runtime.lastError || !resp) {
    voiceSelect.innerHTML = '<option value="">Failed to load</option>';
    return;
  }
  if (resp.error) {
    voiceSelect.innerHTML = `<option value="">${resp.error}</option>`;
    return;
  }

  chrome.storage.local.get("voiceId", (data) => {
    voiceSelect.innerHTML = "";
    resp.voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      if (data.voiceId === v.id) {
        opt.selected = true;
      }
      voiceSelect.appendChild(opt);
    });

    if (!data.voiceId && resp.voices.length > 0) {
      chrome.runtime.sendMessage({
        type: "set-voice",
        voiceId: resp.voices[0].id,
      });
    }
  });
});

chrome.storage.local.get("speed", (data) => {
  if (data.speed) {
    speedSlider.value = data.speed;
    speedLabel.textContent = `${parseFloat(data.speed).toFixed(1)}x`;
  }
});

// --- Event Handlers ---

playBtn.addEventListener("click", () => {
  if (currentState === "reading") {
    chrome.runtime.sendMessage({ type: "pause" });
  } else if (currentState === "paused") {
    chrome.runtime.sendMessage({ type: "resume" });
  } else {
    chrome.runtime.sendMessage({ type: "start" });
    statusBar.textContent = "Extracting...";
    playBtn.disabled = true;
  }
});

nextBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "next" });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" });
});

voiceSelect.addEventListener("change", () => {
  const voiceId = voiceSelect.value;
  if (voiceId) {
    chrome.runtime.sendMessage({ type: "set-voice", voiceId });
  }
});

speedSlider.addEventListener("input", () => {
  const speed = parseFloat(speedSlider.value);
  speedLabel.textContent = `${speed.toFixed(1)}x`;
  chrome.storage.local.set({ speed });
  chrome.runtime.sendMessage({ type: "set-speed", speed });
});

settingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// --- Listen for state updates ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "state-update") {
    updateUI(message.state, message.currentIndex, message.totalParagraphs);
  }
  if (message.type === "error") {
    showError(message.message);
    updateUI("idle", 0, 0);
  }
});
