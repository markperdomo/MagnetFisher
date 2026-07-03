const fields = ["baseUrl", "username", "password", "savepath", "category"];
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const startImmediately = document.getElementById("startImmediately");
const status = document.getElementById("status");

function setStatus(message, kind) {
  status.textContent = message || "";
  status.className = kind || "";
}

function readForm() {
  const settings = { startImmediately: startImmediately.checked };
  for (const id of fields) {
    settings[id] = document.getElementById(id).value.trim();
  }
  return settings;
}

async function restore() {
  const settings = await QBit.loadSettings();
  for (const id of fields) {
    document.getElementById(id).value = settings[id] || "";
  }
  startImmediately.checked = settings.startImmediately !== false;
}

saveBtn.addEventListener("click", async () => {
  await QBit.saveSettings(readForm());
  setStatus("Settings saved.", "success");
});

testBtn.addEventListener("click", async () => {
  const settings = readForm();
  // Persist first so the DNR host rule matches what we're testing.
  await QBit.saveSettings(settings);
  testBtn.disabled = true;
  saveBtn.disabled = true;
  setStatus("Testing connection…", "working");

  const result = await QBit.test(settings);
  setStatus(result.message, result.ok ? "success" : "error");

  testBtn.disabled = false;
  saveBtn.disabled = false;
});

restore();
