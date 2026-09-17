const searchInput = document.getElementById("search");
const contactList = document.getElementById("contact-list");
const emptyState = document.getElementById("empty-state");
const callHistory = document.getElementById("call-history");
const contactHeading = document.getElementById("contact-heading");
const callRows = document.getElementById("call-rows");
const sessionBar = document.getElementById("session-bar");
const viewAsSelect = document.getElementById("view-as");

let activeContactId = null;
let viewAs = "";
let transcriptionEnabled = false;

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  transcriptionEnabled = !!me.transcriptionEnabled;
  const adminLink = me.role === "admin" ? ` · <a href="/admin.html">Manage users</a>` : "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})${adminLink} · <a href="/account.html">Change password</a></span>
    <form method="POST" action="/auth/logout"><button type="submit">Log out</button></form>`;

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
    activeContactId = null;
    emptyState.hidden = false;
    callHistory.hidden = true;
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

function renderContacts(contacts) {
  contactList.innerHTML = "";
  for (const contact of contacts) {
    const li = document.createElement("li");
    li.className = contact.id === activeContactId ? "active" : "";
    li.innerHTML = `${escapeHtml(contact.name || "(no name)")}<span class="contact-phone">${escapeHtml(contact.phone || "")}</span>`;
    li.addEventListener("click", () => selectContact(contact));
    contactList.appendChild(li);
  }
}

async function selectContact(contact) {
  activeContactId = contact.id;
  emptyState.hidden = true;
  callHistory.hidden = false;
  contactHeading.textContent = contact.name || contact.phone || contact.id;

  const query = viewAs ? `?viewAs=${encodeURIComponent(viewAs)}` : "";
  const res = await fetch(`/api/contacts/${encodeURIComponent(contact.id)}/calls${query}`);
  const calls = await res.json();
  renderCalls(calls);
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

function renderCalls(calls) {
  callRows.innerHTML = "";
  for (const call of calls) {
    const tr = document.createElement("tr");
    const when = call.occurredAt ? new Date(call.occurredAt).toLocaleString() : "-";
    const duration = call.durationSeconds != null ? `${Math.round(call.durationSeconds)}s` : "-";
    const recordingCell = call.hasRecording
      ? `<div class="recording-cell">
           <audio controls src="/api/calls/${call.id}/recording"></audio>
           <a class="download-link" href="/api/calls/${call.id}/recording?download" download>Download</a>
         </div>`
      : `<span>${call.recordingStatus === "failed" ? "fetch failed" : "no recording"}</span>`;

    tr.innerHTML = `
      <td>${when}</td>
      <td>${escapeHtml(call.direction || "-")}</td>
      <td>${duration}</td>
      <td>${escapeHtml(call.handledByName || "-")}</td>
      <td>${escapeHtml(call.recordingStatus)}</td>
      <td>${recordingCell}</td>
      <td>${transcriptCell(call)}</td>
    `;
    callRows.appendChild(tr);
  }
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
  const res = await fetch(`/api/calls/${btn.dataset.call}/transcribe`, { method: "POST" });
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

loadSession();
loadContacts();
