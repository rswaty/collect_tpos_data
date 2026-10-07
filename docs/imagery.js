// Imagery sources and per-location capture-date lookups.

const Imagery = (() => {
  const WAYBACK_CONFIG = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";
  const NAIP_SERVICE = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer";
  const NAIP_WMS = "https://imagery.nationalmap.gov/arcgis/services/USGSNAIPPlus/ImageServer/WMSServer";

  const ESRI_ATTR = "Esri, Vantor, Earthstar Geographics, and the GIS User Community";
  const NAIP_ATTR = "USDA NAIP via USGS The National Map";
  const EOX_ATTR = '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data)';

  const ESRI_GROUP = "Esri World Imagery (high-res, mixed sources)";
  const NAIP_GROUP = "NAIP (USDA aerial, 0.3-1 m, leaf-on, most recent per state)";
  const S2_GROUP = "Sentinel-2 cloudless annual mosaic (10 m)";

  async function waybackEntries(n) {
    try {
      const cfg = await (await fetch(WAYBACK_CONFIG)).json();
      const releases = Object.entries(cfg)
        .map(([release, item]) => {
          const m = /Wayback (\d{4}-\d{2}-\d{2})/.exec(item.itemTitle || "");
          return m && { release, date: m[1], url: item.itemURL, metadataUrl: item.metadataLayerUrl };
        })
        .filter(Boolean)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, n);
      return releases.map((r, i) => ({
        id: `wayback_${r.release}`,
        label: `Esri World Imagery, ${r.date} release${i === 0 ? " (latest)" : ""}`,
        group: ESRI_GROUP,
        type: "xyz",
        url: r.url.replace("{level}/{row}/{col}", "{z}/{y}/{x}"),
        attribution: ESRI_ATTR,
        maxNativeZoom: 19,
        dateSource: r.metadataUrl ? "esri" : "none",
        metadataUrl: r.metadataUrl
      }));
    } catch (err) {
      console.warn("Wayback releases unavailable; using current World Imagery.", err);
      return [{
        id: "esri_current",
        label: "Esri World Imagery (current)",
        group: ESRI_GROUP,
        type: "xyz",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: ESRI_ATTR,
        maxNativeZoom: 19,
        dateSource: "none"
      }];
    }
  }

  async function buildCatalog() {
    const naip = (id, label, layers) => ({
      id, label, group: NAIP_GROUP, type: "wms", url: NAIP_WMS, layers,
      attribution: NAIP_ATTR, dateSource: "naip"
    });
    const entries = [
      ...(await waybackEntries(CONFIG.waybackReleases)),
      naip("naip_natural", "NAIP natural color", "USGSNAIPPlus:NaturalColor"),
      naip("naip_cir", "NAIP color infrared (vegetation = red)", "USGSNAIPPlus:FalseColorComposite"),
      naip("naip_ndvi", "NAIP NDVI", "USGSNAIPPlus:NDVI_Color"),
      ...CONFIG.sentinelYears.map(year => ({
        id: `s2_${year}`,
        label: `Sentinel-2 cloudless ${year}`,
        group: S2_GROUP,
        type: "xyz",
        url: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/g/{z}/{y}/{x}.jpg`,
        attribution: EOX_ATTR,
        maxNativeZoom: 15,
        dateSource: "s2",
        year
      }))
    ];
    return new Map(entries.map(e => [e.id, e]));
  }

  function createLayer(entry) {
    if (entry.type === "wms") {
      return L.tileLayer.wms(entry.url, {
        layers: entry.layers, format: "image/jpeg", transparent: false,
        attribution: entry.attribution, maxZoom: 20
      });
    }
    return L.tileLayer(entry.url, {
      attribution: entry.attribution, maxNativeZoom: entry.maxNativeZoom, maxZoom: 20
    });
  }

  const EMPTY = { date: null, source: null, resolutionM: null };

  // Capture date of the imagery shown at a point. The NAIP service can take
  // 5-20 s to answer, so callers pass an AbortSignal to cancel stale lookups.
  async function captureDate(entry, lng, lat, zoom, signal) {
    if (entry.dateSource === "s2") {
      return { date: String(entry.year), source: "Sentinel-2 cloudless annual composite", resolutionM: 10 };
    }
    const point = `geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false&f=json`;
    if (entry.dateSource === "esri") {
      // Esri publishes one metadata layer per zoom level; layer 4 = zoom 19.
      const layer = Math.min(Math.max(23 - Math.round(zoom), 0), 13);
      const url = `${entry.metadataUrl}/${layer}/query?${point}&outFields=SRC_DATE,SRC_RES,NICE_DESC,NICE_NAME`;
      const features = (await (await fetch(url, { signal })).json()).features || [];
      if (!features.length) return EMPTY;
      const a = features[0].attributes;
      const d = String(a.SRC_DATE);
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        source: `${a.NICE_DESC} ${a.NICE_NAME}`,
        resolutionM: a.SRC_RES
      };
    }
    if (entry.dateSource === "naip") {
      const url = `${NAIP_SERVICE}/query?where=Category%3D1&${point}&outFields=Year,acquisition_date,State,resolution_value`;
      const features = ((await (await fetch(url, { signal })).json()).features || [])
        .map(f => f.attributes)
        .filter(a => a.acquisition_date != null);
      if (!features.length) return EMPTY;
      const a = features.reduce((best, x) => (x.acquisition_date > best.acquisition_date ? x : best));
      return {
        date: new Date(a.acquisition_date).toISOString().slice(0, 10),
        source: `NAIP ${a.State} ${a.Year}`,
        resolutionM: a.resolution_value
      };
    }
    return EMPTY;
  }

  function describe(d) {
    if (!d || !d.date) return "Capture date unavailable here";
    const res = d.resolutionM ? `, ${Number(d.resolutionM.toPrecision(2))} m` : "";
    return `Captured ${d.date} (${d.source}${res})`;
  }

  return { buildCatalog, createLayer, captureDate, describe, EMPTY };
})();
