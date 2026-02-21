const grabBtn = document.getElementById("grabBtn");
const status = document.getElementById("status");
const results = document.getElementById("results");

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

grabBtn.addEventListener("click", async () => {
  grabBtn.disabled = true;
  document.body.classList.add("scanning");
  status.className = "scanning";
  status.textContent = "Scanning all tabs...";
  results.innerHTML = "";

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

    results.innerHTML = magnetList
      .map((m, i) => {
        const name = extractName(m);
        return `<div class="magnet-item" style="animation-delay: ${i * 0.04}s">
          <div class="magnet-icon"></div>
          <span class="magnet-name">${name}</span>
        </div>`;
      })
      .join("");
  } catch (err) {
    document.body.classList.remove("scanning");
    status.className = "error";
    status.textContent = `Error: ${err.message}`;
  }

  grabBtn.disabled = false;
});
