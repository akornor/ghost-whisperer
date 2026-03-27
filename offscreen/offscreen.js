let audioElement = null;
let playbackSpeed = 1.0;

function ensureAudioElement() {
  if (!audioElement) {
    audioElement = document.createElement("audio");
    document.body.appendChild(audioElement);

    audioElement.addEventListener("ended", () => {
      chrome.runtime.sendMessage({ type: "paragraph-done" });
    });

    audioElement.addEventListener("error", (e) => {
      console.error("GhostWhisperer audio error:", e);
      chrome.runtime.sendMessage({ type: "paragraph-done" });
    });
  }
  return audioElement;
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "offscreen-play": {
      const audio = ensureAudioElement();

      if (audio.src && audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }

      const binary = atob(message.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      audio.src = URL.createObjectURL(blob);
      audio.playbackRate = playbackSpeed;
      audio.play().catch((err) => {
        console.error("GhostWhisperer play failed:", err);
        chrome.runtime.sendMessage({ type: "paragraph-done" });
      });
      break;
    }

    case "offscreen-pause":
      if (audioElement) audioElement.pause();
      break;

    case "offscreen-resume":
      if (audioElement) audioElement.play().catch(() => {});
      break;

    case "offscreen-stop":
      if (audioElement) {
        audioElement.pause();
        if (audioElement.src && audioElement.src.startsWith("blob:")) {
          URL.revokeObjectURL(audioElement.src);
        }
        audioElement.src = "";
      }
      break;

    case "offscreen-set-speed":
      playbackSpeed = message.speed;
      if (audioElement) audioElement.playbackRate = playbackSpeed;
      break;
  }
});
