const sessionBar = document.getElementById("session-bar");
const statGrid = document.getElementById("stat-grid");
const dispositionRows = document.getElementById("disposition-rows");
const gapRows = document.getElementById("gap-rows");
const gapPrevBtn = document.getElementById("gap-prev-btn");
const gapNextBtn = document.getElementById("gap-next-btn");
const gapPageIndicator = document.getElementById("gap-page-indicator");
let gapPage = 1;

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
  const csrfToken = me.csrfToken || "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)}) · <a href="/account.html">Change password</a></span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;
}

function dispositionLabel(disposition) {
  if (!disposition || disposition === "(unknown)") return "(unknown)";
  return disposition.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function statTile(label, value) {
  return `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
}

async function loadSummary() {
  const res = await fetch("/api/admin/coverage");
  const { summary, byDisposition } = await res.json();

  const storedPct = summary.total ? Math.round((summary.stored / summary.total) * 100) : 0;
  statGrid.innerHTML =
    statTile("Total calls", summary.total) +
    statTile("Recordings stored", `${summary.stored} (${storedPct}%)`) +
    statTile("Completed calls", summary.completed) +
    statTile("Completed, missing recording", summary.completedMissing);

  dispositionRows.innerHTML = "";
  if (byDisposition.length === 0) {
    dispositionRows.innerHTML = `<tr><td colspan="3" class="empty-state">No calls yet.</td></tr>`;
  }
  for (const row of byDisposition) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(dispositionLabel(row.disposition))}</td>
      <td>${row.count}</td>
      <td>${row.stored}</td>
    `;
    dispositionRows.appendChild(tr);
  }
}

async function loadGaps() {
  const res = await fetch(`/api/admin/coverage/gaps?page=${gapPage}&pageSize=20`);
  const data = await res.json();
  gapRows.innerHTML = "";

  if (data.gaps.length === 0) {
    gapRows.innerHTML = `<tr><td colspan="5" class="empty-state">No gaps found.</td></tr>`;
  }
  for (const call of data.gaps) {
    const tr = document.createElement("tr");
    const when = call.occurredAt ? new Date(call.occurredAt).toLocaleString() : "-";
    tr.innerHTML = `
      <td>${escapeHtml(call.contactName || "(no name)")}${call.contactPhone ? ` (${escapeHtml(call.contactPhone)})` : ""}</td>
      <td>${when}</td>
      <td>${escapeHtml(call.direction || "-")}</td>
      <td>${escapeHtml(call.handledByName || "-")}</td>
      <td>${escapeHtml(call.recordingStatus || "-")}</td>
    `;
    gapRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  gapPageIndicator.textContent = `Page ${data.page} of ${totalPages}`;
  gapPrevBtn.disabled = data.page <= 1;
  gapNextBtn.disabled = data.page >= totalPages;
}

gapPrevBtn.addEventListener("click", () => {
  if (gapPage > 1) {
    gapPage -= 1;
    loadGaps();
  }
});

gapNextBtn.addEventListener("click", () => {
  gapPage += 1;
  loadGaps();
});

loadSession();
loadSummary();
loadGaps();
