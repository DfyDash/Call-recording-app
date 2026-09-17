const sessionBar = document.getElementById("session-bar");
const accessRows = document.getElementById("access-rows");
const accessPrevBtn = document.getElementById("access-prev-btn");
const accessNextBtn = document.getElementById("access-next-btn");
const accessPageIndicator = document.getElementById("access-page-indicator");
let accessPage = 1;

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
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)}) · <a href="/account.html">Change password</a></span>
    <form method="POST" action="/auth/logout"><button type="submit">Log out</button></form>`;
}

const ACTION_LABELS = {
  recording_played: "Played recording",
  recording_downloaded: "Downloaded recording",
  transcript_viewed: "Viewed transcript",
  transcription_requested: "Requested transcription",
};

function contactLabel(entry) {
  if (entry.contactName || entry.contactPhone) {
    return `${escapeHtml(entry.contactName || "(no name)")}${entry.contactPhone ? ` (${escapeHtml(entry.contactPhone)})` : ""}`;
  }
  return entry.callId ? escapeHtml(entry.callId) : "-";
}

async function loadAccessLog() {
  const res = await fetch(`/api/admin/phi-access-log?page=${accessPage}&pageSize=50`);
  const data = await res.json();
  accessRows.innerHTML = "";

  if (data.entries.length === 0) {
    accessRows.innerHTML = `<tr><td colspan="6" class="empty-state">No access recorded yet.</td></tr>`;
  }
  for (const entry of data.entries) {
    const tr = document.createElement("tr");
    const result = entry.success
      ? `<span>Allowed</span>`
      : `<span class="transcript-failed">Denied${entry.denialReason ? ` (${escapeHtml(entry.denialReason)})` : ""}</span>`;
    tr.innerHTML = `
      <td>${new Date(entry.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(entry.username || "(unknown)")}</td>
      <td>${ACTION_LABELS[entry.action] || escapeHtml(entry.action)}</td>
      <td>${contactLabel(entry)}</td>
      <td>${result}</td>
      <td>${escapeHtml(entry.ipAddress || "-")}</td>
    `;
    accessRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  accessPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  accessPrevBtn.disabled = data.page <= 1;
  accessNextBtn.disabled = data.page >= totalPages;
}

accessPrevBtn.addEventListener("click", () => {
  if (accessPage > 1) {
    accessPage -= 1;
    loadAccessLog();
  }
});

accessNextBtn.addEventListener("click", () => {
  accessPage += 1;
  loadAccessLog();
});

loadSession();
loadAccessLog();
