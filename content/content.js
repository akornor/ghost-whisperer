// GhostWhisperer — Content Script
// Handles text extraction and paragraph highlighting.
// Audio playback is handled by the offscreen document.

(function () {
  "use strict";

  if (window.__ghostwhisperer_loaded) return;
  window.__ghostwhisperer_loaded = true;

  let currentHighlightIndex = -1;
  let chunkToRawIndex = [];

  const MAX_CHUNK_LENGTH = 4500; // ElevenLabs limit is ~5000 chars, leave margin

  // Tags Readability produces as top-level content blocks
  const EXTRACTION_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "BLOCKQUOTE", "PRE", "TD", "TH",
  ]);

  // Broader set for finding matching elements in the original DOM
  const HIGHLIGHT_CANDIDATE_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "LI", "BLOCKQUOTE", "PRE", "TD", "TH",
    "DIV", "SECTION", "ARTICLE",
  ]);

  const HIGHLIGHT_SELECTOR = Array.from(HIGHLIGHT_CANDIDATE_TAGS)
    .join(",")
    .toLowerCase();

  // --- Text Extraction ---

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
        splitAt += 1;
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

    const parser = new DOMParser();
    const parsed = parser.parseFromString(article.content, "text/html");

    const rawParagraphs = [];
    const walker = document.createTreeWalker(
      parsed.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          return EXTRACTION_TAGS.has(node.tagName)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
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

    tagOriginalDom(rawParagraphs);

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

  function tagOriginalDom(paragraphs) {
    document.querySelectorAll("[data-gw-index]").forEach((el) => {
      el.removeAttribute("data-gw-index");
      el.classList.remove("ghostwhisperer-active");
    });

    const candidates = document.querySelectorAll(HIGHLIGHT_SELECTOR);

    const used = new Set();
    for (let i = 0; i < paragraphs.length; i++) {
      const target = paragraphs[i];
      const normalizedTarget = target.replace(/\s+/g, " ");
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
    const rawIndex = chunkToRawIndex[chunkIndex] ?? chunkIndex;
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
