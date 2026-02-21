# CLAUDE.md

## Project overview

MagnetFisher is a Chrome extension (Manifest V3) that collects BitTorrent magnet links from all open browser tabs and copies them to the clipboard for use with qBittorrent.

## Architecture

- **popup.html** — Self-contained popup with inline CSS. No build step, no frameworks.
- **popup.js** — All logic lives here: tab querying, script injection via `chrome.scripting.executeScript`, magnet filtering, clipboard writing.
- **manifest.json** — Manifest V3. Requires `tabs`, `scripting`, `clipboardWrite` permissions and `<all_urls>` host permission.
- No background service worker. No content scripts registered in the manifest — scripts are injected on-demand from the popup.

## Key design decisions

- Magnet links are filtered to only include BitTorrent links (`xt=urn:btih:`) with at least one tracker (`tr=`). This avoids collecting non-torrent magnet URIs.
- `chrome.scripting.executeScript` with an inline `func` is used instead of message-passing to content scripts — it's more reliable and avoids race conditions.
- Emojis are avoided in the UI because Chrome extension popups don't reliably render them. SVG icons are used instead.

## Development

No build step. Edit files directly and reload the extension in `chrome://extensions`.

To test changes:
1. Make edits
2. Click the reload button on the extension card in `chrome://extensions`
3. Close and reopen the popup
