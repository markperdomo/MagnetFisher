// Shared qBittorrent WebUI connection module.
// Exposed as the global `window.QBit` and loaded by both popup.html and options.html.
// No build step, no modules — plain script to match the rest of the extension.
//
// Why this is more involved than a plain fetch:
//  - qBittorrent's CSRF protection rejects requests whose Origin/Referer don't match
//    its own host. An extension sends `Origin: chrome-extension://...` -> rejected.
//  - With CSRF on, the SID session cookie is SameSite=Strict, so Chrome will not attach
//    it on cross-site requests from the extension, even after a successful login.
// We solve both with a declarativeNetRequest dynamic rule that rewrites Origin/Referer
// to qBittorrent's own origin and injects `Cookie: SID=...` (read via the cookies API)
// on requests to the configured host. This keeps qBittorrent's defaults untouched and
// works over HTTPS, localhost, and plain-HTTP LAN IPs alike.

(function () {
  const STORAGE_KEY = "qbit";
  const RULE_ID = 1;
  const DEBUG = false; // set true to log each connection step to the page console

  function log(...args) {
    if (DEBUG) console.log("[MagnetFisher]", ...args);
  }

  // Load persisted connection settings. Returns an object with sensible defaults.
  async function loadSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return Object.assign(
      {
        baseUrl: "",
        username: "",
        password: "",
        savepath: "",
        category: "",
        startImmediately: true,
      },
      data[STORAGE_KEY] || {}
    );
  }

  async function saveSettings(settings) {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  }

  function isConfigured(settings) {
    return !!(settings && settings.baseUrl && settings.username);
  }

  // Normalize a user-entered base URL. Strips a trailing slash and derives origin/host.
  // Throws if the URL is unparseable so callers can surface a clear message.
  function normalizeBase(rawUrl) {
    const trimmed = (rawUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) throw new Error("qBittorrent host URL is not set.");
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Invalid host URL: ${rawUrl}`);
    }
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("Host URL must start with http:// or https://");
    }
    return { baseUrl: trimmed, origin: url.origin, hostname: url.hostname };
  }

  // Install/refresh the single dynamic rule that fixes the CSRF headers (and, once we
  // have one, injects the SID cookie) for requests to the qBittorrent host.
  async function applyHeaderRule(base, sid) {
    const requestHeaders = [
      { header: "Origin", operation: "set", value: base.origin },
      { header: "Referer", operation: "set", value: base.baseUrl + "/" },
    ];
    if (sid) {
      requestHeaders.push({ header: "Cookie", operation: "set", value: "SID=" + sid });
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: {
            // Anchor to the exact origin so it matches host:port and bare LAN IPs
            // reliably (requestDomains is finicky with IPs/ports).
            urlFilter: "|" + base.origin + "/",
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
    log(
      "DNR rule set for",
      "|" + base.origin + "/",
      "headers:",
      requestHeaders.map((h) => h.header).join(", ")
    );
  }

  async function clearHeaderRule() {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
  }

  // Authenticate against the WebUI. On success, reads the SID cookie and re-applies the
  // header rule so the cookie is injected on subsequent calls. Throws on failure.
  async function login(settings, base) {
    // Header rule without the cookie is enough for the login request's CSRF check.
    await applyHeaderRule(base);

    const body = new URLSearchParams({
      username: settings.username,
      password: settings.password,
    });

    const loginUrl = base.baseUrl + "/api/v2/auth/login";
    log("POST", loginUrl, "as", settings.username);

    let res;
    try {
      res = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        credentials: "include",
      });
    } catch (err) {
      log("fetch threw:", err);
      throw new Error(
        `Cannot reach qBittorrent at ${base.baseUrl} (${err.message}). ` +
          `Check the host URL, that qBittorrent is running, and http vs https.`
      );
    }

    const text = (await res.text()).trim();
    log("login response:", res.status, res.statusText, JSON.stringify(text));
    log("  redirected:", res.redirected, "finalUrl:", res.url, "type:", res.type);
    const hdrs = {};
    res.headers.forEach((v, k) => (hdrs[k] = v));
    log("  response headers:", hdrs);

    if (res.status === 403) {
      throw new Error(
        "Login refused (403). Either the IP is temporarily banned after failed " +
          "attempts, or the Origin/Referer headers were rejected."
      );
    }
    if (text === "Fails.") {
      throw new Error("Login rejected: wrong WebUI username or password.");
    }
    if (!res.ok && res.status !== 204) {
      throw new Error(`Login failed: HTTP ${res.status}${text ? ` — ${text}` : ""}.`);
    }

    // Best-effort: read the SID cookie if qBittorrent issued one and Chrome kept it.
    // SameSite=Strict stops Chrome re-sending it, so when present we inject it ourselves.
    // But some setups (reverse proxy with IP-whitelist auth bypass) return 204 and no
    // cookie, yet the API is still reachable — so a missing SID is NOT a hard failure.
    // The authenticated probe below is the real source of truth.
    const sid = await readSid(base);
    if (sid) {
      log("SID acquired, length", sid.length);
      await applyHeaderRule(base, sid);
    } else {
      log("no SID cookie; will verify whether the API is reachable without one");
    }
    return sid;
  }

  // GET an authenticated endpoint to confirm we can actually talk to qBittorrent.
  // Returns { ok, status, version }. 403 => auth is genuinely required and not satisfied.
  async function probeVersion(base) {
    const url = base.baseUrl + "/api/v2/app/version";
    let res;
    try {
      res = await fetch(url, { method: "GET", credentials: "include" });
    } catch (err) {
      log("version probe threw:", err);
      return { ok: false, status: 0, version: "", error: err.message };
    }
    const version = (await res.text()).trim();
    log("version probe:", res.status, JSON.stringify(version));
    return { ok: res.ok, status: res.status, version };
  }

  // Read the qBittorrent SID cookie. Tries the base URL first, then falls back to
  // matching by name across the store (covers host/scheme edge cases).
  async function readSid(base) {
    const host = base.hostname;

    let cookie = await chrome.cookies.get({ url: base.baseUrl, name: "SID" });
    if (cookie && cookie.value) {
      log("SID via cookies.get(url):", { domain: cookie.domain, path: cookie.path });
      return cookie.value;
    }

    log("cookies.get(url) found nothing; scanning full store for SID");
    const all = await chrome.cookies.getAll({ name: "SID" });
    log(
      "SID cookies in store:",
      all.map((c) => ({
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        session: c.session,
        sameSite: c.sameSite,
      }))
    );

    const match = all.find((c) => {
      const d = c.domain.replace(/^\./, "");
      return host === d || host.endsWith("." + d);
    });
    if (match) {
      log("SID matched by domain suffix:", match.domain);
      return match.value;
    }
    log("no SID cookie matches host", host, "— cookie was likely dropped by the browser");
    return null;
  }

  // Add one or more magnets in a single /torrents/add call.
  async function addTorrents(settings, base, magnets) {
    const form = new FormData();
    form.append("urls", magnets.join("\n"));

    if (settings.savepath) {
      form.append("savepath", settings.savepath);
      // autoTMM must be off or qBittorrent ignores savepath in favour of category paths.
      form.append("autoTMM", "false");
    }
    if (settings.category) {
      form.append("category", settings.category);
    }

    const paused = settings.startImmediately ? "false" : "true";
    form.append("paused", paused);
    // qBittorrent 5.x renamed `paused` to `stopped` internally but still accepts `paused`.
    // Send both; unknown fields are ignored, so this is safe across versions.
    form.append("stopped", paused);

    let res;
    try {
      // Let fetch set the multipart boundary — do not set Content-Type manually.
      res = await fetch(base.baseUrl + "/api/v2/torrents/add", {
        method: "POST",
        body: form,
        credentials: "include",
      });
    } catch (err) {
      throw new Error(`Cannot reach qBittorrent (${err.message}).`);
    }

    if (res.status === 403) {
      throw new Error("Not authorized (403). The session may have expired.");
    }
    if (!res.ok) {
      throw new Error(`qBittorrent rejected the add: HTTP ${res.status}.`);
    }

    const text = (await res.text()).trim();
    log("add response:", res.status, text.slice(0, 300));

    // Newer qBittorrent (5.x) returns JSON with counts; older versions return "Ok."
    // (success) or "Fails." (all URLs invalid).
    if (text.startsWith("{")) {
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* fall through to the string checks below */
      }
      if (data && typeof data.failure_count === "number") {
        if (data.failure_count > 0) {
          throw new Error(
            `${data.failure_count} of ${magnets.length} torrent(s) failed to add.`
          );
        }
        return { added: data.success_count };
      }
    }
    if (text && text !== "Ok.") {
      throw new Error(`qBittorrent could not add the torrent(s): ${text}`);
    }
    return { added: magnets.length };
  }

  // Test connectivity + credentials only. Returns { ok, message }.
  async function test(settings) {
    try {
      const cfg = settings || (await loadSettings());
      if (!isConfigured(cfg)) {
        return { ok: false, message: "Set a host URL and username first." };
      }
      const base = normalizeBase(cfg.baseUrl);
      const sid = await login(cfg, base);
      const probe = await probeVersion(base);
      if (probe.ok) {
        const via = sid ? "" : " (auth handled upstream — no login needed)";
        return { ok: true, message: `Connected to qBittorrent ${probe.version}${via}`.trim() };
      }
      if (probe.status === 403 || probe.status === 401) {
        return {
          ok: false,
          message:
            "Reached qBittorrent, but it rejected the request as unauthenticated " +
            `(HTTP ${probe.status}). The login didn't establish a session — the SID ` +
            "cookie was blocked or the WebUI needs different credentials.",
        };
      }
      return {
        ok: false,
        message: probe.error
          ? `Could not reach the API: ${probe.error}`
          : `Unexpected response from the API (HTTP ${probe.status}).`,
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // Full send flow: configure headers -> login -> add. Returns { ok, message }.
  // Called fresh for every send so there is no stale-session handling to worry about.
  async function send(magnets, settings) {
    try {
      if (!magnets || magnets.length === 0) {
        return { ok: false, message: "No magnets to send." };
      }
      const cfg = settings || (await loadSettings());
      if (!isConfigured(cfg)) {
        return { ok: false, message: "qBittorrent is not configured.", unconfigured: true };
      }
      const base = normalizeBase(cfg.baseUrl);
      await login(cfg, base);
      const result = await addTorrents(cfg, base, magnets);
      const where = cfg.savepath ? ` → ${cfg.savepath}` : "";
      const n = typeof result.added === "number" ? result.added : magnets.length;
      return { ok: true, message: `${n} torrent${n !== 1 ? "s" : ""} sent to qBittorrent${where}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  window.QBit = {
    STORAGE_KEY,
    loadSettings,
    saveSettings,
    isConfigured,
    normalizeBase,
    clearHeaderRule,
    test,
    send,
  };
})();
