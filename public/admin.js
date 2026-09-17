const sessionBar = document.getElementById("session-bar");
const userRows = document.getElementById("user-rows");
const addUserForm = document.getElementById("add-user-form");
const addUserError = document.getElementById("add-user-error");
const ghlUserSelect = document.getElementById("ghl-user-select");
const settingsSection = document.getElementById("settings-section");
const autoTranscribeToggle = document.getElementById("auto-transcribe-toggle");
const auditRows = document.getElementById("audit-rows");
const auditPrevBtn = document.getElementById("audit-prev-btn");
const auditNextBtn = document.getElementById("audit-next-btn");
const auditPageIndicator = document.getElementById("audit-page-indicator");
const runBackfillBtn = document.getElementById("run-backfill-btn");
const backfillStatus = document.getElementById("backfill-status");
let auditPage = 1;
let csrfToken = "";
let backfillPollTimer = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  if (me.role !== "admin") {
    location.href = "/";
    return;
  }
  csrfToken = me.csrfToken || "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)}) · <a href="/account.html">Change password</a></span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;

  if (me.transcriptionEnabled) await loadSettings();
}

async function loadSettings() {
  settingsSection.hidden = false;
  const res = await fetch("/api/admin/settings");
  const settings = await res.json();
  autoTranscribeToggle.checked = !!settings.autoTranscribeEnabled;
}

function renderBackfillStatus(state) {
  if (state.running) {
    runBackfillBtn.disabled = true;
    runBackfillBtn.textContent = "Backfill running…";
    backfillStatus.textContent = "This can take a while for a lot of history -- feel free to navigate away and check back.";
    if (!backfillPollTimer) backfillPollTimer = setInterval(loadBackfillStatus, 5000);
    return;
  }
  runBackfillBtn.disabled = false;
  runBackfillBtn.textContent = "Run historical backfill";
  if (backfillPollTimer) {
    clearInterval(backfillPollTimer);
    backfillPollTimer = null;
  }
  if (state.lastError) {
    backfillStatus.textContent = `Last run failed: ${state.lastError}`;
  } else if (state.lastResult) {
    const r = state.lastResult;
    backfillStatus.textContent =
      `Last run: ${r.callsSaved} call${r.callsSaved === 1 ? "" : "s"} saved, ${r.callsSkipped} already had, ` +
      `${r.callsFailed} failed to process (${r.conversationsSeen} conversations scanned).`;
  } else {
    backfillStatus.textContent = "";
  }
}

async function loadBackfillStatus() {
  const res = await fetch("/api/admin/backfill");
  renderBackfillStatus(await res.json());
}

runBackfillBtn.addEventListener("click", async () => {
  if (!confirm("Run a full historical backfill now? This walks the account's entire call history and can take a while for large accounts.")) return;
  const res = await fetch("/api/admin/backfill", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not start backfill");
    return;
  }
  renderBackfillStatus(await res.json());
  loadAuditLog();
});

autoTranscribeToggle.addEventListener("change", async () => {
  autoTranscribeToggle.disabled = true;
  const res = await fetch("/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ autoTranscribeEnabled: autoTranscribeToggle.checked }),
  });
  if (!res.ok) {
    alert("Could not update the setting");
    autoTranscribeToggle.checked = !autoTranscribeToggle.checked;
  }
  autoTranscribeToggle.disabled = false;
  loadAuditLog();
});

let ghlUsers = [];

function ghlUserOptionsHtml(selectedId) {
  let html = `<option value="">(none)</option>`;
  for (const u of ghlUsers) {
    const label = `${u.name || "(no name)"}${u.email ? ` — ${u.email}` : ""}`;
    html += `<option value="${escapeHtml(u.id)}" ${u.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }
  return html;
}

async function loadGhlUsers() {
  const res = await fetch("/api/admin/ghl-users");
  ghlUsers = await res.json();
  for (const u of ghlUsers) {
    const option = document.createElement("option");
    option.value = u.id;
    option.dataset.name = u.name || u.email || u.id;
    option.textContent = `${u.name || "(no name)"}${u.email ? ` — ${u.email}` : ""}`;
    ghlUserSelect.appendChild(option);
  }
}

async function loadUsers() {
  const res = await fetch("/api/admin/users");
  const users = await res.json();
  userRows.innerHTML = "";
  for (const user of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(user.username)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>
        <select class="ghl-link-select">${ghlUserOptionsHtml(user.ghlUserId)}</select>
        <button data-id="${user.id}" class="link-ghl-btn">Save</button>
      </td>
      <td>
        <button data-id="${user.id}" class="reset-btn">Reset password</button>
        <button data-id="${user.id}" class="delete-btn">Delete</button>
      </td>
    `;
    tr.querySelector(".delete-btn").addEventListener("click", () => deleteUser(user.id, user.username));
    tr.querySelector(".reset-btn").addEventListener("click", () => resetPassword(user.id, user.username));
    tr.querySelector(".link-ghl-btn").addEventListener("click", () => {
      const select = tr.querySelector(".ghl-link-select");
      linkGhlUser(user.id, select.value || null);
    });
    userRows.appendChild(tr);
  }
}

function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14);
}

async function resetPassword(id, username) {
  if (!confirm(`Reset the password for "${username}"? Their current password will stop working immediately.`)) return;
  const newPassword = generatePassword();
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not reset password");
    return;
  }
  alert(`New password for "${username}":\n\n${newPassword}\n\nSend this to them securely -- it won't be shown again.`);
  loadAuditLog();
}

async function linkGhlUser(id, ghlUserId) {
  const ghlUser = ghlUsers.find((u) => u.id === ghlUserId);
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ ghlUserId, ghlUserName: ghlUser ? ghlUser.name || ghlUser.email || ghlUser.id : null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not update GHL link");
    return;
  }
  loadUsers();
  loadAuditLog();
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not delete user");
    return;
  }
  loadUsers();
  loadAuditLog();
}

async function loadAuditLog() {
  const res = await fetch(`/api/admin/audit-log?page=${auditPage}&pageSize=50`);
  const data = await res.json();
  auditRows.innerHTML = "";

  if (data.entries.length === 0) {
    auditRows.innerHTML = `<tr><td colspan="3" class="empty-state">No activity yet.</td></tr>`;
  }
  for (const entry of data.entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(entry.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(entry.actorUsername || "(unknown)")}</td>
      <td>${escapeHtml(entry.message)}</td>
    `;
    auditRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  auditPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  auditPrevBtn.disabled = data.page <= 1;
  auditNextBtn.disabled = data.page >= totalPages;
}

auditPrevBtn.addEventListener("click", () => {
  if (auditPage > 1) {
    auditPage -= 1;
    loadAuditLog();
  }
});

auditNextBtn.addEventListener("click", () => {
  auditPage += 1;
  loadAuditLog();
});

addUserForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addUserError.hidden = true;
  const formData = new FormData(addUserForm);
  const payload = Object.fromEntries(formData.entries());
  delete payload.ghlUser;
  const selectedOption = ghlUserSelect.selectedOptions[0];
  payload.ghlUserId = ghlUserSelect.value || null;
  payload.ghlUserName = ghlUserSelect.value ? selectedOption.dataset.name : null;
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    addUserError.textContent = body.error || "could not create user";
    addUserError.hidden = false;
    return;
  }
  addUserForm.reset();
  loadUsers();
  loadAuditLog();
});

loadSession();
loadGhlUsers().then(loadUsers);
loadAuditLog();
