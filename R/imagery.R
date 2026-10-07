wayback_config_url <- "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"
naip_service <- "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer"
naip_wms     <- "https://imagery.nationalmap.gov/arcgis/services/USGSNAIPPlus/ImageServer/WMSServer"

esri_attribution <- "Esri, Vantor, Earthstar Geographics, and the GIS User Community"
naip_attribution <- "USDA NAIP via USGS The National Map"
eox_attribution  <- paste(
  '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH',
  "(contains modified Copernicus Sentinel data)"
)

fetch_json <- function(url, timeout = 6) {
  res <- curl::curl_fetch_memory(url, handle = curl::new_handle(timeout = timeout))
  if (res$status_code != 200) stop("HTTP ", res$status_code, " from ", url)
  jsonlite::fromJSON(rawToChar(res$content), simplifyVector = TRUE)
}

imagery_entry <- function(id, label, group, type, url, attribution,
                          layers = NULL, max_native_zoom = 19,
                          date_source = "none", metadata_url = NULL, year = NULL) {
  list(id = id, label = label, group = group, type = type, url = url,
       attribution = attribution, layers = layers, max_native_zoom = max_native_zoom,
       date_source = date_source, metadata_url = metadata_url, year = year)
}

wayback_entries <- function(n = 6) {
  cfg <- tryCatch(fetch_json(wayback_config_url), error = function(e) NULL)
  group <- "Esri World Imagery (high-res, mixed sources)"
  if (is.null(cfg)) {
    return(list(imagery_entry(
      "esri_current", "Esri World Imagery (current)", group, "xyz",
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      esri_attribution
    )))
  }
  releases <- data.frame(
    release = names(cfg),
    title   = vapply(cfg, `[[`, "", "itemTitle"),
    url     = vapply(cfg, `[[`, "", "itemURL"),
    meta    = vapply(cfg, function(x) x$metadataLayerUrl %||% NA_character_, ""),
    stringsAsFactors = FALSE
  )
  releases$date <- as.Date(sub(".*Wayback (\\d{4}-\\d{2}-\\d{2}).*", "\\1", releases$title))
  releases <- releases[!is.na(releases$date), ]
  releases <- head(releases[order(releases$date, decreasing = TRUE), ], n)
  lapply(seq_len(nrow(releases)), function(i) {
    r <- releases[i, ]
    url <- sub("\\{level\\}/\\{row\\}/\\{col\\}", "{z}/{y}/{x}", r$url)
    label <- sprintf("Esri World Imagery, %s release%s", r$date, if (i == 1) " (latest)" else "")
    imagery_entry(paste0("wayback_", r$release), label, group, "xyz", url, esri_attribution,
                  date_source = if (is.na(r$meta)) "none" else "esri", metadata_url = r$meta)
  })
}

build_imagery_catalog <- function() {
  naip_group <- "NAIP (USDA aerial, 0.3-1 m, leaf-on, most recent per state)"
  s2_group   <- "Sentinel-2 cloudless annual mosaic (10 m)"
  entries <- c(
    wayback_entries(),
    list(
      imagery_entry("naip_natural", "NAIP natural color", naip_group, "wms", naip_wms,
                    naip_attribution, layers = "USGSNAIPPlus:NaturalColor", date_source = "naip"),
      imagery_entry("naip_cir", "NAIP color infrared (vegetation = red)", naip_group, "wms", naip_wms,
                    naip_attribution, layers = "USGSNAIPPlus:FalseColorComposite", date_source = "naip"),
      imagery_entry("naip_ndvi", "NAIP NDVI", naip_group, "wms", naip_wms,
                    naip_attribution, layers = "USGSNAIPPlus:NDVI_Color", date_source = "naip")
    ),
    lapply(c(2025, 2024, 2023), function(y) {
      imagery_entry(paste0("s2_", y), sprintf("Sentinel-2 cloudless %d", y), s2_group, "xyz",
                    sprintf("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-%d_3857/default/g/{z}/{y}/{x}.jpg", y),
                    eox_attribution, max_native_zoom = 15, date_source = "s2", year = y)
    })
  )
  setNames(entries, vapply(entries, `[[`, "", "id"))
}

imagery_choices <- function(catalog) {
  groups <- unique(vapply(catalog, `[[`, "", "group"))
  setNames(lapply(groups, function(g) {
    in_group <- Filter(function(e) e$group == g, catalog)
    setNames(names(in_group), vapply(in_group, `[[`, "", "label"))
  }), groups)
}

add_imagery_layer <- function(map, entry) {
  if (entry$type == "wms") {
    leaflet::addWMSTiles(
      map, baseUrl = entry$url, layers = entry$layers, layerId = "imagery",
      attribution = entry$attribution,
      options = leaflet::WMSTileOptions(format = "image/jpeg", transparent = FALSE, maxZoom = 20)
    )
  } else {
    leaflet::addTiles(
      map, urlTemplate = entry$url, layerId = "imagery", attribution = entry$attribution,
      options = leaflet::tileOptions(maxNativeZoom = entry$max_native_zoom, maxZoom = 20)
    )
  }
}

empty_imagery_date <- list(date = NA_character_, source = NA_character_, resolution_m = NA_real_)

# URL of the metadata query that returns the capture date of the imagery shown
# at a point, or NULL when the source has no per-location metadata. The NAIP
# service can take 5-20 s to answer, so the app has the browser run these
# queries rather than blocking the R process.
imagery_date_query_url <- function(entry, lng, lat, zoom) {
  switch(
    entry$date_source,
    esri = {
      # Esri publishes one metadata layer per zoom level; layer 4 = zoom 19.
      layer <- min(max(23L - as.integer(zoom), 0L), 13L)
      sprintf(
        "%s/%d/query?geometry=%f,%f&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE,SRC_RES,NICE_DESC,NICE_NAME&returnGeometry=false&f=json",
        entry$metadata_url, layer, lng, lat
      )
    },
    naip = sprintf(
      "%s/query?where=Category%%3D1&geometry=%f,%f&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=Year,acquisition_date,State,resolution_value&returnGeometry=false&f=json",
      naip_service, lng, lat
    ),
    NULL
  )
}

# Capture date for sources that need no lookup (annual composites).
static_imagery_date <- function(entry) {
  if (entry$date_source != "s2") return(empty_imagery_date)
  list(date = as.character(entry$year), source = "Sentinel-2 cloudless annual composite",
       resolution_m = 10)
}

# Parses the JSON returned by the query from imagery_date_query_url() into a
# list of date ("YYYY-MM-DD"), source, and resolution_m.
parse_imagery_date <- function(entry, body) {
  if (is.null(body) || !nzchar(body)) return(empty_imagery_date)
  tryCatch({
    a <- jsonlite::fromJSON(body, simplifyVector = TRUE)$features$attributes
    if (is.null(a) || !nrow(a)) return(empty_imagery_date)
    switch(
      entry$date_source,
      esri = list(date = format(as.Date(as.character(a$SRC_DATE[1]), "%Y%m%d")),
                  source = paste(a$NICE_DESC[1], a$NICE_NAME[1]),
                  resolution_m = as.numeric(a$SRC_RES[1])),
      naip = {
        a <- a[!is.na(a$acquisition_date), , drop = FALSE]
        if (!nrow(a)) return(empty_imagery_date)
        a <- a[which.max(a$acquisition_date), ]
        list(date = format(as.Date(as.POSIXct(a$acquisition_date / 1000, origin = "1970-01-01", tz = "UTC"))),
             source = sprintf("NAIP %s %s", a$State, a$Year),
             resolution_m = as.numeric(a$resolution_value))
      },
      empty_imagery_date
    )
  }, error = function(e) empty_imagery_date)
}

describe_imagery_date <- function(d) {
  if (is.na(d$date)) return("Capture date unavailable here")
  res <- if (is.na(d$resolution_m)) "" else sprintf(", %s m", signif(d$resolution_m, 2))
  sprintf("Captured %s (%s%s)", d$date, d$source, res)
}
