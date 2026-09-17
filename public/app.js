const searchInput = document.getElementById("search");
const contactList = document.getElementById("contact-list");
const emptyState = document.getElementById("empty-state");
const callHistory = document.getElementById("call-history");
const contactHeading = document.getElementById("contact-heading");
const callRows = document.getElementById("call-rows");

let activeContactId = null;

async function loadContacts(search) {
  const url = search ? `/api/contacts?search=${encodeURIComponent(search)}` : "/api/contacts";
  const res = await fetch(url);
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

  const res = await fetch(`/api/contacts/${encodeURIComponent(contact.id)}/calls`);
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

loadContacts();
