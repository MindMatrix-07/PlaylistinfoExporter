/* ============================================
   Spotify Playlist Exporter — Extension Worker
   ============================================ */

// Open index.html in a new tab when clicking the extension icon
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'index.html' });
});

// State
let silentTabId = null;
const aiDebugEntries = [];

function addAiDebug(scope, message, data = {}) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    scope,
    message,
    data
  };
  aiDebugEntries.push(entry);
  if (aiDebugEntries.length > 200) aiDebugEntries.shift();
  console.log(`[PlaylistExporter ${scope}] ${message}`, data);
  return entry;
}

function getAiDebugTail(limit = 120) {
  return aiDebugEntries.slice(-limit);
}

const spotifyProfileCache = new Map();

function decodeHtmlEntities(value = '') {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMeta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]).trim();
  }
  return '';
}

function isUsableSpotifyProfileName(name, userId) {
  const value = (name || '').trim();
  if (!value || value === userId) return false;
  if (/^spotify\s*[-–—]?\s*web\s*player$/i.test(value)) return false;
  if (/^spotify$/i.test(value)) return false;
  return true;
}

function parseSpotifyProfileHtml(html, userId) {
  const title = decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const metaTitle = extractMeta(html, 'og:title');
  const heading = decodeHtmlEntities(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
  const candidates = [
    metaTitle,
    heading,
    title.replace(/\s+on Spotify\s*$/i, '').trim()
  ];
  const name = candidates.find(candidate => isUsableSpotifyProfileName(candidate, userId)) || '';
  const image = extractMeta(html, 'og:image');
  return {
    id: userId,
    name,
    image,
    url: `https://open.spotify.com/user/${encodeURIComponent(userId)}`
  };
}

async function fetchSpotifyProfilePage(userId) {
  if (spotifyProfileCache.has(userId)) return spotifyProfileCache.get(userId);

  const url = `https://open.spotify.com/user/${encodeURIComponent(userId)}`;
  const resp = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 PlaylistInfoExporter'
    }
  });

  if (!resp.ok) throw new Error(`Spotify profile ${userId} failed (${resp.status})`);
  const html = await resp.text();
  const profile = parseSpotifyProfileHtml(html, userId);
  spotifyProfileCache.set(userId, profile);
  return profile;
}

async function handleSpotifyProfiles(userIds = []) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const profiles = {};
  let cursor = 0;
  const concurrency = 4;

  async function worker() {
    while (cursor < uniqueIds.length) {
      const id = uniqueIds[cursor++];
      try {
        profiles[id] = await fetchSpotifyProfilePage(id);
      } catch (err) {
        addAiDebug('bg', 'Spotify profile scrape failed', { userId: id, error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, worker));
  return profiles;
}

// Reset tab reference if closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === silentTabId) {
    silentTabId = null;
    addAiDebug('bg', 'Silent tab closed', { tabId });
  }
});

// Listener for AI Mode queries
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ASK_GOOGLE_AI_LANG') {
    addAiDebug('bg', 'ASK_GOOGLE_AI_LANG received', {
      requestId: message.requestId,
      song: message.song,
      artists: message.artists,
      senderTabId: sender.tab?.id
    });
    handleGoogleAiLang(message.song, message.artists, message.requestId)
      .then(lang => sendResponse({
        ok: true,
        language: lang,
        debug: { requestId: message.requestId, entries: getAiDebugTail(12) }
      }))
      .catch(err => {
        addAiDebug('bg', 'AI search error', {
          requestId: message.requestId,
          error: err.message
        });
        sendResponse({
          ok: false,
          error: err.message,
          debug: { requestId: message.requestId, entries: getAiDebugTail(18) }
        });
      });
    return true; // Keep channel open for async response
  }

  if (message?.type === 'FETCH_SPOTIFY_PROFILES') {
    handleSpotifyProfiles(message.userIds || [])
      .then(profiles => sendResponse({ ok: true, profiles }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'GET_AI_DEBUG_LOG') {
    sendResponse({ ok: true, entries: getAiDebugTail(160) });
    return true;
  }

  if (message?.type === 'CLEAR_AI_DEBUG_LOG') {
    aiDebugEntries.length = 0;
    addAiDebug('bg', 'Background debug log cleared');
    sendResponse({ ok: true });
    return true;
  }
});

async function submitGoogleFollowUp(tabId, query, requestId) {
  addAiDebug('bg', 'Submitting Google follow-up', { requestId, tabId });
  let messageResult = await chrome.tabs.sendMessage(tabId, {
    type: 'TYPE_GOOGLE_AI_FOLLOW_UP',
    query
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  addAiDebug('bg', 'Content-script follow-up result', { requestId, result: messageResult });
  if (messageResult?.ok) {
    return messageResult;
  }

  if (/receiving end|could not establish connection/i.test(messageResult?.error || '')) {
    addAiDebug('bg', 'Injecting google-followup.js into existing Google tab', { requestId, tabId });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['google-followup.js']
    }).catch(() => {});

    messageResult = await chrome.tabs.sendMessage(tabId, {
      type: 'TYPE_GOOGLE_AI_FOLLOW_UP',
      query
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));

    addAiDebug('bg', 'Post-injection follow-up result', { requestId, result: messageResult });
    if (messageResult?.ok) {
      return messageResult;
    }
  }

  addAiDebug('bg', 'Trying injected fallback follow-up', { requestId, tabId });
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (followUpText) => {
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0';
      };
      const findBox = () => {
        const selectors = [
          'textarea[placeholder*="ask" i]',
          'textarea[placeholder*="follow" i]',
          'textarea[placeholder*="message" i]',
          'textarea',
          '[contenteditable="true"]',
          '[role="textbox"]'
        ];

        for (const selector of selectors) {
          const matches = Array.from(document.querySelectorAll(selector))
            .filter(isVisible)
            .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
          if (matches[0]) return matches[0];
        }
        return null;
      };
      const setBoxText = (box, text) => {
        box.click();
        box.focus();
        if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
          const proto = box instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(box, text);
          } else {
            box.value = text;
          }
        } else {
          const selection = window.getSelection();
          const range = document.createRange();
          box.textContent = '';
          range.selectNodeContents(box);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('insertText', false, text);
          if (!box.textContent?.includes(text)) {
            box.textContent = text;
          }
        }

        box.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const findButton = (box) => {
        const roots = [
          box.closest('form'),
          box.closest('[role="search"]'),
          box.closest('[data-ved]'),
          box.parentElement,
          box.parentElement?.parentElement
        ].filter(Boolean);
        const selectors = [
          'button[type="submit"]',
          'button[aria-label*="send" i]',
          'button[aria-label*="ask" i]',
          'button[aria-label*="submit" i]',
          'button[aria-label*="search" i]',
          '[role="button"][aria-label*="send" i]',
          '[role="button"][aria-label*="ask" i]'
        ];

        for (const root of roots) {
          const buttons = selectors
            .flatMap(selector => Array.from(root.querySelectorAll(selector)))
            .filter(isVisible)
            .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true')
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
          if (buttons[0]) return buttons[0];
        }
        return null;
      };

      const box = findBox();
      if (!box) {
        return { ok: false, error: 'Google follow-up box not found' };
      }

      window.__playlistExporterLastPrompt = followUpText;
      setBoxText(box, followUpText);
      await sleep(550);

      const button = findButton(box);
      if (button) {
        button.click();
        await sleep(250);
      }

      box.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      box.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));

      const needle = followUpText.replace(/\s+/g, ' ').trim();
      const start = Date.now();
      let submitted = false;
      while (Date.now() - start < 3500) {
        const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ');
        if (pageText.includes(needle)) {
          submitted = true;
          break;
        }
        await sleep(250);
      }

      if (!submitted) {
        return {
          ok: false,
          error: 'Follow-up text was typed but Google did not submit it',
          source: 'injected-fallback',
          clickedButton: Boolean(button),
          inputTag: box.tagName,
          placeholder: box.getAttribute('placeholder') || ''
        };
      }

      return {
        ok: true,
        source: 'injected-fallback',
        clickedButton: Boolean(button),
        inputTag: box.tagName,
        placeholder: box.getAttribute('placeholder') || ''
      };
    },
    args: [query]
  }).catch(error => [{ result: { ok: false, error: error?.message || String(error) } }]);

  const injectedResult = injected?.[0]?.result || messageResult;
  addAiDebug('bg', 'Injected fallback result', { requestId, result: injectedResult });
  if (injectedResult?.ok) {
    return injectedResult;
  }

  return submitGoogleFollowUpWithDebugger(tabId, query, injectedResult, requestId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function submitGoogleFollowUpWithDebugger(tabId, query, previousResult, requestId) {
  const target = { tabId };
  let attached = false;

  addAiDebug('bg', 'Trying debugger input fallback', { requestId, tabId, previousResult });
  const focusResult = await chrome.scripting.executeScript({
    target,
    func: () => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0';
      };
      const selectors = [
        'textarea[placeholder*="ask" i]',
        'textarea[placeholder*="follow" i]',
        'textarea[placeholder*="message" i]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]'
      ];
      let box = null;
      for (const selector of selectors) {
        const matches = Array.from(document.querySelectorAll(selector))
          .filter(isVisible)
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
        if (matches[0]) {
          box = matches[0];
          break;
        }
      }
      if (!box) return { ok: false, error: 'Google follow-up box not found for debugger input' };

      box.click();
      box.focus();
      if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
        const proto = box instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) nativeSetter.call(box, '');
        else box.value = '';
      } else {
        box.textContent = '';
      }
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

      return {
        ok: true,
        inputTag: box.tagName,
        placeholder: box.getAttribute('placeholder') || '',
        rect: box.getBoundingClientRect().toJSON?.() || null
      };
    }
  }).catch(error => [{ result: { ok: false, error: error?.message || String(error) } }]);

  if (!focusResult?.[0]?.result?.ok) {
    addAiDebug('bg', 'Debugger focus failed', { requestId, result: focusResult?.[0]?.result });
    return {
      ok: false,
      error: focusResult?.[0]?.result?.error || previousResult?.error || 'Could not focus Google follow-up box'
    };
  }

  try {
    addAiDebug('bg', 'Attaching Chrome debugger', { requestId, tabId });
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    addAiDebug('bg', 'Debugger attached; inserting text', { requestId, textLength: query.length });
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text: query });
    await sleep(450);
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await sleep(450);
  } catch (error) {
    addAiDebug('bg', 'Debugger input failed', { requestId, error: error?.message || String(error) });
    return {
      ok: false,
      error: `Debugger input failed: ${error?.message || error}`
    };
  } finally {
    if (attached) {
      addAiDebug('bg', 'Detaching Chrome debugger', { requestId, tabId });
      await chrome.debugger.detach(target).catch(() => {});
    }
  }

  addAiDebug('bg', 'Verifying debugger follow-up submission', { requestId });
  const submittedResult = await chrome.scripting.executeScript({
    target,
    func: async (expectedPrompt) => {
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0';
      };
      const clickSend = () => {
        const selectors = [
          'button[aria-label*="send" i]',
          'button[aria-label*="ask" i]',
          '[role="button"][aria-label*="send" i]',
          '[role="button"][aria-label*="ask" i]',
          'button'
        ];
        const buttons = selectors
          .flatMap(selector => Array.from(document.querySelectorAll(selector)))
          .filter(isVisible)
          .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true')
          .filter(button => !/voice|microphone|mic/i.test(button.getAttribute('aria-label') || ''))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.bottom - ar.bottom) || (br.right - ar.right);
          });
        if (buttons[0]) {
          buttons[0].click();
          return true;
        }
        return false;
      };

      clickSend();
      const needle = expectedPrompt.replace(/\s+/g, ' ').trim();
      const start = Date.now();
      while (Date.now() - start < 4500) {
        const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ');
        if (pageText.includes(needle)) {
          return { ok: true, source: 'debugger-input' };
        }
        await wait(250);
      }

      return { ok: false, error: 'Debugger typed text, but Google did not submit the follow-up' };
    },
    args: [query]
  }).catch(error => [{ result: { ok: false, error: error?.message || String(error) } }]);

  addAiDebug('bg', 'Debugger submission verification result', { requestId, result: submittedResult?.[0]?.result });
  return submittedResult?.[0]?.result || {
    ok: false,
    error: previousResult?.error || 'Debugger follow-up failed'
  };
}

async function handleGoogleAiLang(song, artists, requestId) {
  const cleanQuery = `${song} ${artists}`.trim();
  // Strict prompt so Google SGE/AI answers with a single word or short line
  const followUpQuery = `What language is the song "${cleanQuery}"? Reply with ONLY the language name in a single word. Do not add any other text.`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(followUpQuery)}&udm=50`;
  addAiDebug('bg', 'Prepared Google AI query', { requestId, cleanQuery, promptLength: followUpQuery.length });

  let usingExistingTab = false;
  let baseTextLength = 0;

  // 1. Check if we have an active background tab
  if (silentTabId !== null) {
    try {
      await chrome.tabs.get(silentTabId); // Throws if tab doesn't exist
      usingExistingTab = true;
      addAiDebug('bg', 'Using existing Google AI tab', { requestId, silentTabId });

      // Get current text length to avoid scanning previous answers
      const snapResults = await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: () => document.body?.innerText?.length || 0
      });
      baseTextLength = snapResults?.[0]?.result || 0;
      addAiDebug('bg', 'Captured existing tab text length before follow-up', { requestId, baseTextLength });

      const followUpResult = await submitGoogleFollowUp(silentTabId, followUpQuery, requestId);
      if (!followUpResult?.ok) {
        addAiDebug('bg', 'Follow-up submit failed; reloading query URL', { requestId, followUpResult });
        await chrome.tabs.update(silentTabId, { url: searchUrl });
        baseTextLength = 0;
      } else {
        addAiDebug('bg', 'Follow-up submit confirmed', { requestId, followUpResult });
      }
    } catch (e) {
      addAiDebug('bg', 'Existing Google tab unavailable', { requestId, error: e?.message || String(e) });
      silentTabId = null;
      usingExistingTab = false;
    }
  }

  // 2. Open a new silent tab if none exists
  if (!usingExistingTab) {
    addAiDebug('bg', 'Opening new minimized Google AI window', { requestId });
    const win = await chrome.windows.create({
      url: searchUrl,
      state: 'minimized',
      focused: false
    });
    silentTabId = win.tabs[0].id;
    addAiDebug('bg', 'New Google AI tab opened', { requestId, silentTabId, windowId: win.id });
    // Wait for initial load
    await new Promise(r => setTimeout(r, 5500));
  } else {
    // Wait for response to render
    addAiDebug('bg', 'Waiting for follow-up response render', { requestId });
    await new Promise(r => setTimeout(r, 1800));
  }

  // 3. Poll for the AI language result
  const MAX_WAIT_MS = 45000;
  const POLL_INTERVAL_MS = 700;
  const startTime = Date.now();
  let foundLang = null;
  let captcha = false;

  while (!foundLang && !captcha && (Date.now() - startTime) < MAX_WAIT_MS) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: (baseLen, query) => {
          const fullText = document.body?.innerText || '';
          if (fullText.includes('detected unusual traffic') || fullText.includes('not a robot')) {
            return { lang: null, captcha: true };
          }

          const queryNeedle = query.replace(/\s+/g, ' ').trim();
          const normalizedFullText = fullText.replace(/\s+/g, ' ');
          const queryIndex = normalizedFullText.lastIndexOf(queryNeedle);
          const afterPromptText = queryIndex >= 0
            ? normalizedFullText.substring(queryIndex + queryNeedle.length)
            : '';

          if (!afterPromptText && baseLen > 0) {
            return { lang: null, captcha: false };
          }

          // Scan the newest visible text. Google can re-render answers above/below the input,
          // so keep a fallback chunk even when we know the previous page length.
          const newText = baseLen > 0 ? fullText.substring(baseLen) : '';
          const recentText = fullText.substring(Math.max(0, fullText.length - 6000));
          const textToScan = [afterPromptText, newText, recentText].filter(Boolean).join('\n');

          const lines = textToScan.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          const knownLanguages = new Set([
            'arabic','assamese','bengali','bikol','brazilian portuguese','bulgarian','cebuano',
            'chinese','croatian','czech','danish','dutch','english','finnish','french','german',
            'greek','haitian creole','haryanvi','hausa','hebrew','hindi','hungarian','igbo',
            'indonesian','italian','japanese','javanese','korean','lingála','lingala','malay',
            'malayalam','marathi','nepali','norwegian','odia','persian','punjabi','polish',
            'portuguese','romanian','russian','sanskrit','shona','slovak','spanish','sundanese',
            'swedish','tagalog','tamil','telugu','thai','tsonga','turkish','ukranian','ukrainian',
            'urdu','venda','vietnamese','yoruba','xhosa','zulu'
          ]);
          const badExactLines = new Set([
            'ai mode',
            'ai overview',
            'all',
            'images',
            'videos',
            'news',
            'more',
            'search results',
            'show more',
            'sources',
            'google',
            'ask anything',
            'people also ask',
            'copy',
            'share',
            'like',
            'dislike',
            'you said',
            'microphone',
            'ask anything',
            'voice search',
            'search by voice',
            'send',
            'stop',
            'listen',
            'read aloud'
          ]);

          const cleanLanguage = (value) => {
            if (!value) return '';
            let cleaned = value
              .replace(/\*\*/g, '')
              .replace(/^["'`]+|["'`.!,;:]+$/g, '')
              .replace(/^\s*(language|answer)\s*:\s*/i, '')
              .replace(/^\s*(it is|it's|in)\s+/i, '')
              .replace(/^\s*(the|a|an)\s+/i, '')
              .replace(/\s+language\s*$/i, '')
              .replace(/\s+/g, ' ')
              .trim();

            cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/g, '').trim();
            if (!cleaned || cleaned.length > 48) return '';
            if (badExactLines.has(cleaned.toLowerCase())) return '';
            if (/what language|reply with|song|lyrics|artist|track|you said|microphone|ask anything|voice|search|google|gemini/i.test(cleaned)) return '';
            if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’/-]*$/u.test(cleaned)) return '';
            return cleaned;
          };

          const isKnownLanguage = (value) => {
            const normalized = cleanLanguage(value).toLowerCase();
            if (!normalized) return false;
            if (knownLanguages.has(normalized)) return true;
            return normalized
              .split(/\s*[/,]\s*|\s+and\s+/i)
              .every(part => knownLanguages.has(part.toLowerCase()));
          };

          const pickLanguage = (text, allowDirect = true) => {
            const phraseMatch = text.match(/\b(?:is|are)\s+(?:primarily\s+|mainly\s+)?(?:in\s+)?(?:the\s+)?([A-Za-z][A-Za-z\s.'’/-]{1,48}?)\s+language\b/i)
              || text.match(/\b(?:language|lang)\b[^A-Za-z]{0,8}(?:is|:)\s*(?:in\s+)?(?:the\s+)?([A-Za-z][A-Za-z\s.'’/-]{1,48})/i);
            const fromPhrase = cleanLanguage(phraseMatch?.[1]);
            if (fromPhrase && fromPhrase.split(/\s+/).length <= 4 && isKnownLanguage(fromPhrase)) return fromPhrase;

            if (!allowDirect) return '';
            const direct = cleanLanguage(text);
            if (direct && direct.split(/\s+/).length <= 4 && isKnownLanguage(direct)) return direct;
            return '';
          };

          const candidates = [];
          const phraseCandidates = [
            afterPromptText,
            textToScan,
            ...lines
          ];

          for (const text of phraseCandidates.slice().reverse()) {
            const picked = pickLanguage(text, false);
            if (picked) candidates.push(picked);
          }

          const highlightedTexts = Array.from(document.querySelectorAll('mark strong, mark b, mark, strong.Yjhzub, b.Yjhzub'))
            .map(el => {
              const nearby = el.closest('mark, p, div')?.innerText || el.innerText || '';
              return { text: el.innerText?.trim(), nearby: nearby.trim() };
            })
            .filter(item => item.text && item.text.length <= 80);

          for (const item of highlightedTexts.slice().reverse()) {
            if (!/\blanguage\b/i.test(item.nearby)) continue;
            const picked = pickLanguage(`${item.text} language`, false) || pickLanguage(item.nearby, false);
            if (picked) candidates.push(picked);
          }

          if (candidates.length) {
            return { lang: candidates[0], captcha: false };
          }

          const visibleTexts = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3'))
            .filter(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            })
            .map(el => el.innerText?.trim())
            .filter(text => text && text.length <= 80);

          for (const text of visibleTexts.slice().reverse()) {
            if (/movie:|singer:|music composer:|lyrics:|source|youtube|shazam|you said|microphone|ask anything/i.test(text)) continue;
            const picked = pickLanguage(text);
            if (picked) candidates.push(picked);
          }

          if (candidates.length) {
            return { lang: candidates[0], captcha: false };
          }

          return { lang: null, captcha: false };
        },
        args: [baseTextLength, followUpQuery]
      });

      const res = results?.[0]?.result;
      if (res?.captcha) {
        addAiDebug('bg', 'CAPTCHA detected while polling', { requestId });
        captcha = true;
        break;
      }
      if (res?.lang) {
        foundLang = res.lang;
        addAiDebug('bg', 'Language found while polling', { requestId, language: foundLang });
        break;
      }
    } catch (err) {
      addAiDebug('bg', 'Polling executeScript warning', { requestId, error: err?.message || String(err) });
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
    addAiDebug('bg', 'Timed out waiting for Google AI answer', { requestId });
    throw new Error('Google AI took too long to answer.');
  }

  addAiDebug('bg', 'Returning language result', { requestId, language: foundLang });
  return foundLang;
}
