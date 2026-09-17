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

async function loadSession() {
  const res = await fetch("/api/me");
  const me = await res.json();
  const adminLink = me.role === "admin" ? ` · <a href="/admin.html">Manage users</a>` : "";
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})${adminLink}</span>
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
    `;
    callRows.appendChild(tr);
  }
}

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
