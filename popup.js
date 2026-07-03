const grabBtn = document.getElementById("grabBtn");
const sendBtn = document.getElementById("sendBtn");
const settingsBtn = document.getElementById("settingsBtn");
const status = document.getElementById("status");
const results = document.getElementById("results");
const pasteBox = document.getElementById("pasteBox");
const pasteBtn = document.getElementById("pasteBtn");
const pasteInfo = document.getElementById("pasteInfo");
const pasteStatus = document.getElementById("pasteStatus");

// Magnets from the most recent grab, indexed to match the rendered list.
let currentMagnets = [];

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Pull magnet links out of arbitrary pasted/dropped text. More lenient than the page
// scanner: any magnet with a btih hash counts (trackerless magnets are fine here since
// the user is adding these deliberately). Deduplicates while preserving order.
function parseMagnets(text) {
  const found = (text || "").match(/magnet:\?[^\s"'<>\]]+/gi) || [];
  const valid = found.filter((m) => /xt=urn:btih:/i.test(m));
  return [...new Set(valid)];
}

function extractName(magnetUri) {
  const dn = magnetUri.match(/dn=([^&]+)/);
  if (dn) return decodeURIComponent(dn[1].replace(/\+/g, " "));
  const hash = magnetUri.match(/btih:([a-fA-F0-9]+)/);
  if (hash) return `[${hash[1].substring(0, 12)}...]`;
  return "[no name]";
}

// This function runs inside each tab's page context
function findMagnetsOnPage() {
  const magnets = [];
  document.querySelectorAll('a[href^="magnet:"]').forEach((a) => {
    if (a.href.includes("xt=urn:btih:") && a.href.includes("tr=")) {
      magnets.push(a.href);
    }
  });
  return magnets;
}

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

function showConfigHint() {
  results.innerHTML = `
    <div class="config-hint">
      qBittorrent isn't set up yet. <a id="openOptions">Open settings</a> to add your
      host URL, username and password, and save folder.
    </div>`;
  document.getElementById("openOptions").addEventListener("click", () =>
    chrome.runtime.openOptionsPage()
  );
}

function renderResults(magnetList) {
  results.innerHTML = magnetList
    .map((m, i) => {
      const name = escapeHtml(extractName(m));
      return `<div class="magnet-item" style="animation-delay: ${i * 0.04}s">
        <div class="magnet-icon"></div>
        <span class="magnet-name">${name}</span>
        <button class="item-send" data-idx="${i}">Add</button>
      </div>`;
    })
    .join("");

  results.querySelectorAll(".item-send").forEach((btn) => {
    btn.addEventListener("click", () => sendOne(btn));
  });
}

// Send a single magnet via its per-item button.
async function sendOne(btn) {
  const idx = Number(btn.dataset.idx);
  const magnet = currentMagnets[idx];
  if (!magnet) return;

  btn.disabled = true;
  btn.className = "item-send";
  btn.textContent = "…";

  const result = await QBit.send([magnet]);

  if (result.ok) {
    btn.classList.add("sent");
    btn.textContent = "Added";
  } else if (result.unconfigured) {
    btn.disabled = false;
    btn.textContent = "Add";
    showConfigHint();
  } else {
    btn.disabled = false;
    btn.classList.add("failed");
    btn.textContent = "Retry";
    status.className = "error";
    status.textContent = result.message;
  }
}

// Send every grabbed magnet in one batch.
async function sendAll() {
  if (currentMagnets.length === 0) return;

  sendBtn.disabled = true;
  const originalLabel = sendBtn.textContent;
  sendBtn.textContent = "Sending…";
  status.className = "scanning";
  status.textContent = `Sending ${currentMagnets.length} to qBittorrent…`;

  const result = await QBit.send(currentMagnets);

  if (result.ok) {
    status.className = "success";
    status.textContent = result.message;
    results.querySelectorAll(".item-send").forEach((btn) => {
      btn.disabled = true;
      btn.className = "item-send sent";
      btn.textContent = "Added";
    });
    sendBtn.textContent = "Sent";
  } else if (result.unconfigured) {
    sendBtn.disabled = false;
    sendBtn.textContent = originalLabel;
    status.className = "";
    status.textContent = "";
    showConfigHint();
  } else {
    sendBtn.disabled = false;
    sendBtn.textContent = originalLabel;
    status.className = "error";
    status.textContent = result.message;
  }
}

sendBtn.addEventListener("click", sendAll);

// --- Paste / drop your own magnets ---------------------------------------------

function setPasteStatus(message, kind) {
  pasteStatus.textContent = message || "";
  pasteStatus.className = kind || "";
}

function refreshPasteInfo() {
  const n = parseMagnets(pasteBox.value).length;
  const hasText = pasteBox.value.trim().length > 0;
  pasteInfo.textContent = hasText
    ? `${n} magnet${n !== 1 ? "s" : ""} detected`
    : "";
  pasteBtn.disabled = n === 0;
  pasteBtn.textContent = n > 0 ? `Add ${n} pasted torrent${n !== 1 ? "s" : ""}` : "Add pasted torrents";
}

pasteBox.addEventListener("input", () => {
  setPasteStatus("", "");
  refreshPasteInfo();
});

// Load one or more dropped text files into the box.
function loadFiles(fileList) {
  const files = [...fileList].filter(
    (f) => f.type.startsWith("text/") || /\.(txt|text)$/i.test(f.name)
  );
  if (files.length === 0) {
    setPasteStatus("Drop a plain-text (.txt) file.", "error");
    return;
  }
  Promise.all(files.map((f) => f.text())).then((texts) => {
    const existing = pasteBox.value.trim();
    pasteBox.value = (existing ? existing + "\n" : "") + texts.join("\n");
    setPasteStatus("", "");
    refreshPasteInfo();
  });
}

pasteBox.addEventListener("dragover", (e) => {
  e.preventDefault();
  pasteBox.classList.add("dragover");
});
pasteBox.addEventListener("dragleave", () => pasteBox.classList.remove("dragover"));
pasteBox.addEventListener("drop", (e) => {
  e.preventDefault();
  pasteBox.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files.length) {
    loadFiles(e.dataTransfer.files);
  }
});

async function sendPasted() {
  const magnets = parseMagnets(pasteBox.value);
  if (magnets.length === 0) return;

  pasteBtn.disabled = true;
  const originalLabel = pasteBtn.textContent;
  pasteBtn.textContent = "Sending…";
  setPasteStatus(`Sending ${magnets.length} to qBittorrent…`, "scanning");

  const result = await QBit.send(magnets);

  if (result.ok) {
    setPasteStatus(result.message, "success");
    pasteBtn.textContent = "Sent";
  } else if (result.unconfigured) {
    pasteBtn.disabled = false;
    pasteBtn.textContent = originalLabel;
    setPasteStatus("", "");
    showConfigHint();
  } else {
    pasteBtn.disabled = false;
    pasteBtn.textContent = originalLabel;
    setPasteStatus(result.message, "error");
  }
}

pasteBtn.addEventListener("click", sendPasted);

grabBtn.addEventListener("click", async () => {
  grabBtn.disabled = true;
  sendBtn.hidden = true;
  sendBtn.disabled = false;
  sendBtn.textContent = "Send all to qBittorrent";
  document.body.classList.add("scanning");
  status.className = "scanning";
  status.textContent = "Scanning all tabs...";
  results.innerHTML = "";
  currentMagnets = [];

  try {
    const tabs = await chrome.tabs.query({});
    const allMagnets = new Set();
    let scanned = 0;
    let skipped = 0;

    for (const tab of tabs) {
      if (!tab.url || !/^https?:\/\//.test(tab.url)) {
        skipped++;
        continue;
      }

      try {
        const injection = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: findMagnetsOnPage,
        });

        if (injection && injection[0] && injection[0].result) {
          injection[0].result.forEach((m) => allMagnets.add(m));
        }
        scanned++;
      } catch {
        skipped++;
      }
    }

    document.body.classList.remove("scanning");
    const magnetList = [...allMagnets];
    currentMagnets = magnetList;

    if (magnetList.length === 0) {
      status.className = "error";
      status.innerHTML = `No magnet links found across ${scanned} tabs`;
      results.innerHTML = `
        <div class="empty-state">
          Nothing caught this time.<br>Open some torrent pages and try again.
        </div>`;
      grabBtn.disabled = false;
      return;
    }

    await navigator.clipboard.writeText(magnetList.join("\n"));

    status.className = "success";
    status.innerHTML = `<span class="count-badge">${magnetList.length}</span> magnet link${magnetList.length !== 1 ? "s" : ""} copied to clipboard`;

    renderResults(magnetList);
    sendBtn.hidden = false;
  } catch (err) {
    document.body.classList.remove("scanning");
    status.className = "error";
    status.textContent = `Error: ${err.message}`;
  }

  grabBtn.disabled = false;
});
