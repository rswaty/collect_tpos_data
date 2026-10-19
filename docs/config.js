// Settings most likely to change. Edit freely; no build step is needed.
const CONFIG = {
  coverClasses: [
    {
      name: "Native prairie",
      color: "#FFD700",
      tip: "Remnant, never-plowed grassland. Irregular boundaries that follow terrain (steep or rocky slopes, wet swales, railroad rights-of-way, cemeteries); mottled, heterogeneous texture from mixed grasses, forbs, and scattered shrubs; no row or tillage patterns. Warm-season grasses green up late, so remnants can look duller than cool-season hay in spring imagery."
    },
    {
      name: "Hay/pasture",
      color: "#00E5FF",
      tip: "Planted or managed grass/legume cover. Regular field shapes and uniform texture. Hay: mowing swaths, windrows, bales, sharp cut/uncut contrasts. Pasture: livestock trails, stock ponds and tanks, fences, worn areas near water. Cool-season species (brome, fescue) are bright green, or bright red in color infrared, early in the season."
    },
    {
      name: "Row crop",
      color: "#FF1493",
      tip: "Annual cultivated crops. Linear row patterns, uniform canopy in mid-summer, bare or residue-covered soil in spring and fall, center pivots, terraces. Grassed waterways inside crop fields are not hay."
    },
    {
      name: "Ruderal vegetation",
      color: "#B388FF",
      tip: "Weedy, disturbance-driven cover. Abandoned or fallow fields, field margins, recently disturbed ground; patchy texture with bare spots and weedy colonizers; often transitional between other classes."
    }
  ],

  generalTip: "Draw polygons well inside a single cover type and stay off edges and mixed areas. Compare several dates and the NAIP color infrared view before deciding. Planted grasslands (CRP, reconstructions) can look like prairie but usually have straight edges and uniform texture; say so in the notes.",

  // Number of recent Esri World Imagery (Wayback) releases offered.
  waybackReleases: 6,
  // Not offered yet. To turn them on: naip: true, sentinelYears: [2025, 2024, 2023]
  naip: false,
  sentinelYears: []
};
