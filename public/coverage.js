const sessionBar = document.getElementById("session-bar");
const statGrid = document.getElementById("stat-grid");
const dispositionRows = document.getElementById("disposition-rows");
const gapRows = document.getElementById("gap-rows");
const gapPrevBtn = document.getElementById("gap-prev-btn");
const gapNextBtn = document.getElementById("gap-next-btn");
const gapPageIndicator = document.getElementById("gap-page-indicator");
const monthChartSvg = document.getElementById("month-chart");
const chartTooltip = document.getElementById("chart-tooltip");
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
  const { summary, byDisposition, byMonth } = await res.json();

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
    const clickable = row.disposition !== "(unknown)";
    if (clickable) {
      tr.className = "clickable-row";
      tr.title = `View all "${dispositionLabel(row.disposition)}" calls on the dashboard`;
      tr.addEventListener("click", () => {
        location.href = `/?disposition=${encodeURIComponent(row.disposition)}`;
      });
    }
    tr.innerHTML = `
      <td>${escapeHtml(dispositionLabel(row.disposition))}</td>
      <td>${row.count}</td>
      <td>${row.stored}</td>
    `;
    dispositionRows.appendChild(tr);
  }

  renderMonthChart(byMonth);
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
    if (call.contactId) {
      tr.className = "clickable-row";
      tr.title = "View this contact on the dashboard";
      tr.addEventListener("click", () => {
        location.href = `/?contactId=${encodeURIComponent(call.contactId)}`;
      });
    }
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

// --- monthly stacked-bar chart (stored vs. missing, completed calls only) ---

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART = { width: 900, height: 260, margin: { top: 10, right: 10, bottom: 26, left: 40 } };

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Rounded top-left/top-right corners, square bottom -- the "4px rounded
// data-end, square at the baseline" mark spec, for whichever segment of a
// stack is on top.
function topRoundedRectPath(x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h));
  if (rad === 0) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return `M${x},${y + rad} A${rad},${rad} 0 0 1 ${x + rad},${y} H${x + w - rad} A${rad},${rad} 0 0 1 ${x + w},${y + rad} V${y + h} H${x} Z`;
}

// Rounds up to a clean axis value (1/2/2.5/5/10 x a power of ten), same
// idea as a chart library's default tick generator.
function niceMax(value) {
  if (value <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function renderMonthChart(byMonth) {
  const { width, height, margin } = CHART;
  monthChartSvg.innerHTML = "";
  monthChartSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  monthChartSvg.setAttribute("preserveAspectRatio", "none");
  if (byMonth.length === 0) return;

  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxVal = niceMax(Math.max(...byMonth.map((m) => m.completed)));
  const baselineY = margin.top + plotH;
  const bandW = plotW / byMonth.length;
  const barW = Math.min(24, Math.max(2, bandW - 6));
  const labelEvery = Math.max(1, Math.ceil(byMonth.length / 10));

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = Math.round((maxVal / tickCount) * i);
    const y = baselineY - (v / maxVal) * plotH;
    monthChartSvg.appendChild(
      svgEl("line", { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: "chart-gridline" })
    );
    const label = svgEl("text", { x: margin.left - 8, y: y + 3, "text-anchor": "end", class: "chart-axis-label" });
    label.textContent = v.toLocaleString();
    monthChartSvg.appendChild(label);
  }

  byMonth.forEach((m, i) => {
    const missing = Math.max(0, m.completed - m.stored);
    const x = margin.left + i * bandW + (bandW - barW) / 2;
    const storedH = (m.stored / maxVal) * plotH;
    const missingH = (missing / maxVal) * plotH;
    const gap = m.stored > 0 && missing > 0 ? 2 : 0;

    const group = svgEl("g", {});

    if (m.stored > 0) {
      const h = Math.max(0, storedH - gap / 2);
      const y = baselineY - h;
      const el =
        missing > 0
          ? svgEl("rect", { x, y, width: barW, height: h })
          : svgEl("path", { d: topRoundedRectPath(x, y, barW, h, 4) });
      el.setAttribute("class", "chart-bar-seg");
      el.setAttribute("fill", "var(--status-good)");
      group.appendChild(el);
    }
    if (missing > 0) {
      const h = Math.max(0, missingH - gap / 2);
      const y = baselineY - storedH - missingH + (gap - gap / 2);
      const el = svgEl("path", { d: topRoundedRectPath(x, y, barW, h, 4) });
      el.setAttribute("class", "chart-bar-seg");
      el.setAttribute("fill", "var(--status-critical)");
      group.appendChild(el);
    }

    const hit = svgEl("rect", {
      x: margin.left + i * bandW,
      y: margin.top,
      width: bandW,
      height: plotH,
      class: "chart-bar-hit",
      tabindex: m.completed > 0 ? "0" : "-1",
    });
    if (m.completed > 0) {
      const move = (e) => showChartTooltip(e, m, missing, i, bandW, storedH);
      hit.addEventListener("pointerenter", move);
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerleave", hideChartTooltip);
      hit.addEventListener("focus", move);
      hit.addEventListener("blur", hideChartTooltip);
    }
    group.appendChild(hit);

    if (i % labelEvery === 0) {
      const label = svgEl("text", {
        x: margin.left + i * bandW + bandW / 2,
        y: height - 6,
        "text-anchor": "middle",
        class: "chart-axis-label",
      });
      label.textContent = monthLabel(m.month);
      group.appendChild(label);
    }

    monthChartSvg.appendChild(group);
  });
}

function showChartTooltip(e, m, missing, i, bandW, storedH) {
  const rect = monthChartSvg.getBoundingClientRect();
  const scaleX = rect.width / CHART.width;
  const scaleY = rect.height / CHART.height;
  const { margin } = CHART;
  const cx = (margin.left + i * bandW + bandW / 2) * scaleX;
  const cy = (margin.top + (CHART.height - margin.top - margin.bottom - storedH)) * scaleY;

  chartTooltip.hidden = false;
  chartTooltip.style.left = `${cx}px`;
  chartTooltip.style.top = `${Math.max(0, cy - 8)}px`;
  chartTooltip.textContent = "";
  const monthLine = document.createElement("div");
  monthLine.textContent = monthLabel(m.month);
  const valueLine = document.createElement("div");
  const storedSpan = document.createElement("span");
  storedSpan.className = "tooltip-value";
  storedSpan.textContent = String(m.stored);
  const missingSpan = document.createElement("span");
  missingSpan.className = "tooltip-value";
  missingSpan.textContent = String(missing);
  valueLine.append(storedSpan, " stored · ", missingSpan, " missing");
  chartTooltip.append(monthLine, valueLine);
}

function hideChartTooltip() {
  chartTooltip.hidden = true;
}

loadSession();
loadSummary();
loadGaps();
