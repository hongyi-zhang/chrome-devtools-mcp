const floatingUI = document.createElement('div');
floatingUI.style.position = 'fixed';
floatingUI.style.bottom = '10px';
floatingUI.style.right = '10px';
floatingUI.style.zIndex = '9999';
floatingUI.style.background = 'white';
floatingUI.style.border = '1px solid black';
floatingUI.style.padding = '10px';
floatingUI.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

const title = document.createElement('div');
title.textContent = 'MCP Replay';
title.style.fontWeight = '600';
title.style.marginBottom = '6px';
floatingUI.appendChild(title);

const status = document.createElement('div');
status.textContent = 'Loading mapping…';
status.style.fontSize = '12px';
status.style.color = '#666';
status.style.marginBottom = '6px';
floatingUI.appendChild(status);

const replayButton = document.createElement('button');
replayButton.textContent = 'Replay Trace';
replayButton.disabled = true;
replayButton.style.padding = '6px 10px';
replayButton.style.cursor = 'not-allowed';
floatingUI.appendChild(replayButton);

document.body.appendChild(floatingUI);

function injectReplayScriptIfNeeded() {
  // If MCPReplay is already present, skip injection
  if (window.MCPReplay) return Promise.resolve();
  return new Promise(resolve => {
    const replayScript = document.createElement('script');
    replayScript.src = chrome.runtime.getURL('replay.js');
    document.head.appendChild(replayScript);
    replayScript.onload = () => {
      replayScript.remove();
      resolve();
    };
  });
}

async function loadMapping() {
  try {
    const url = chrome.runtime.getURL('data/url-trace-mapping.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch mapping');
    const mapping = await res.json();
    return Array.isArray(mapping) ? mapping : [];
  } catch (e) {
    console.warn('[MCP Replay] mapping load failed:', e);
    return [];
  }
}

function findTraceForUrl(mapping, currentUrl) {
  // Exact match first
  const exact = mapping.find(entry => entry && entry.url === currentUrl);
  if (exact) return exact.trace;
  // Fallback: match by origin (best-effort)
  try {
    const origin = new URL(currentUrl).origin;
    const byOrigin = mapping.find(entry => {
      try { return new URL(entry.url).origin === origin; } catch(_) { return false; }
    });
    return byOrigin ? byOrigin.trace : null;
  } catch (_) {
    return null;
  }
}

(async () => {
  const mapping = await loadMapping();
  const traceRelPath = findTraceForUrl(mapping, location.href);
  if (traceRelPath) {
    status.textContent = 'Trace available for this page';
    replayButton.disabled = false;
    replayButton.style.cursor = 'pointer';
    replayButton.addEventListener('click', async () => {
      try {
        await injectReplayScriptIfNeeded();
        const traceUrl = chrome.runtime.getURL(traceRelPath);
        const res = await fetch(traceUrl);
        if (!res.ok) throw new Error('Failed to fetch trace');
        const trace = await res.json();
        window.postMessage({ type: 'MCP_REPLAY_TRACE', trace }, '*');
      } catch (e) {
        console.warn('[MCP Replay] replay failed:', e);
        alert('Replay failed. See console for details.');
      }
    });
  } else {
    status.textContent = 'No trace available for this page';
    replayButton.disabled = true;
    replayButton.style.cursor = 'not-allowed';
  }
})();