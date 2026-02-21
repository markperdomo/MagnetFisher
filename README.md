# MagnetFisher

A Chrome extension that grabs BitTorrent magnet links from all your open tabs and copies them to the clipboard — one per line, ready to paste into qBittorrent.

## Install

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `MagnetFisher` folder

## Usage

1. Open your torrent pages in Chrome tabs
2. Click the MagnetFisher icon in the toolbar
3. Hit **Grab All Magnet Links**
4. Magnet URIs are copied to your clipboard, one per line
5. In qBittorrent: **File > Add Torrent Link** and paste

## How it works

The extension injects a script into every open tab that queries for `<a>` elements with `magnet:` hrefs. It filters to only collect valid BitTorrent magnet links (must contain `xt=urn:btih:` and at least one tracker `tr=`), deduplicates them, and writes the result to your clipboard.

## Files

```
MagnetFisher/
├── manifest.json   # Chrome extension manifest (Manifest V3)
├── popup.html      # Extension popup UI and styles
├── popup.js        # Tab scanning, magnet extraction, clipboard logic
└── icons/          # Extension icons (16, 48, 128px)
```

## Permissions

- **tabs** — query all open tabs
- **scripting** — inject the magnet-finding script into pages
- **host_permissions `<all_urls>`** — required to script across all tab origins
- **clipboardWrite** — copy results to clipboard

## License

MIT
