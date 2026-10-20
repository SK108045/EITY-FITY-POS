// Loaded by the PC preview server only, never by the packaged APK.
(() => {
  if (
    window.OraforgeNative ||
    !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  )
    return;
  let busy = false;
  const state = { message: "Checking automatic backup…" };
  function show() {
    document
      .querySelectorAll("[data-auto-backup-status]")
      .forEach((el) => (el.textContent = state.message));
  }
  async function request(options) {
    const response = await fetch("/api/local/daily-backup", options);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Backup failed");
    return data;
  }
  async function check() {
    if (busy || !window.OraforgeOperations || !window.OraforgeDBReady) return;
    busy = true;
    try {
      await window.OraforgeDBReady;
      let status;
      {
        const data = await window.OraforgeOperations.snapshot();
        // Do not claim a successful backup before the shop has been initialized.
        if (
          !data.records.some(
            ([key]) => key.startsWith("shop:") && key.endsWith(":settings"),
          )
        ) {
          state.message = "Automatic PC backup: waiting for shop data.";
          return;
        }
        window.OraforgeOperations.validate(data);
        status = await request({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
      }
      state.message = `Automatic PC backup saved: ${new Date(status.last_backup).toLocaleString()} — backups/${status.file}.`;
    } catch (err) {
      state.message = `Automatic PC backup failed: ${err.message}. Will retry automatically.`;
    } finally {
      busy = false;
      show();
    }
  }
  let scheduleTimer = null;
  function scheduleCheck(delayMs = 1500) {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(check, delayMs);
  }
  window.OraforgeAutoBackup = { state, check, show, scheduleCheck };
  check();
  setInterval(check, 60000);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
})();
