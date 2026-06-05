/* ============================================
   Spotify Playlist Exporter — Extension Worker
   ============================================ */

// Open index.html in a new tab when clicking the extension icon
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'index.html' });
});

// State
let silentTabId = null;

// Reset tab reference if closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === silentTabId) {
    silentTabId = null;
    console.log('[PlaylistExporter BG] Silent tab closed.');
  }
});

// Listener for AI Mode queries
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ASK_GOOGLE_AI_LANG') {
    handleGoogleAiLang(message.song, message.artists)
      .then(lang => sendResponse({ ok: true, language: lang }))
      .catch(err => {
        console.error('[PlaylistExporter BG] AI search error:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // Keep channel open for async response
  }
});

async function handleGoogleAiLang(song, artists) {
  const cleanQuery = `${song} ${artists}`.trim();
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`What language is the song "${cleanQuery}"?`)}&udm=50`;
  
  // Strict prompt so Google SGE/AI answers with a single word or short line
  const followUpQuery = `What language is the song "${cleanQuery}"? Reply with ONLY the language name in a single word. Do not add any other text.`;

  let usingExistingTab = false;
  let baseTextLength = 0;

  // 1. Check if we have an active background tab
  if (silentTabId !== null) {
    try {
      await chrome.tabs.get(silentTabId); // Throws if tab doesn't exist
      usingExistingTab = true;

      // Get current text length to avoid scanning previous answers
      const snapResults = await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: () => document.body?.innerText?.length || 0
      });
      baseTextLength = snapResults?.[0]?.result || 0;

      // Inject script to type and submit the follow-up
      await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: (query) => {
          const textareas = document.querySelectorAll('textarea');
          let box = null;
          for (const ta of textareas) {
            const ph = ta.placeholder?.toLowerCase() || '';
            if (ph.includes('follow up') || ph.includes('ask anything') || ph.includes('message')) {
              box = ta; break;
            }
          }
          if (!box) {
            box = Array.from(textareas).find(t => t.offsetParent !== null);
          }
          if (box) {
            box.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSetter.call(box, query);
            box.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
              box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
              const btn = box.closest('form')?.querySelector('button[type="submit"], button[aria-label*="send" i]');
              if (btn) btn.click();
            }, 300);
          } else {
            // Fallback: reload tab with new query
            window.location.href = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
          }
        },
        args: [followUpQuery]
      });
    } catch (e) {
      silentTabId = null;
      usingExistingTab = false;
    }
  }

  // 2. Open a new silent tab if none exists
  if (!usingExistingTab) {
    const win = await chrome.windows.create({
      url: searchUrl,
      state: 'minimized',
      focused: false
    });
    silentTabId = win.tabs[0].id;
    // Wait for initial load
    await new Promise(r => setTimeout(r, 7000));
  } else {
    // Wait for response to render
    await new Promise(r => setTimeout(r, 5000));
  }

  // 3. Poll for the AI language result
  const MAX_WAIT_MS = 45000;
  const POLL_INTERVAL_MS = 1000;
  const startTime = Date.now();
  let foundLang = null;
  let captcha = false;

  while (!foundLang && !captcha && (Date.now() - startTime) < MAX_WAIT_MS) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: (baseLen) => {
          const fullText = document.body?.innerText || '';
          if (fullText.includes('detected unusual traffic') || fullText.includes('not a robot')) {
            return { lang: null, captcha: true };
          }

          // Scan only the newly added text or the last chunk
          const textToScan = baseLen > 0
            ? fullText.substring(baseLen)
            : fullText.substring(Math.max(0, fullText.length - 2000));

          const lines = textToScan.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          const badExactLines = new Set([
            'ai overview',
            'search results',
            'show more',
            'sources',
            'google',
            'ask anything',
            'people also ask'
          ]);

          const cleanLanguage = (value) => {
            if (!value) return '';
            let cleaned = value
              .replace(/\*\*/g, '')
              .replace(/^["'`]+|["'`.!,;:]+$/g, '')
              .replace(/^\s*(language|answer)\s*:\s*/i, '')
              .replace(/\s+/g, ' ')
              .trim();

            cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/g, '').trim();
            if (!cleaned || cleaned.length > 48) return '';
            if (badExactLines.has(cleaned.toLowerCase())) return '';
            if (/what language|reply with|song|lyrics|artist|track/i.test(cleaned)) return '';
            if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’/-]*$/u.test(cleaned)) return '';
            return cleaned;
          };

          for (const line of lines) {
            const direct = cleanLanguage(line);
            if (direct && direct.split(/\s+/).length <= 4) {
              return { lang: direct, captcha: false };
            }

            const sentenceMatch = line.match(/\b(?:language|lang)\b[^A-Za-z]{0,8}(?:is|:)\s*([A-Za-z][A-Za-z\s.'’/-]{1,48})/i)
              || line.match(/\bis\s+([A-Za-z][A-Za-z\s.'’/-]{1,48})(?:\s+language)?[.!]?$/i);
            const fromSentence = cleanLanguage(sentenceMatch?.[1]);
            if (fromSentence && fromSentence.split(/\s+/).length <= 4) {
              return { lang: fromSentence, captcha: false };
            }
          }
          return { lang: null, captcha: false };
        },
        args: [baseTextLength]
      });

      const res = results?.[0]?.result;
      if (res?.captcha) {
        captcha = true;
        break;
      }
      if (res?.lang) {
        foundLang = res.lang;
        break;
      }
    } catch (err) {
      console.warn('[PlaylistExporter BG] Execute script warning:', err);
      break;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (captcha) {
    // Bring tab/window to focus so the user can solve CAPTCHA
    chrome.tabs.update(silentTabId, { active: true }).catch(() => {});
    const tabInfo = await chrome.tabs.get(silentTabId).catch(() => null);
    if (tabInfo && tabInfo.windowId) {
      chrome.windows.update(tabInfo.windowId, { focused: true, state: 'normal' }).catch(() => {});
    }
    silentTabId = null; // Reset
    throw new Error('CAPTCHA detected. Please solve the Google captcha first!');
  }

  if (!foundLang) {
    throw new Error('Google AI took too long to answer.');
  }

  return foundLang;
}
