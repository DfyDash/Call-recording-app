const sessionBar = document.getElementById("session-bar");
const userRows = document.getElementById("user-rows");
const addUserForm = document.getElementById("add-user-form");
const addUserError = document.getElementById("add-user-error");

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
  sessionBar.innerHTML = `<span>${escapeHtml(me.username)} (${escapeHtml(me.role)})</span>
    <form method="POST" action="/auth/logout"><button type="submit">Log out</button></form>`;
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
      <td><button data-id="${user.id}" class="delete-btn">Delete</button></td>
    `;
    tr.querySelector(".delete-btn").addEventListener("click", () => deleteUser(user.id, user.username));
    userRows.appendChild(tr);
  }
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
loadUsers();
