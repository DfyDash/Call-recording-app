const sessionBar = document.getElementById("session-bar");
const userRows = document.getElementById("user-rows");
const addUserForm = document.getElementById("add-user-form");
const addUserError = document.getElementById("add-user-error");
const ghlUserSelect = document.getElementById("ghl-user-select");

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

async function loadGhlUsers() {
  const res = await fetch("/api/admin/ghl-users");
  const ghlUsers = await res.json();
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
      <td>${escapeHtml(user.ghlUserName || "-")}</td>
      <td>${escapeHtml(user.ghlUserId || "-")}</td>
      <td>
        <button data-id="${user.id}" class="reset-btn">Reset password</button>
        <button data-id="${user.id}" class="delete-btn">Delete</button>
      </td>
    `;
    tr.querySelector(".delete-btn").addEventListener("click", () => deleteUser(user.id, user.username));
    tr.querySelector(".reset-btn").addEventListener("click", () => resetPassword(user.id, user.username));
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not reset password");
    return;
  }
  alert(`New password for "${username}":\n\n${newPassword}\n\nSend this to them securely -- it won't be shown again.`);
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || "could not delete user");
    return;
  }
  loadUsers();
}

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
    headers: { "Content-Type": "application/json" },
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
});

loadSession();
loadGhlUsers();
loadUsers();
