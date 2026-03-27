// GhostWhisperer — Content Script
// Handles text extraction and paragraph highlighting.
// Audio playback is handled by the offscreen document.

(function () {
  "use strict";

  if (window.__ghostwhisperer_loaded) return;
  window.__ghostwhisperer_loaded = true;

  let currentHighlightIndex = -1;

  // --- Text Extraction ---

  const MAX_CHUNK_LENGTH = 4500; // ElevenLabs limit is ~5000 chars, leave margin

  // Split text at sentence boundaries to stay under the API character limit
  function splitLongText(text) {
    if (text.length <= MAX_CHUNK_LENGTH) return [text];

    const chunks = [];
    let remaining = text;
    while (remaining.length > MAX_CHUNK_LENGTH) {
      let splitAt = remaining.lastIndexOf(". ", MAX_CHUNK_LENGTH);
      if (splitAt === -1 || splitAt < MAX_CHUNK_LENGTH * 0.3) {
        splitAt = remaining.lastIndexOf(" ", MAX_CHUNK_LENGTH);
      }
      if (splitAt === -1) {
        splitAt = MAX_CHUNK_LENGTH;
      } else {
        splitAt += 1; // include the space/period
      }
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  function extractParagraphs() {
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (!article || !article.content) {
      return [];
    }

    // Parse the cleaned HTML to get block-level elements
    const parser = new DOMParser();
    const parsed = parser.parseFromString(article.content, "text/html");
    const blockTags = new Set([
      "P", "H1", "H2", "H3", "H4", "H5", "H6",
      "LI", "BLOCKQUOTE", "PRE", "TD", "TH",
    ]);

    const rawParagraphs = [];
    const walker = document.createTreeWalker(
      parsed.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (blockTags.has(node.tagName)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 0) {
        rawParagraphs.push(text);
      }
    }

    // Tag the original DOM for highlighting
    tagOriginalDom(rawParagraphs);

    // Split long paragraphs for TTS, track mapping for highlighting
    const paragraphs = [];
    chunkToRawIndex = [];
    for (let i = 0; i < rawParagraphs.length; i++) {
      const chunks = splitLongText(rawParagraphs[i]);
      for (const chunk of chunks) {
        paragraphs.push(chunk);
        chunkToRawIndex.push(i);
      }
    }

    return paragraphs;
  }

  // Maps chunk index (used by the queue) to raw paragraph index (used for highlighting)
  let chunkToRawIndex = [];

  function tagOriginalDom(paragraphs) {
    // Remove any previous tags
    document.querySelectorAll("[data-gw-index]").forEach((el) => {
      el.removeAttribute("data-gw-index");
      el.classList.remove("ghostwhisperer-active");
    });

    const blockTags = new Set([
      "P", "H1", "H2", "H3", "H4", "H5", "H6",
      "LI", "BLOCKQUOTE", "PRE", "TD", "TH",
      "DIV", "SECTION", "ARTICLE",
    ]);

    const candidates = document.querySelectorAll(
      Array.from(blockTags).join(",").toLowerCase()
    );

    const used = new Set();
    for (let i = 0; i < paragraphs.length; i++) {
      const target = paragraphs[i];
      let bestMatch = null;
      let bestScore = 0;

      for (const el of candidates) {
        if (used.has(el)) continue;
        const elText = el.textContent.trim();
        if (!elText) continue;

        if (elText === target) {
          bestMatch = el;
          bestScore = 1;
          break;
        }

        const normalizedEl = elText.replace(/\s+/g, " ");
        const normalizedTarget = target.replace(/\s+/g, " ");

        if (normalizedEl === normalizedTarget) {
          bestMatch = el;
          bestScore = 1;
          break;
        }

        if (normalizedEl.includes(normalizedTarget)) {
          const score = normalizedTarget.length / normalizedEl.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = el;
          }
        }
      }

      if (bestMatch && bestScore > 0.5) {
        bestMatch.setAttribute("data-gw-index", i);
        used.add(bestMatch);
      }
    }
  }

  // --- Highlighting ---

  function highlightParagraph(chunkIndex) {
    clearHighlight();
    // Map chunk index to raw paragraph index
    const rawIndex =
      chunkToRawIndex[chunkIndex] !== undefined
        ? chunkToRawIndex[chunkIndex]
        : chunkIndex;
    const el = document.querySelector(`[data-gw-index="${rawIndex}"]`);
    if (el) {
      el.classList.add("ghostwhisperer-active");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      currentHighlightIndex = rawIndex;
    }
  }

  function clearHighlight() {
    if (currentHighlightIndex >= 0) {
      const el = document.querySelector(
        `[data-gw-index="${currentHighlightIndex}"]`
      );
      if (el) {
        el.classList.remove("ghostwhisperer-active");
      }
      currentHighlightIndex = -1;
    }
  }

  function clearAllHighlights() {
    document.querySelectorAll(".ghostwhisperer-active").forEach((el) => {
      el.classList.remove("ghostwhisperer-active");
    });
    currentHighlightIndex = -1;
  }

  // --- Message Handling ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case "extract-text": {
        const paragraphs = extractParagraphs();
        sendResponse({ paragraphs });
        return false;
      }

      case "highlight":
        highlightParagraph(message.paragraphIndex);
        return false;

      case "stop":
        clearAllHighlights();
        return false;

      case "state-update":
        return false;
    }
  });
})();
