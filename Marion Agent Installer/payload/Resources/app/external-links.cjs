// External links: anything the chat page tries to open outside the app goes to the user's default browser / mail app.
// Only http:, https: and mailto: are ever handed to the system; javascript:, data:, file: etc. are dropped.
const externalProtocols = new Set(['http:', 'https:', 'mailto:']);

function isExternalLink(url) {
  try { return externalProtocols.has(new URL(url).protocol); } catch { return false; }
}

/**
 * Wire a window's webContents so link clicks open externally.
 *  - target="_blank" / window.open  -> setWindowOpenHandler (handled here unless `onOpen` claims it, e.g. OAuth about:blank popups)
 *  - plain navigation away from the app -> will-navigate is cancelled and the link is opened externally
 */
function wireExternalLinks(contents, { isLocal, openExternal, onOpen }) {
  const open = url => { if (isExternalLink(url)) Promise.resolve(openExternal(url)).catch(() => {}); };
  contents.setWindowOpenHandler(details => {
    const claimed = onOpen?.(details);
    if (claimed) return claimed;
    open(details.url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    open(url);
  });
  contents.on('will-redirect', (event, url) => { if (!isLocal(url)) event.preventDefault(); });
}

module.exports = { isExternalLink, wireExternalLinks };
