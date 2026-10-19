(async function main() {
  const $ = id => document.getElementById(id);
  const classColor = Object.fromEntries(CONFIG.coverClasses.map(c => [c.name, c.color]));
  const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));

  // ---- Geometry helpers (GeoJSON, lon/lat) ----

  const rad = d => (d * Math.PI) / 180;

  // Geodesic ring area in m2 (same formula as Leaflet.draw and Turf).
  function ringArea(ring) {
    const R = 6378137;
    let total = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      total += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
    }
    return Math.abs((total * R * R) / 2);
  }

  const polygons = geom => (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates);

  function areaAcres(geom) {
    const m2 = polygons(geom).reduce((sum, rings) =>
      sum + ringArea(rings[0]) - rings.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);
    return m2 / 4046.856;
  }

  // Area-weighted centroid of the outer rings; good enough at field scale.
  function centroid(geom) {
    let a = 0, cx = 0, cy = 0;
    for (const rings of polygons(geom)) {
      const ring = rings[0];
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const f = x1 * y2 - x2 * y1;
        a += f;
        cx += (x1 + x2) * f;
        cy += (y1 + y2) * f;
      }
    }
    if (a === 0) {
      const ring = polygons(geom)[0][0];
      return ring[0];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  function pointInGeometry([x, y], geom) {
    let inside = false;
    for (const rings of polygons(geom)) {
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
    }
    return inside;
  }

  function toWkt(geom) {
    const ring = r => `(${r.map(([x, y]) => `${x} ${y}`).join(", ")})`;
    const poly = rings => `(${rings.map(ring).join(", ")})`;
    return geom.type === "Polygon"
      ? `POLYGON ${poly(geom.coordinates)}`
      : `MULTIPOLYGON (${geom.coordinates.map(poly).join(", ")})`;
  }

  // ---- UI basics ----

  let toastTimer;
  function toast(message, kind = "info") {
    const el = $("toast");
    el.textContent = message;
    el.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ""), 4000);
  }

  function showTab(id) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === id));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
    if (id === "map-view") map.invalidateSize();
  }
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => showTab(t.dataset.tab)));

  for (const c of CONFIG.coverClasses) {
    $("cover-class").add(new Option(c.name, c.name));
    $("tips").insertAdjacentHTML("beforeend",
      `<p><span class="swatch" style="background:${c.color}"></span><strong>${escapeHtml(c.name)}</strong><br>${escapeHtml(c.tip)}</p>`);
  }
  $("tips").insertAdjacentHTML("beforeend", `<p><strong>General:</strong> ${escapeHtml(CONFIG.generalTip)}</p>`);

  $("annotator").value = localStorage.getItem("tpos_annotator") || "";
  $("annotator").addEventListener("change", e => localStorage.setItem("tpos_annotator", e.target.value.trim()));

  // ---- Map ----

  const map = L.map("map", { maxZoom: 20 }).setView([44, -90], 5);

  const icon = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    polygon: icon('<path d="M12 3l8 6-3 11H7L4 9z"/>'),
    rectangle: icon('<rect x="4" y="5" width="16" height="14" rx="1"/>'),
    edit: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    trash: icon('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3"/>'),
    layers: icon('<path d="M12 4L3 9l9 5 9-5z"/><path d="M3 14l9 5 9-5"/>'),
    image: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>'),
    chevron: icon('<path d="M6 15l6-6 6 6"/>')
  };

  // Place search, top left beside the zoom buttons.
  const searchControl = L.control({ position: "topleft" });
  searchControl.onAdd = () => {
    const form = L.DomUtil.create("form", "map-search");
    form.id = "place-search";
    form.innerHTML = '<input id="place-query" type="search" placeholder="Go to a place" aria-label="Go to a place">';
    L.DomEvent.disableClickPropagation(form);
    return form;
  };
  searchControl.addTo(map);

  // Bottom-right bar: a one-click place-label switch, the imagery picker
  // (short names; opens a list), and a layers button for the less-used
  // overlays. Each button opens its panel above the bar.
  const mapBar = L.control({ position: "bottomright" });
  mapBar.onAdd = () => {
    const div = L.DomUtil.create("div", "map-bar");
    div.innerHTML =
      '<div class="map-bar-panel" id="imagery-panel" hidden><div id="imagery-list"></div>' +
      '<p id="imagery-date" class="small muted">Zoom in to see when this imagery was captured.</p></div>' +
      '<div class="map-bar-panel" id="overlay-panel" hidden><div id="overlay-toggles"></div></div>' +
      '<div class="map-bar-row">' +
      '<label class="switch">Labels <input type="checkbox" id="labels-toggle"><span aria-hidden="true"></span></label>' +
      `<button type="button" data-panel="imagery-panel">${ICONS.image}<span id="imagery-name"></span>${ICONS.chevron}</button>` +
      `<button type="button" data-panel="overlay-panel" title="Layers" aria-label="Layers">${ICONS.layers}</button>` +
      "</div>";
    div.querySelectorAll("[data-panel]").forEach(b => b.addEventListener("click", () => {
      for (const panel of div.querySelectorAll(".map-bar-panel")) {
        panel.hidden = panel.id !== b.dataset.panel || !panel.hidden;
      }
    }));
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  };
  mapBar.addTo(map);

  function addOverlayToggle(name, layer) {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="checkbox"${map.hasLayer(layer) ? " checked" : ""}> ${escapeHtml(name)}`;
    label.querySelector("input").addEventListener("change", e =>
      e.target.checked ? layer.addTo(map) : map.removeLayer(layer));
    $("overlay-toggles").append(label);
  }
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 350;
  map.getPane("labels").style.pointerEvents = "none";

  const catalog = await Imagery.buildCatalog();
  let currentId = catalog.keys().next().value;
  const currentImagery = () => catalog.get(currentId);

  let lastGroup = null;
  for (const entry of catalog.values()) {
    if (entry.group !== lastGroup) {
      $("imagery-list").insertAdjacentHTML("beforeend", `<p class="group">${escapeHtml(entry.group)}</p>`);
      lastGroup = entry.group;
    }
    $("imagery-list").insertAdjacentHTML("beforeend",
      `<button type="button" data-imagery="${escapeHtml(entry.id)}">${escapeHtml(entry.short)}</button>`);
  }

  let imageryLayer = null;
  function showImagery(id) {
    currentId = id;
    if (imageryLayer) map.removeLayer(imageryLayer);
    imageryLayer = Imagery.createLayer(currentImagery()).addTo(map);
    $("imagery-name").textContent = currentImagery().name;
    $("imagery-list").querySelectorAll("button")
      .forEach(b => b.classList.toggle("selected", b.dataset.imagery === id));
  }
  showImagery(currentId);
  $("imagery-list").addEventListener("click", e => {
    const id = e.target.closest("[data-imagery]")?.dataset.imagery;
    if (!id || id === currentId) return;
    showImagery(id);
    requestCaptureDate();
  });

  const labelOpts = { pane: "labels", maxZoom: 20 };
  // Place and road names are off by default; the Labels switch turns them on.
  const labels = L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", labelOpts),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", labelOpts)
  ]);

  const studyGeom = STUDY_AREA.features[0].geometry;
  const studyLayer = L.geoJSON(STUDY_AREA, {
    style: { color: "#fff", weight: 2, opacity: 0.9, fill: false },
    interactive: false, pmIgnore: true, snapIgnore: true
  }).addTo(map);
  map.fitBounds(studyLayer.getBounds());

  const annotationLayer = L.geoJSON(null, {
    pmIgnore: true,
    style: f => {
      const color = classColor[f.properties.class] || "#FFFFFF";
      return { color, fillColor: color, weight: 2, opacity: 1, fillOpacity: 0.25 };
    },
    onEachFeature: (f, layer) => {
      const p = f.properties;
      layer.bindTooltip(escapeHtml(p.class));
      layer.bindPopup(
        `<b>${escapeHtml(p.class)}</b> (${escapeHtml(p.confidence)} confidence)<br>${escapeHtml(p.notes)}` +
        `<br><small>${escapeHtml(p.annotator)}, ${escapeHtml((p.created_utc || "").slice(0, 10))}` +
        `<br>Imagery: ${escapeHtml(p.imagery)} ${escapeHtml(p.imagery_date || "")}</small>`
      );
    }
  }).addTo(map);

  addOverlayToggle("Annotations", annotationLayer);
  addOverlayToggle("Study area", studyLayer);
  $("labels-toggle").addEventListener("change", e =>
    e.target.checked ? labels.addTo(map) : map.removeLayer(labels));
  L.control.scale({ position: "bottomleft" }).addTo(map);

  const legend = L.control({ position: "bottomright" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = "<strong>Cover type</strong><br>" + CONFIG.coverClasses
      .map(c => `<span class="swatch" style="background:${c.color}"></span>${escapeHtml(c.name)}`).join("<br>");
    return div;
  };
  legend.addTo(map);

  // ---- Drawing ----

  // Drawing is the main action, so it gets the top-right corner: labelled
  // buttons in one toolbar, like ArcGIS sketch tools. Click an active tool
  // again, or press Esc, to stop.
  const drawControl = L.control({ position: "topright" });
  drawControl.onAdd = () => {
    const div = L.DomUtil.create("div", "draw-toolbar");
    div.innerHTML =
      `<button type="button" data-tool="Polygon">${ICONS.polygon}Draw polygon</button>` +
      `<button type="button" data-tool="Rectangle">${ICONS.rectangle}Rectangle</button>` +
      `<button type="button" data-tool="edit" title="Edit shapes" aria-label="Edit shapes">${ICONS.edit}</button>` +
      `<button type="button" data-tool="remove" title="Delete shapes" aria-label="Delete shapes">${ICONS.trash}</button>`;
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener("click", e => {
      const tool = e.target.closest("button")?.dataset.tool;
      if (!tool) return;
      const wasActive = activeTool() === tool;
      stopTools();
      if (wasActive) return;
      if (tool === "edit") map.pm.enableGlobalEditMode();
      else if (tool === "remove") map.pm.enableGlobalRemovalMode();
      else map.pm.enableDraw(tool);
    });
    return div;
  };
  drawControl.addTo(map);

  const activeTool = () =>
    map.pm.globalEditModeEnabled() ? "edit"
      : map.pm.globalRemovalModeEnabled() ? "remove"
      : map.pm.Draw.getActiveShape();
  function stopTools() {
    map.pm.disableDraw();
    if (map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
    if (map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
  }
  const markActiveTool = () => drawControl.getContainer().querySelectorAll("button")
    .forEach(b => b.classList.toggle("active", b.dataset.tool === activeTool()));
  map.on("pm:drawstart pm:drawend pm:globaleditmodetoggled pm:globalremovalmodetoggled", markActiveTool);
  // Finishes the polygon being drawn, if it has at least three points.
  // Geoman has no public method for this, so it calls the draw handler's own.
  function finishPolygon() {
    const draw = map.pm.Draw.Polygon;
    if (activeTool() === "Polygon" && draw._layer.getLatLngs().length >= 3) draw._finishShape();
  }
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") stopTools();
    if (e.key === "Enter" && !e.target.matches("input, textarea, select, button")) finishPolygon();
  });

  // Closing a polygon is easier: double-click the last point, or click
  // near the first point and it snaps onto it.
  map.pm.setGlobalOptions({
    finishOn: "dblclick",
    snappable: true,
    snapDistance: 25,
    pathOptions: { color: "#FFFFFF", weight: 2, fillColor: "#FFFFFF", fillOpacity: 0.15, dashArray: "6 4" }
  });

  const pending = new Set();
  const pendingGeometries = () => [...pending].map(layer => layer.toGeoJSON().geometry);

  map.on("pm:create", e => {
    pending.add(e.layer);
    e.layer.on("pm:edit", onPendingChange);
    onPendingChange();
  });
  map.on("pm:remove", e => {
    pending.delete(e.layer);
    onPendingChange();
  });

  function onPendingChange() {
    const n = pending.size;
    $("save").disabled = n === 0;
    $("discard").disabled = n === 0;
    $("pending-summary").style.fontWeight = n ? "600" : "";
    if (n === 0) {
      $("pending-summary").textContent =
        "Draw a polygon or rectangle with the tools on the map. Every shape you draw before saving gets the same label.";
      $("pending-summary").className = "small muted";
    } else {
      const acres = pendingGeometries().reduce((s, g) => s + areaAcres(g), 0);
      $("pending-summary").textContent =
        `${n} ${n === 1 ? "polygon" : "polygons"} ready to label (${acres.toFixed(1)} acres)`;
      $("pending-summary").className = "small";
    }
    requestCaptureDate();
  }

  function clearPending() {
    stopTools();
    pending.forEach(layer => map.removeLayer(layer));
    pending.clear();
    onPendingChange();
  }

  $("discard").addEventListener("click", clearPending);

  window.addEventListener("beforeunload", e => {
    if (pending.size) e.preventDefault();
  });

  // ---- Imagery capture date ----

  let dateRequest = null;   // { id, what, imageryId, abort }
  let dateResult = null;    // { requestId, ...captureDate }
  let dateTimer;
  let requestCounter = 0;

  function renderCaptureDate() {
    const el = $("imagery-date");
    if (!dateRequest) {
      el.className = "small muted";
      el.textContent = "Zoom in to see when this imagery was captured.";
      return;
    }
    const where = dateRequest.what === "polygon" ? "Under your polygons" : "At map center";
    const ready = dateResult && dateResult.requestId === dateRequest.id;
    el.className = "small";
    el.innerHTML = `<strong>${where}:</strong> ${ready ? escapeHtml(Imagery.describe(dateResult)) : "looking up capture date..."}`;
  }

  function requestCaptureDate() {
    clearTimeout(dateTimer);
    dateTimer = setTimeout(runCaptureDateLookup, 700);
  }

  function runCaptureDateLookup() {
    if (dateRequest) dateRequest.abort.abort();
    const entry = currentImagery();
    const zoom = map.getZoom();
    let target;
    if (pending.size) {
      const pts = pendingGeometries().map(centroid);
      target = { lng: pts.reduce((s, p) => s + p[0], 0) / pts.length,
                 lat: pts.reduce((s, p) => s + p[1], 0) / pts.length, what: "polygon" };
    } else if (zoom >= 11) {
      const c = map.getCenter();
      target = { lng: c.lng, lat: c.lat, what: "center" };
    } else {
      dateRequest = null;
      renderCaptureDate();
      return;
    }
    const request = { id: ++requestCounter, what: target.what, imageryId: entry.id, abort: new AbortController() };
    dateRequest = request;
    renderCaptureDate();
    Imagery.captureDate(entry, target.lng, target.lat, zoom, request.abort.signal)
      .catch(err => (err.name === "AbortError" ? null : Imagery.EMPTY))
      .then(d => {
        if (!d || dateRequest !== request) return;
        dateResult = { requestId: request.id, ...d };
        renderCaptureDate();
      });
  }

  map.on("moveend", () => {
    if (!pending.size) requestCaptureDate();
  });

  // ---- Saving ----

  $("save").addEventListener("click", async () => {
    if (!pending.size) return;
    const annotator = $("annotator").value.trim();
    const coverClass = $("cover-class").value;
    if (!annotator) return toast("Enter your name at the top of the sidebar first.", "warning");
    if (!coverClass) return toast("Choose a cover type before saving.", "warning");

    const entry = currentImagery();
    const haveDate = dateRequest && dateRequest.what === "polygon" && dateRequest.imageryId === entry.id &&
      dateResult && dateResult.requestId === dateRequest.id;
    const d = haveDate ? dateResult : Imagery.EMPTY;
    const created = new Date().toISOString().slice(0, 19) + "Z";
    const confidence = document.querySelector('input[name="confidence"]:checked').value;

    const features = pendingGeometries().map(geometry => {
      const [lon, lat] = centroid(geometry);
      return {
        type: "Feature",
        geometry,
        properties: {
          annotation_id: crypto.randomUUID(),
          class: coverClass,
          confidence,
          notes: $("notes").value.trim(),
          annotator,
          imagery: entry.label,
          imagery_date: d.date,
          imagery_source: d.source,
          imagery_res_m: d.resolutionM,
          map_zoom: map.getZoom(),
          area_acres: Math.round(areaAcres(geometry) * 100) / 100,
          lon: Math.round(lon * 1e6) / 1e6,
          lat: Math.round(lat * 1e6) / 1e6,
          created_utc: created
        }
      };
    });

    const outside = features.filter(f => !pointInGeometry([f.properties.lon, f.properties.lat], studyGeom)).length;
    await Storage.add(features);
    clearPending();
    $("cover-class").value = "";
    $("notes").value = "";
    await refresh();
    toast(outside
      ? `Saved ${features.length}; ${outside} outside the Tallgrass Prairie study area.`
      : `Saved ${features.length} ${coverClass} polygon${features.length === 1 ? "" : "s"}.`,
      outside ? "warning" : "info");
  });

  // ---- Annotation list ----

  let annotations = [];

  async function refresh() {
    annotations = (await Storage.list())
      .sort((a, b) => (b.properties.created_utc || "").localeCompare(a.properties.created_utc || ""));
    annotationLayer.clearLayers().addData(annotations);
    $("annotation-count").textContent = annotations.length ? `(${annotations.length})` : "";
    renderTable();
  }

  function renderTable() {
    const tbody = document.querySelector("#annotation-table tbody");
    tbody.innerHTML = annotations.map(f => {
      const p = f.properties;
      return `<tr>
        <td><input type="checkbox" class="row-select" value="${escapeHtml(p.annotation_id)}"></td>
        <td>${escapeHtml(p.created_utc)}</td><td>${escapeHtml(p.annotator)}</td>
        <td><span class="swatch" style="background:${classColor[p.class] || "#fff"}"></span>${escapeHtml(p.class)}</td>
        <td>${escapeHtml(p.confidence)}</td><td class="num">${escapeHtml(p.area_acres)}</td>
        <td>${escapeHtml(p.imagery)}</td><td>${escapeHtml(p.imagery_date)}</td><td>${escapeHtml(p.notes)}</td>
      </tr>`;
    }).join("");
    $("table-empty").style.display = annotations.length ? "none" : "block";
    $("select-all").checked = false;
  }

  const selectedIds = () => [...document.querySelectorAll(".row-select:checked")].map(cb => cb.value);

  $("select-all").addEventListener("change", e => {
    document.querySelectorAll(".row-select").forEach(cb => (cb.checked = e.target.checked));
  });

  $("zoom-selected").addEventListener("click", () => {
    const ids = new Set(selectedIds());
    if (!ids.size) return toast("Select rows in the table first.", "warning");
    const bounds = L.geoJSON(annotations.filter(f => ids.has(f.properties.annotation_id))).getBounds();
    showTab("map-view");
    map.fitBounds(bounds, { maxZoom: 17 });
  });

  $("delete-selected").addEventListener("click", async () => {
    const ids = selectedIds();
    if (!ids.length) return toast("Select rows in the table first.", "warning");
    if (!confirm(`Permanently delete ${ids.length} selected annotation${ids.length === 1 ? "" : "s"}?`)) return;
    await Storage.remove(ids);
    await refresh();
    toast(`Deleted ${ids.length} annotation${ids.length === 1 ? "" : "s"}.`);
  });

  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  $("export-geojson").addEventListener("click", () => {
    if (!annotations.length) return toast("Nothing to export yet.", "warning");
    download(JSON.stringify({ type: "FeatureCollection", features: annotations }),
      `tpos_annotations_${today()}.geojson`, "application/geo+json");
  });

  $("export-csv").addEventListener("click", () => {
    if (!annotations.length) return toast("Nothing to export yet.", "warning");
    const cols = Object.keys(annotations[0].properties);
    const cell = v => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const rows = annotations.map(f => [...cols.map(c => cell(f.properties[c])), cell(toWkt(f.geometry))].join(","));
    download([[...cols, "wkt"].join(","), ...rows].join("\n"), `tpos_annotations_${today()}.csv`, "text/csv");
  });

  $("import-geojson").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const features = (data.features || [])
        .filter(f => f.geometry && ["Polygon", "MultiPolygon"].includes(f.geometry.type));
      const added = await Storage.merge(features);
      await refresh();
      toast(`Imported ${added} new annotation${added === 1 ? "" : "s"}` +
        (features.length > added ? `; skipped ${features.length - added} already present.` : "."));
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}`, "warning");
    }
  });

  // ---- Place search (OpenStreetMap Nominatim) ----

  $("place-search").addEventListener("submit", async e => {
    e.preventDefault();
    const q = $("place-query").value.trim();
    if (!q) return;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
      const [hit] = await (await fetch(url)).json();
      if (!hit) return toast(`No place found for "${q}".`, "warning");
      const [s, n, w, east] = hit.boundingbox.map(Number);
      showTab("map-view");
      map.fitBounds([[s, w], [n, east]], { maxZoom: 15 });
    } catch {
      toast("Place search is unavailable right now.", "warning");
    }
  });

  onPendingChange();
  await refresh();
})();
