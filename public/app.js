const searchInput = document.getElementById("search");
const contactList = document.getElementById("contact-list");
const callRows = document.getElementById("call-rows");
const sessionBar = document.getElementById("session-bar");
const viewAsSelect = document.getElementById("view-as");
const contactFilterLabel = document.getElementById("contact-filter-label");
const clearContactBtn = document.getElementById("clear-contact-btn");
const dateFromInput = document.getElementById("date-from");
const dateToInput = document.getElementById("date-to");
const pageSizeSelect = document.getElementById("page-size-select");
const resultsSummary = document.getElementById("results-summary");
const pageIndicator = document.getElementById("page-indicator");
const prevPageBtn = document.getElementById("prev-page-btn");
const nextPageBtn = document.getElementById("next-page-btn");

let viewAs = "";
let transcriptionEnabled = false;
let csrfToken = "";

// Default view: this week, all contacts -- never an empty screen on load,
// never pulling too much data unasked either.
const state = {
  contactId: null,
  contactLabel: "All contacts",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20,
};

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(preset) {
  const now = new Date();
  if (preset === "today") return { from: fmtDate(now), to: fmtDate(now) };
  if (preset === "week") {
    const from = new Date(now);
    from.setDate(now.getDate() - now.getDay());
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    return { from: fmtDate(from), to: fmtDate(to) };
  }
  if (preset === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: fmtDate(from), to: fmtDate(to) };
  }
  if (preset === "year") {
    return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  }
  if (preset === "all") return { from: "", to: "" };
  return { from: "", to: "" };
}

function applyDateRange(from, to) {
  state.dateFrom = from;
  state.dateTo = to;
  dateFromInput.value = from;
  dateToInput.value = to;
  state.page = 1;
  loadCalls();
}

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  transcriptionEnabled = !!me.transcriptionEnabled;
  csrfToken = me.csrfToken || "";
  const adminLink = me.role === "admin" ? ` · <a href="/admin.html">Manage users</a>` : "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})${adminLink} · <a href="/account.html">Change password</a></span>
    <form method="POST" action="/auth/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" /><button type="submit">Log out</button></form>`;

  if (me.role === "admin") await loadViewAsOptions();
}

async function loadViewAsOptions() {
  const res = await fetch("/api/admin/users");
  const users = await res.json();
  const agents = users.filter((u) => u.ghlUserId);

  viewAsSelect.innerHTML = `<option value="">All calls</option>` +
    agents.map((u) => `<option value="${escapeHtml(u.ghlUserId)}">${escapeHtml(u.ghlUserName || u.username)}</option>`).join("");
  viewAsSelect.hidden = agents.length === 0;

  viewAsSelect.addEventListener("change", () => {
    viewAs = viewAsSelect.value;
    state.page = 1;
    loadCalls();
    loadContacts(searchInput.value.trim());
  });
}

async function loadContacts(search) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (viewAs) params.set("viewAs", viewAs);
  const query = params.toString();
  const res = await fetch(`/api/contacts${query ? `?${query}` : ""}`);
  const contacts = await res.json();
  renderContacts(contacts);
}

// GHL sometimes stores the contact's own phone number in the "name" field
// when no real name was ever entered -- showing both then just repeats the
// same number twice, so treat that case the same as no name at all.
function isNameJustThePhone(name, phone) {
  if (!name || !phone) return false;
  const nameDigits = name.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  return !!nameDigits && nameDigits.slice(-10) === phoneDigits.slice(-10);
}

function renderContacts(contacts) {
  contactList.innerHTML = "";
  for (const contact of contacts) {
    const li = document.createElement("li");
    li.className = contact.id === state.contactId ? "active" : "";
    li.dataset.contactId = contact.id;
    const displayName = isNameJustThePhone(contact.name, contact.phone) ? "(no name)" : contact.name || "(no name)";
    li.innerHTML = `${escapeHtml(displayName)}<span class="contact-phone">${escapeHtml(contact.phone || "")}</span>`;
    li.addEventListener("click", () => selectContact(contact));
    contactList.appendChild(li);
  }
}

function selectContact(contact) {
  state.contactId = contact.id;
  state.contactLabel = contact.name || contact.phone || contact.id;
  state.page = 1;
  updateContactFilterUi();
  loadCalls();
  document.querySelectorAll(".contact-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.contactId === contact.id);
  });
}

function clearContactFilter() {
  state.contactId = null;
  state.contactLabel = "All contacts";
  state.page = 1;
  updateContactFilterUi();
  loadCalls();
  document.querySelectorAll(".contact-list li").forEach((li) => li.classList.remove("active"));
}

function updateContactFilterUi() {
  contactFilterLabel.textContent = state.contactId ? `Contact: ${state.contactLabel}` : "All contacts";
  clearContactBtn.hidden = !state.contactId;
}

function transcriptCell(call) {
  const canTranscribe = transcriptionEnabled && call.hasRecording;
  switch (call.transcriptionStatus) {
    case "completed":
      return `<details class="transcript-details" data-call="${call.id}">
                <summary>View transcript</summary>
                <p class="transcript-text">Loading…</p>
              </details>`;
    case "pending":
      return `<span class="transcript-pending">Transcribing…</span>`;
    case "failed":
      return `<span class="transcript-failed">Transcription failed</span>` +
        (canTranscribe ? ` <button class="transcribe-btn" data-call="${call.id}">Retry</button>` : "");
    default:
      return canTranscribe
        ? `<button class="transcribe-btn" data-call="${call.id}">Transcribe</button>`
        : `<span>-</span>`;
  }
}

async function loadCalls() {
  const params = new URLSearchParams();
  if (state.contactId) params.set("contactId", state.contactId);
  if (state.dateFrom) params.set("dateFrom", state.dateFrom);
  if (state.dateTo) params.set("dateTo", state.dateTo);
  if (viewAs) params.set("viewAs", viewAs);
  params.set("page", state.page);
  params.set("pageSize", state.pageSize);

  const res = await fetch(`/api/calls?${params.toString()}`);
  const data = await res.json();
  renderCalls(data);
}

// GHL's own call disposition, formatted for display ("no-answer" -> "No
// answer"). This is what actually explains why most "no recording" calls
// have nothing to play -- the call was never answered, not that fetching
// the recording failed.
function dispositionLabel(disposition) {
  if (!disposition) return null;
  return disposition.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderCalls(data) {
  const { calls, total, page, pageSize } = data;
  callRows.innerHTML = "";

  if (calls.length === 0) {
    callRows.innerHTML = `<tr><td colspan="8" class="empty-state">No calls match this filter.</td></tr>`;
  }

  for (const call of calls) {
    const tr = document.createElement("tr");
    const when = call.occurredAt ? new Date(call.occurredAt).toLocaleString() : "-";
    const duration = call.durationSeconds != null ? `${Math.round(call.durationSeconds)}s` : "-";
    const contactCell = `${escapeHtml(call.contactName || "(no name)")}<span class="contact-phone">${escapeHtml(call.contactPhone || "")}</span>`;
    const disposition = dispositionLabel(call.disposition);
    // A call GHL disposed as anything other than "Completed" (no answer,
    // busy, canceled, voicemail...) was never going to have a recording --
    // that's the call's own outcome, not something CallTrove failed to
    // fetch. Only an unexplained gap on a completed call is worth a
    // less certain-sounding label.
    const noRecordingReason =
      disposition && call.disposition !== "completed" ? disposition : "No recording found";
    const recordingCell = call.hasRecording
      ? `<div class="recording-cell">
           <audio controls src="/api/calls/${call.id}/recording"></audio>
           <a class="download-link" href="/api/calls/${call.id}/recording?download" download>Download</a>
         </div>`
      : `<span>${escapeHtml(noRecordingReason)}</span>`;

    tr.innerHTML = `
      <td>${contactCell}</td>
      <td>${when}</td>
      <td>${escapeHtml(call.direction || "-")}</td>
      <td>${duration}</td>
      <td>${escapeHtml(call.handledByName || "-")}</td>
      <td>${escapeHtml(disposition || "-")}</td>
      <td>${recordingCell}</td>
      <td>${transcriptCell(call)}</td>
    `;
    callRows.appendChild(tr);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  resultsSummary.textContent = total === 0 ? "0 calls" : `${total} call${total === 1 ? "" : "s"} found`;
  pageIndicator.textContent = `Page ${page} of ${totalPages}`;
  prevPageBtn.disabled = page <= 1;
  nextPageBtn.disabled = page >= totalPages;
}

// Transcript text is fetched lazily, only when a row's <details> is opened
// -- capture phase because "toggle" doesn't bubble in every browser.
callRows.addEventListener(
  "toggle",
  async (e) => {
    const details = e.target.closest(".transcript-details");
    if (!details || !details.open || details.dataset.loaded) return;
    details.dataset.loaded = "1";
    const textEl = details.querySelector(".transcript-text");
    const res = await fetch(`/api/calls/${details.dataset.call}/transcript`);
    const data = await res.json();
    textEl.textContent = data.transcript || "(empty transcript)";
  },
  true
);

// On-demand transcription: nothing starts until someone clicks this.
callRows.addEventListener("click", async (e) => {
  const btn = e.target.closest(".transcribe-btn");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Starting…";
  const res = await fetch(`/api/calls/${btn.dataset.call}/transcribe`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (res.ok) {
    btn.closest("td").innerHTML = `<span class="transcript-pending">Transcribing…</span>`;
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "Failed to start transcription");
    btn.disabled = false;
    btn.textContent = "Transcribe";
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadContacts(searchInput.value.trim()), 200);
});

clearContactBtn.addEventListener("click", clearContactFilter);

document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const { from, to } = presetRange(btn.dataset.preset);
    applyDateRange(from, to);
  });
});

dateFromInput.addEventListener("change", () => applyDateRange(dateFromInput.value, state.dateTo));
dateToInput.addEventListener("change", () => applyDateRange(state.dateFrom, dateToInput.value));

pageSizeSelect.addEventListener("change", () => {
  state.pageSize = Number(pageSizeSelect.value);
  state.page = 1;
  loadCalls();
});

prevPageBtn.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadCalls();
  }
});

nextPageBtn.addEventListener("click", () => {
  state.page += 1;
  loadCalls();
});

// Initial view: this week, all contacts.
const initialRange = presetRange("week");
state.dateFrom = initialRange.from;
state.dateTo = initialRange.to;
dateFromInput.value = state.dateFrom;
dateToInput.value = state.dateTo;
updateContactFilterUi();

loadSession();
loadContacts();
loadCalls();
