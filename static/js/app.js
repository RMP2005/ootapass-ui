/* OotaPass coordinator console.
   Plain JavaScript: the server plans, this file draws the plan and plays the night. */

(() => {
  "use strict";

  const NIGHT_END = 240;              // 00:00, in minutes after 20:00
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const REASON_LABEL = { food: "Food", transport: "Transport", time: "Time", "receiving capacity": "Receiving capacity" };
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const REASON_TEXT = {
    "food": "not enough suitable food in time",
    "transport": "every runner is busy or too far away",
    "time": "no food can reach the gate before its deadline or use-by time",
    "receiving capacity": "the gate cannot receive more food",
  };

  const state = { night: null, t: 30, playing: false, speed: 1, tab: "gates", openTrip: null, hlTrip: null };
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, html = "") => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    if (html) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const clock = (t) => {
    const m = Math.round(t) + 20 * 60;
    return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const entity = (id) => state.night.entities.find((e) => e.id === id);
  const gateName = (key) => state.night.hospitals[key].name;
  const gateShort = (key) => state.night.hospitals[key].short;
  const runnerName = (id) => entity(id)?.data.name ?? id;
  const runnerNo = (id) => runnerName(id).replace(/\D+/g, "") || "R";

  // ------------------------------------------------------------------ API

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Refresh the page and try again.");
    return data;
  }

  async function load() {
    state.night = await api("/api/night");
    renderAll();
  }

  async function change(path, body, success) {
    const before = state.night?.summary.planned;
    try {
      state.night = await api(path, body);
      renderAll();
      const s = state.night.summary;
      toast(success(s, before));
      const band = $(".status");
      band.classList.add("flash");
      setTimeout(() => band.classList.remove("flash"), 900);
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  // ------------------------------------------------------------------ status

  function renderStatus() {
    const { summary, baseline } = state.night;
    const short = summary.unmet;
    $("#coverage").textContent = `${summary.planned} / ${summary.requested}`;
    const uncovered = summary.requested - summary.planned;
    $("#shortfall-count").textContent = uncovered;
    $(".shortfall-readout").classList.toggle("uncovered", uncovered > 0);
    $("#headline").textContent = `${summary.planned} of ${summary.requested} meals planned for tonight`;
    if (!short.length) {
      $("#subline").textContent = "Every gate request is covered by the current plan.";
      $("#alertline").hidden = true;
    } else {
      $("#subline").textContent = short.map((u) =>
        `${gateShort(u.gate)} is ${u.portions} short because ${REASON_TEXT[u.reason]}.`).join(" ");
      const alert = $("#alertline");
      alert.hidden = false;
      alert.textContent = `Generated partner alert: ${short.map((u) => u.alert).join("; ")}`;
    }
    const max = Math.max(summary.requested, 1);
    $("#compare").innerHTML = `
      <p class="compare-title">Plan comparison · Same night, same inputs</p>
      <div class="bar-row ours"><span class="name">OotaPass</span>
        <span class="track"><span class="fill" style="width:${(summary.planned / max) * 100}%"></span></span>
        <span class="val">${summary.planned}/${summary.requested}</span></div>
      <div class="bar-row"><span class="name">Nearest-first</span>
        <span class="track"><span class="fill" style="width:${(baseline.planned / max) * 100}%"></span></span>
        <span class="val">${baseline.planned}/${baseline.requested}</span></div>`;
  }

  // ------------------------------------------------------------------ timeline

  const tripStatus = (trip, t) => (t >= trip.arrive ? "done" : t >= trip.depart ? "moving" : "planned");

  function renderTimeline() {
    const axis = $("#axis");
    axis.innerHTML = "";
    for (let m = 0; m <= NIGHT_END; m += 15) {
      const x = (m / NIGHT_END) * 100;
      axis.append(el("span", { class: `tick${m % 60 === 0 ? " hour" : ""}`, style: `left:${x}%` }));
      if (m % 60 === 0) axis.append(el("span", { class: "tick-label", style: `left:${x}%` }, m === NIGHT_END ? "00:00" : clock(m)));
    }
    for (const a of state.night.activity) {
      if (a.t > 0 && (a.kind === "cancelled" || a.kind === "rejected" || a.kind === "logged")) {
        axis.append(el("span", { class: `event-mark ${a.kind}`, style: `left:${(a.t / NIGHT_END) * 100}%`, title: `${clock(a.t)} ${a.text}` }));
      }
    }

    const lanes = $("#lanes");
    lanes.innerHTML = "";
    const requests = state.night.entities.filter((e) => e.kind === "request");
    for (const r of requests) {
      const d = r.data;
      const lane = el("div", { class: "lane" });
      lane.append(el("div", { class: "lane-label" },
        `<b>${esc(gateShort(d.gate))}</b><span>${d.portions} meals by ${clock(d.need_by)}</span>`));
      const track = el("div", { class: "lane-track" });
      track.append(el("div", { class: "deadline", style: `left:${(d.need_by / NIGHT_END) * 100}%`, title: `Needed by ${clock(d.need_by)}` }));
      // Stack overlapping trips in sub-rows so no bar hides another.
      const rowsEnd = [];
      const laneTrips = state.night.trips.filter((x) => x.request === r.id).sort((a, b) => a.depart - b.depart);
      const rowOf = {};
      for (const trip of laneTrips) {
        let i = rowsEnd.findIndex((end) => end <= trip.depart - 2);
        if (i === -1) { i = rowsEnd.length; rowsEnd.push(0); }
        rowsEnd[i] = trip.arrive;
        rowOf[trip.id] = i;
      }
      const subRows = Math.max(rowsEnd.length, 1);
      lane.style.minHeight = `${Math.max(38, 12 + subRows * 22)}px`;
      for (const trip of laneTrips) {
        const left = (trip.depart / NIGHT_END) * 100;
        const width = Math.max(((trip.arrive - trip.depart) / NIGHT_END) * 100, 0.8);
        const carryPct = ((trip.arrive - trip.pickup) / Math.max(trip.arrive - trip.depart, 1)) * 100;
        const bar = el("button", {
          class: `trip-bar${state.t >= trip.arrive ? " done" : ""}${state.hlTrip === trip.id ? " hl" : ""}`,
          style: `left:${left}%;width:${width}%;top:${(100 / (subRows + 1)) * (rowOf[trip.id] + 1)}%;transform:translateY(-50%)`, "data-trip": trip.id,
          "aria-label": `${runnerName(trip.runner)} carries ${trip.portions} meals to ${gateShort(trip.gate)}, arriving ${clock(trip.arrive)}`,
          onclick: () => openPassport(trip.id),
          onmouseenter: () => highlight(trip.id), onmouseleave: () => highlight(null),
        }, `<span class="carry" style="width:${carryPct}%"></span>`);
        track.append(bar);
        track.append(el("span", { class: "trip-tag", style: `left:calc(${left + width}% + 6px);top:${(100 / (subRows + 1)) * (rowOf[trip.id] + 1)}%` },
          `R${runnerNo(trip.runner)}, ${trip.portions} meals`));
      }
      const unmet = state.night.summary.unmet.filter((u) => u.request === r.id).reduce((s, u) => s + u.portions, 0);
      if (unmet) track.append(el("span", { class: "lane-short" }, `${unmet} short`));
      lane.append(track);
      lanes.append(lane);
    }
    placeNowline();
  }

  function placeNowline() {
    const axis = $("#axis");
    if (!state.night) return;
    const x = axis.offsetLeft + (state.t / NIGHT_END) * axis.clientWidth;
    $("#nowline").style.left = `${x - 1}px`;
    axis.setAttribute("aria-valuenow", Math.round(state.t));
    axis.setAttribute("aria-valuetext", clock(state.t));
    $("#clock").textContent = clock(state.t);
    document.querySelectorAll("[data-clock]").forEach((n) => (n.textContent = clock(state.t)));
    const delivered = state.night.trips.filter((x) => x.arrive <= state.t).reduce((s, x) => s + x.portions, 0);
    $("#delivered").innerHTML = `Simulated arrivals by ${clock(state.t)}: <strong>${delivered}</strong> of ${state.night.summary.planned} planned`;
    document.querySelectorAll(".trip-bar").forEach((b) => {
      const trip = state.night.trips.find((x) => x.id === b.dataset.trip);
      if (trip) b.classList.toggle("done", state.t >= trip.arrive);
    });
  }

  function setTime(t) {
    state.t = Math.min(Math.max(t, 0), NIGHT_END);
    placeNowline();
    moveRunners();
    updateTripPills();
  }

  function bindScrub() {
    const axis = $("#axis");
    const fromEvent = (e) => {
      const r = axis.getBoundingClientRect();
      return ((e.clientX - r.left) / r.width) * NIGHT_END;
    };
    let dragging = false;
    axis.addEventListener("pointerdown", (e) => { dragging = true; axis.setPointerCapture(e.pointerId); setTime(fromEvent(e)); });
    axis.addEventListener("pointermove", (e) => dragging && setTime(fromEvent(e)));
    axis.addEventListener("pointerup", () => (dragging = false));
    axis.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 15 : 5;
      if (e.key === "ArrowRight") { setTime(state.t + step); e.preventDefault(); }
      if (e.key === "ArrowLeft") { setTime(state.t - step); e.preventDefault(); }
    });
    window.addEventListener("resize", placeNowline);
  }

  let last = 0;
  function tick(now) {
    if (!state.playing) return;
    if (last) {
      const minutesPerSecond = 4 * state.speed;
      setTime(state.t + ((now - last) / 1000) * minutesPerSecond);
      if (state.t >= NIGHT_END) togglePlay(false);
    }
    last = now;
    requestAnimationFrame(tick);
  }
  function togglePlay(force) {
    state.playing = force ?? !state.playing;
    const btn = $("#play");
    btn.setAttribute("aria-pressed", String(state.playing));
    btn.setAttribute("aria-label", state.playing ? "Pause the night" : "Play the night");
    btn.innerHTML = state.playing
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4h4v12H5zM11 4h4v12h-4z"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg>';
    if (state.playing) {
      if (state.t >= NIGHT_END) setTime(0);
      last = 0;
      requestAnimationFrame(tick);
    }
  }

  // ------------------------------------------------------------------ map

  let passportTrigger = null;
  let map, layers = {}, runnerMarkers = {}, routeLines = {};

  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([12.94, 77.583], 14);
    // OpenStreetMap's standard tiles need no API key. CSS softens them to grey so our markers stand out.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layers.routes = L.layerGroup().addTo(map);
    layers.places = L.layerGroup().addTo(map);
    layers.runners = L.layerGroup().addTo(map);
    // Keep every place in view when the layout around the map changes size.
    new ResizeObserver(() => {
      if (!document.getElementById("map").clientWidth) return;
      map.invalidateSize();
      if (map._bounds?.length) map.fitBounds(map._bounds, { padding: [48, 48] });
    }).observe(document.getElementById("map"));
  }

  function renderMap() {
    const { entities, hospitals, areas, trips, summary } = state.night;
    layers.routes.clearLayers();
    layers.places.clearLayers();
    layers.runners.clearLayers();
    routeLines = {};
    runnerMarkers = {};
    const bounds = [];

    for (const trip of trips) {
      const approach = L.polyline([trip.from, trip.donor_loc], { color: "#7A8496", weight: 2, dashArray: "2 6", opacity: 0.8 });
      const carry = L.polyline([trip.donor_loc, trip.gate_loc], { color: "#E2A11B", weight: 3.5, dashArray: "8 7", opacity: 0.9 });
      carry.on("mouseover", () => highlight(trip.id)).on("mouseout", () => highlight(null)).on("click", () => openPassport(trip.id));
      layers.routes.addLayer(approach).addLayer(carry);
      routeLines[trip.id] = carry;
    }

    const shortGates = new Set(summary.unmet.map((u) => u.gate));
    const usedGates = new Set(entities.filter((e) => e.kind === "request").map((e) => e.data.gate));
    for (const g of usedGates) {
      const h = hospitals[g];
      const m = L.marker(h.loc, { icon: L.divIcon({ className: "", html: `<div class="m-gate${shortGates.has(g) ? " short" : ""}"><span aria-hidden="true">${h.short[0]}</span><span class="sr-only">${esc(h.name)}</span></div>`, iconSize: [32, 32], iconAnchor: [16, 16] }) });
      m.bindTooltip(h.name, { direction: "top", offset: [0, -14] });
      layers.places.addLayer(m);
      bounds.push(h.loc);
    }
    for (const e of entities.filter((x) => x.kind === "donor")) {
      const off = e.cancelled_at !== null && e.cancelled_at !== undefined;
      const letter = state.night.kinds[e.data.kind][0];
      const m = L.marker(areas[e.data.area], { icon: L.divIcon({ className: "", html: `<div class="m-donor${off ? " off" : ""}"><span aria-hidden="true">${letter}</span><span class="sr-only">${esc(e.data.name)}: ${e.data.portions} meals</span></div>`, iconSize: [28, 28], iconAnchor: [14, 14] }) });
      m.bindTooltip(`${esc(e.data.name)}: ${e.data.portions} meals of ${esc(e.data.item.toLowerCase())}${off ? " (cancelled)" : ""}`, { direction: "top", offset: [0, -12] });
      layers.places.addLayer(m);
      bounds.push(areas[e.data.area]);
    }
    entities.filter((x) => x.kind === "runner").forEach((e, i) => {
      const off = e.cancelled_at !== null && e.cancelled_at !== undefined;
      // Runners float just above-right of their position, spread apart so two at one gate stay readable.
      const m = L.marker(areas[e.data.area], {
        icon: L.divIcon({ className: "", html: `<div class="m-runner${off ? " off" : ""}">R${runnerNo(e.id)}</div>`, iconSize: [24, 24], iconAnchor: [-6 - i * 26, 30] }),
        zIndexOffset: 1000, keyboard: false,
      });
      m.bindTooltip(esc(e.data.name), { direction: "top", offset: [0, -10] });
      layers.runners.addLayer(m);
      runnerMarkers[e.id] = m;
    });
    map._bounds = bounds;
    map.invalidateSize();
    if (!map._fitted && bounds.length) { map.fitBounds(bounds, { padding: [48, 48] }); map._fitted = true; }
    moveRunners();
  }

  const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

  function runnerPosition(runnerId, t) {
    const e = entity(runnerId);
    let pos = state.night.areas[e.data.area];
    const trips = state.night.trips.filter((x) => x.runner === runnerId).sort((a, b) => a.depart - b.depart);
    for (const trip of trips) {
      if (t < trip.depart) break;
      if (t < trip.at_donor) return lerp(trip.from, trip.donor_loc, (t - trip.depart) / Math.max(trip.at_donor - trip.depart, 0.01));
      if (t < trip.pickup) return trip.donor_loc;
      if (t < trip.arrive) return lerp(trip.donor_loc, trip.gate_loc, (t - trip.pickup) / Math.max(trip.arrive - trip.pickup, 0.01));
      pos = trip.gate_loc;
    }
    return pos;
  }

  function moveRunners() {
    for (const [id, marker] of Object.entries(runnerMarkers)) marker.setLatLng(runnerPosition(id, state.t));
    for (const trip of state.night.trips) {
      const line = routeLines[trip.id];
      if (!line) continue;
      const done = state.t >= trip.arrive;
      line.setStyle(done ? { color: "#8AAEFF", dashArray: null, opacity: 0.45 } : { color: "#E2A11B", dashArray: "8 7", opacity: 0.9 });
    }
  }

  function highlight(id) {
    state.hlTrip = id;
    document.querySelectorAll(".trip-bar").forEach((b) => b.classList.toggle("hl", b.dataset.trip === id));
    document.querySelectorAll(".trip-row").forEach((b) => b.classList.toggle("hl", b.dataset.trip === id));
    for (const [tid, line] of Object.entries(routeLines)) {
      line.setStyle({ weight: tid === id ? 6 : 3.5 });
      if (tid === id) line.bringToFront();
    }
  }

  // ------------------------------------------------------------------ panel: gates

  function renderGates() {
    const root = $("#tab-gates");
    root.innerHTML = "";
    const requests = state.night.entities.filter((e) => e.kind === "request").sort((a, b) => a.data.need_by - b.data.need_by);
    if (!requests.length) root.append(el("p", { class: "empty" }, "No hospital-gate requests yet. Log a request to plan the night."));
    requests.forEach((r, index) => {
      const d = r.data;
      const trips = state.night.trips.filter((x) => x.request === r.id);
      const planned = trips.reduce((sum, x) => sum + x.portions, 0);
      const delivered = trips.filter((x) => x.arrive <= state.t).reduce((sum, x) => sum + x.portions, 0);
      const unmet = state.night.summary.unmet.filter((u) => u.request === r.id);
      const shortBy = unmet.reduce((sum, u) => sum + u.portions, 0);
      const pct = (n) => (n / Math.max(d.portions, 1)) * 100;
      const row = el("article", { class: `gate-row${shortBy ? " has-shortfall" : ""}` });
      row.innerHTML = `
        <div class="gate-index">${String(index + 1).padStart(2, "0")}</div>
        <div class="gate-content"><div class="gate-heading"><div><h3>${esc(gateName(d.gate))}</h3><p class="need">${d.veg_only ? "Vegetarian only" : "Any food"} · Receives up to ${d.capacity} meals</p></div><span class="gate-deadline">${icon("clock")}By ${clock(d.need_by)}</span></div>
        <div class="gate-allocation"><div><strong>${planned}<span> / ${d.portions}</span></strong><span>meals allocated</span></div><span class="allocation-status${shortBy ? " short" : ""}">${shortBy ? `${shortBy} uncovered` : "Fully planned"}</span></div>
        <div class="meter" role="img" aria-label="${delivered} simulated arrivals, ${planned} planned, ${shortBy} short of ${d.portions}"><i class="m-delivered" style="width:${pct(delivered)}%"></i><i class="m-planned" style="width:${pct(planned - delivered)}%"></i><i class="m-short" style="width:${pct(shortBy)}%"></i></div>
        <p class="facts">${trips.length} planned trip${trips.length === 1 ? "" : "s"} <span>·</span> ${delivered} simulated arrivals by ${clock(state.t)}</p>
        ${unmet.map((u) => `<div class="reason"><b>${REASON_LABEL[u.reason]} · ${u.portions} meals short</b><span>${REASON_TEXT[u.reason]}</span><small>Generated alert: ${esc(u.alert)}</small></div>`).join("")}
        <div class="gate-dispatches" aria-label="Trips to ${esc(gateShort(d.gate))}"></div></div>`;
      for (const trip of trips) row.querySelector(".gate-dispatches").append(el("button", { class: "gate-trip", onclick: () => openPassport(trip.id) }, `${icon("route")}<span>${esc(runnerName(trip.runner))} · ${trip.portions} meals</span><span>${clock(trip.arrive)} ${icon("arrow")}</span>`));
      root.append(row);
    });
  }

  // ------------------------------------------------------------------ panel: trips

  function tripPill(trip) {
    if (state.t >= trip.arrive) return '<span class="pill done">Arrived · Sim.</span>';
    if (state.t >= trip.depart) return '<span class="pill moving">Moving · Sim.</span>';
    if (trip.check?.decision === "accepted") return '<span class="pill accepted">Checked</span>';
    return '<span class="pill planned">Planned</span>';
  }

  function renderTrips() {
    const root = $("#tab-trips");
    root.innerHTML = "";
    if (!state.night.trips.length) {
      root.append(el("p", { class: "empty" }, "No feasible trips in the current plan. Check gate shortfall reasons and available surplus or runners."));
      return;
    }
    root.append(el("div", { class: "trip-table-heading", "aria-hidden": "true" }, "<span>Pickup / arrival</span><span>Food, route &amp; runner</span><span>Plan status</span>"));
    for (const trip of state.night.trips) {
      const donor = entity(trip.donor).data;
      const row = el("button", {
        class: "trip-row", "data-trip": trip.id,
        onclick: () => openPassport(trip.id), onmouseenter: () => highlight(trip.id), onmouseleave: () => highlight(null),
      }, `
        <span class="times">${clock(trip.pickup)}<span>→ ${clock(trip.arrive)}</span></span>
        <span class="trip-content"><span class="what">${trip.portions} meals of ${esc(trip.item.toLowerCase())}</span><span class="route">${esc(donor.name)} ${icon("arrow")} ${esc(gateShort(trip.gate))}</span><span class="runner-meta">${esc(runnerName(trip.runner))} · Food passport ${trip.id}</span></span>
        <span class="trip-status" data-pill>${tripPill(trip)}<span class="open-passport">Open passport ↗</span></span>`);
      root.append(row);
    }
  }

  function updateTripPills() {
    document.querySelectorAll(".trip-row").forEach((row) => {
      const trip = state.night.trips.find((x) => x.id === row.dataset.trip);
      if (trip) row.querySelector("[data-pill]").innerHTML = tripPill(trip) + '<span class="open-passport">Open passport ↗</span>';
    });
    if (state.tab === "gates") renderGates();
  }

  // ------------------------------------------------------------------ panel: supply

  function renderSupply() {
    const root = $("#tab-supply");
    root.innerHTML = "";
    const donors = state.night.entities.filter((e) => e.kind === "donor");
    const runners = state.night.entities.filter((e) => e.kind === "runner");
    root.append(el("div", { class: "section-title supply-section" }, `${icon("food")}<div><h3>Food batches</h3><p>Donor-declared availability and use-by times</p></div>`));
    for (const e of donors) {
      const d = e.data;
      const used = state.night.trips.filter((x) => x.donor === e.id).reduce((s, x) => s + x.portions, 0);
      const off = e.cancelled_at !== null && e.cancelled_at !== undefined;
      const row = el("div", { class: `supply-row${off ? " off" : ""}` });
      row.innerHTML = `
        <div class="supply-detail">
          <h3>${esc(d.name)}<span class="tag ${d.veg ? "veg" : "nonveg"}">${d.veg ? "Veg" : "Non-veg"}</span></h3>
          <p class="meta">${esc(state.night.kinds[d.kind])} · ${esc(d.area)}</p>
          <p class="food-description">${d.portions} meals of ${esc(d.item.toLowerCase())}</p>
          <dl class="supply-facts"><div><dt>Ready</dt><dd>${clock(d.ready)}</dd></div><div><dt>Use by</dt><dd>${clock(d.last_use)}</dd></div><div><dt>Allocated</dt><dd>${used} / ${d.portions}</dd></div></dl>
          ${off ? `<p class="off-note">Cancelled at ${clock(e.cancelled_at)}</p>` : ""}
        </div>`;
      if (!off) row.append(cancelControl(e, "Cancel donation", () => `Cancel at ${clock(state.t)}?`));
      root.append(row);
    }
    root.append(el("div", { class: "section-title supply-section" }, `${icon("route")}<div><h3>NGO runners</h3><p>Carrying capacity and tonight’s assignments</p></div>`));
    for (const e of runners) {
      const d = e.data;
      const count = state.night.trips.filter((x) => x.runner === e.id).length;
      const off = e.cancelled_at !== null && e.cancelled_at !== undefined;
      const row = el("div", { class: `supply-row${off ? " off" : ""}` });
      row.innerHTML = `
        <div class="supply-detail">
          <h3>${esc(d.name)}</h3>
          <p class="meta">Starts in ${esc(d.area)}, carries up to ${d.capacity} meals, ${count} trip${count === 1 ? "" : "s"} tonight.</p>
          ${off ? `<p class="off-note">Dropped out at ${clock(e.cancelled_at)}</p>` : ""}
        </div>`;
      if (!off) row.append(cancelControl(e, "Mark dropped out", () => `Dropped out at ${clock(state.t)}?`));
      root.append(row);
    }
  }

  function cancelControl(e, label, question) {
    const wrap = el("div", { class: "confirm" });
    const start = el("button", { class: "btn danger small" }, label);
    start.addEventListener("click", () => {
      wrap.innerHTML = "";
      wrap.append(el("span", {}, esc(question())));
      const btns = el("div", { class: "btns" });
      btns.append(
        el("button", { class: "btn ghost small", onclick: () => renderSupply() }, "Keep"),
        el("button", {
          class: "btn danger small",
          onclick: () => change("/api/cancel", { id: e.id, t: state.t }, (s, before) =>
            `Re-planned from ${clock(state.t)}. ${s.planned} of ${s.requested} meals now reach the gates${before !== undefined && before !== s.planned ? ` (was ${before})` : ""}.`),
        }, "Confirm"),
      );
      wrap.append(btns);
      btns.lastChild.focus();
    });
    wrap.append(start);
    return wrap;
  }

  // ------------------------------------------------------------------ panel: activity

  function renderActivity() {
    const root = $("#tab-activity");
    root.innerHTML = "";
    const items = state.night.activity;
    if (!items.length) {
      root.append(el("p", { class: "empty" }, "Nothing has changed since the plan was made. Cancellations, new requests and pickup checks will appear here."));
      return;
    }
    for (const a of items) {
      const row = el("div", { class: `act ${a.kind}` });
      row.innerHTML = `<time>${clock(a.t)}</time><div><p>${esc(a.text)}</p>
        ${a.result ? `<p class="result">Re-planned: ${esc(a.result)}</p>` : ""}
        ${(a.alerts || []).map((x) => `<p class="alert">Generated alert: ${esc(x)}</p>`).join("")}</div>`;
      root.append(row);
    }
  }

  // ------------------------------------------------------------------ tabs

  function bindTabs() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        $(`#${t.getAttribute("aria-controls")}`).hidden = !on;
      });
      state.tab = tab.id.slice(2);
      closePassport();
      $("#app-shell").dataset.view = state.tab;
      const copy = { gates: ["Night board", "Receiving tonight", "Hospital gates", "Ordered by deadline"], trips: ["Dispatch trips", "Moving food", "Tonight’s dispatch manifest", "By pickup time · Open a trip for its passport"], supply: ["Food & runners", "Available tonight", "Food batches & carrying capacity", "Donor declarations · NGO runners"], activity: ["Activity log", "Changes to the plan", "The night’s decision trail", "Requests, cancellations & pickup checks"] }[state.tab];
      ["view-title", "panel-kicker", "panel-title", "panel-note"].forEach((id, i) => $("#" + id).textContent = copy[i]);
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        const dir = ["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 0;
        if (dir) { e.preventDefault(); const n = tabs[(i + dir + tabs.length) % tabs.length]; select(n); n.focus(); }
      });
    });
  }

  function updateTabCounts() {
    const set = (id, n) => $(id).querySelector(".count").textContent = n;
    set("#t-gates", state.night.entities.filter((e) => e.kind === "request").length);
    set("#t-trips", state.night.trips.length);
    set("#t-supply", state.night.entities.filter((e) => e.kind === "donor").length);
    set("#t-activity", state.night.activity.length);
  }

  // ------------------------------------------------------------------ passport

  function openPassport(id) {
    const trip = state.night.trips.find((x) => x.id === id);
    if (!trip) return;
    if (!state.openTrip) passportTrigger = document.activeElement;
    state.openTrip = id;
    const donor = entity(trip.donor).data;
    const check = trip.check;
    const kind = state.night.kinds[donor.kind];
    const picked = state.t >= trip.pickup;
    const delivered = state.t >= trip.arrive;
    const body = $("#drawer-body");
    body.innerHTML = `
      <div class="pp-top passport-paper">
        <div>
          <p class="passport-batch">Batch · ${esc(trip.id)}</p><h2 id="pp-title">${trip.portions} meals of ${esc(trip.item.toLowerCase())}</h2>
          <p class="sub">${esc(donor.name)} to ${esc(gateName(trip.gate))}</p>
        </div>
        <figure class="qr"><img width="112" height="112" src="/api/qr/${trip.id}.svg" alt="QR code linking to this food passport"><figcaption>Food passport QR</figcaption></figure>
      </div>
      <table class="fields">
        <tr><th>Food</th><td>${esc(donor.item)}</td></tr>
        <tr><th>Source</th><td>${esc(donor.name)}, ${esc(kind.toLowerCase())} in ${esc(donor.area)}</td></tr>
        <tr><th>Ready at</th><td>${clock(donor.ready)}</td></tr>
        <tr class="useby-field"><th>Use by (declared by donor)</th><td>${clock(donor.last_use)}</td></tr>
        <tr><th>Food type</th><td>${donor.veg ? "Vegetarian" : "Non-vegetarian"}</td></tr>
        <tr><th>Meals in this batch</th><td>${trip.portions}</td></tr>
        <tr><th>Carried by</th><td>${esc(runnerName(trip.runner))}</td></tr>
      </table>
      <ol class="custody" aria-label="Chain of custody">
        <li class="done"><b>Logged by donor</b><span>${donor.portions} meals offered, ready ${clock(donor.ready)}</span></li>
        <li class="${check?.decision === "accepted" ? "done" : ""}"><b>Pickup check by the NGO at ${clock(trip.pickup)}</b>
          <span>${check?.decision === "accepted" ? "Accepted" : "Waiting for the runner's check"}</span></li>
        <li class="${delivered ? "done" : ""}"><b>Planned handover · ${esc(gateShort(trip.gate))} at ${clock(trip.arrive)}</b>
          <span>${delivered ? "Arrived in simulation; not a delivery confirmation" : picked ? "Moving in simulation" : "Planned; not yet simulated"}</span></li>
      </ol>
      ${check?.decision === "accepted"
        ? `<p class="decision accepted">The NGO accepted this batch at the pickup check.</p>`
        : `<div class="checklist">
            <h3>Pickup check</h3>
            <label><input type="checkbox" data-item="label"> Label matches the food</label>
            <label><input type="checkbox" data-item="time"> Still before the use-by time</label>
            <label><input type="checkbox" data-item="covered"> Packed in covered containers</label>
            <label><input type="checkbox" data-item="sense"> Looks and smells normal</label>
            <div class="btns">
              <button class="btn primary small" id="pp-accept" disabled>Accept batch</button>
              <button class="btn danger small" id="pp-reject">Reject batch</button>
            </div>
          </div>`}
      <p class="disclaimer">OotaPass records each decision. It does not certify food as safe: the donor is responsible until handover, and the registered NGO after it accepts the batch.</p>
      <a class="print-link" href="/passport/${trip.id}" target="_blank" rel="noopener">Open printable label</a>`;
    const drawer = $("#drawer");
    drawer.hidden = false;
    if (!drawer.open) drawer.showModal();
    $(".tabpanels").inert = true;
    highlight(id);
    const boxes = [...body.querySelectorAll(".checklist input")];
    const accept = $("#pp-accept", body);
    const items = () => Object.fromEntries(boxes.map((b) => [b.dataset.item, b.checked]));
    boxes.forEach((b) => b.addEventListener("change", () => (accept.disabled = !boxes.every((x) => x.checked))));
    accept?.addEventListener("click", async () => {
      if (await change(`/api/trips/${trip.id}/check`, { decision: "accepted", items: items() }, () => "Batch accepted at the pickup check.")) openPassport(trip.id);
    });
    $("#pp-reject", body)?.addEventListener("click", async () => {
      if (await change(`/api/trips/${trip.id}/check`, { decision: "rejected", items: items() },
        (s) => `Batch rejected and removed. Re-planned: ${s.planned} of ${s.requested} meals now reach the gates.`)) closePassport();
    });
    $("#drawer-close").focus({ preventScroll: true });

  }

  function closePassport() {
    $("#drawer").close();
    $("#drawer").hidden = true;
    $(".tabpanels").inert = false;
    state.openTrip = null;
    if (passportTrigger?.isConnected) passportTrigger.focus({ preventScroll: true });
    passportTrigger = null;
    highlight(null);
  }

  // ------------------------------------------------------------------ dialogs

  function bindDialogs() {
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
      const d = $(`#${b.dataset.open}`);
      if (d.id === "evidence") renderEvidence();
      d.querySelectorAll(".form-error").forEach((x) => (x.hidden = true));
      d.showModal();
    }));

    const gateSel = $('#request-form select[name="gate"]');
    const fillSelects = () => {
      gateSel.innerHTML = Object.entries(state.night.hospitals).map(([k, h]) => `<option value="${k}">${esc(h.name)}</option>`).join("");
      $('#surplus-form select[name="kind"]').innerHTML = Object.entries(state.night.kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
      $('#surplus-form select[name="area"]').innerHTML = Object.keys(state.night.areas).map((a) => `<option>${esc(a)}</option>`).join("");
    };
    fillSelects();

    const submit = (form, path, build, message) => form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = form.querySelector(".form-error");
      const fd = new FormData(form);
      const button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = "Saving and re-planning…";
      form.setAttribute("aria-busy", "true");
      try {
        state.night = await api(path, { ...build(fd), t: state.t });
        err.hidden = true;
        form.closest("dialog").close();
        renderAll();
        toast(message(state.night.summary));
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        err.focus();
      } finally {
        button.disabled = false;
        button.textContent = label;
        form.removeAttribute("aria-busy");
      }
    });

    submit($("#request-form"), "/api/requests", (fd) => ({
      gate: fd.get("gate"), portions: fd.get("portions"), need_by: fd.get("need_by"),
      capacity: fd.get("capacity"), veg_only: fd.get("veg_only") === "on",
    }), (s) => `Request logged. ${s.planned} of ${s.requested} meals now reach the gates.`);

    submit($("#surplus-form"), "/api/donations", (fd) => ({
      name: fd.get("name"), kind: fd.get("kind"), area: fd.get("area"), item: fd.get("item"),
      portions: fd.get("portions"), ready: fd.get("ready"), last_use: fd.get("last_use"), veg: fd.get("veg") === "on",
    }), (s) => `Surplus logged. ${s.planned} of ${s.requested} meals now reach the gates.`);

    $("#reset").addEventListener("click", async () => {
      state.t = 30;
      map._fitted = false;
      await change("/api/reset", {}, () => "Demo night reset to 20:30.");
    });
    $("#drawer-close").addEventListener("click", closePassport);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawer").open) { e.preventDefault(); closePassport(); } });
    $("#play").addEventListener("click", () => togglePlay());
    $("#speed").addEventListener("change", (e) => (state.speed = Number(e.target.value)));
  }

  async function renderEvidence() {
    const root = $("#evidence-body");
    const { summary, baseline } = state.night;
    let bench = null;
    try { bench = await api("/api/benchmark"); } catch (_) { /* shown below */ }
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    root.innerHTML = `
      <div class="ev-grid">
        <div class="ev">
          <h3>Tonight, on this demo night</h3>
          <p class="big">${summary.planned}<small>of ${summary.requested} meals with OotaPass</small></p>
          <p class="big" style="color:var(--ink-3)">${baseline.planned}<small>with nearest-first</small></p>
          <p style="margin-top:8px">Nearest-first serves requests in the order they were logged and always grabs the closest food. OotaPass plans the whole night from the gates' deadlines.</p>
        </div>
        <div class="ev">
          <h3>Across ${bench ? bench.nights : 500} random nights</h3>
          ${bench ? `
          <div class="bar-row ours"><span class="name">OotaPass</span><span class="track"><span class="fill" style="width:${bench.coverage_ootapass * 100}%"></span></span><span class="val">${pct(bench.coverage_ootapass)}</span></div>
          <div class="bar-row"><span class="name">Nearest-first</span><span class="track"><span class="fill" style="width:${bench.coverage_nearest_first * 100}%"></span></span><span class="val">${pct(bench.coverage_nearest_first)}</span></div>
          <p>Average share of requested meals delivered. Both methods got exactly the same nights (seed ${bench.seed}).</p>
          <div class="nights">
            <div><b>${bench.more}</b><span>nights with more meals</span></div>
            <div><b>${bench.same}</b><span>nights with the same</span></div>
            <div><b>${bench.fewer}</b><span>nights with fewer</span></div>
          </div>
          <p style="margin-top:8px">Travel per delivered meal: ${bench.km_per_meal_ootapass} km vs ${bench.km_per_meal_nearest_first} km.</p>` :
          `<p>Run <code>python -m bench.benchmark</code> to generate the benchmark.</p>`}
        </div>
      </div>
      <div class="ev" style="margin-top:20px">
        <h3>The planner's rules, in order</h3>
        <ol>
          <li>Serve gate requests in order of deadline, most urgent first.</li>
          <li>Plan a trip only if it arrives before the gate's deadline and the donor's declared use-by time, within the runner's shift, bag size and the gate's receiving capacity.</li>
          <li>Give non-veg food to gates that accept anything, to save veg food for veg-only gates.</li>
          <li>Pick the trip that carries the most food; on a tie, the one with the least travel.</li>
          <li>Name the reason for every shortfall: receiving capacity, food, transport or time.</li>
          <li>When a donor or runner cancels, keep trips already picked up and re-plan the rest from that minute.</li>
        </ol>
      </div>
      <p class="synthetic-note">All data here is synthetic. ${bench ? esc(bench.assumptions) : ""} The results test the planning logic, not real-world impact.</p>`;
  }

  // ------------------------------------------------------------------ toasts

  function toast(message, error = false) {
    const t = el("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" }, esc(message));
    $("#toasts").append(t);
    setTimeout(() => t.remove(), 4200);
  }

  // ------------------------------------------------------------------ render

  function renderAll() {
    renderStatus();
    renderTimeline();
    renderMap();
    renderGates();
    renderTrips();
    renderSupply();
    renderActivity();
    updateTabCounts();
    if (state.openTrip) {
      if (state.night.trips.some((x) => x.id === state.openTrip)) openPassport(state.openTrip); else closePassport();
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    bindTabs();
    bindScrub();
    try {
      await load();
      bindDialogs();
      if (REDUCED) $("#speed").value = "4";
    } catch (err) {
      $("#headline").textContent = "The plan could not be loaded.";
      $("#subline").textContent = `${err.message} Check that the server is running with python app.py.`;
    }
  });
})();
