# LANDFIRE Tallgrass Prairie training-polygon collector.
#
# Annotators view recent imagery, draw polygons, and label them as native
# prairie, hay/pasture, row crop, or ruderal vegetation. Polygons are stored in
# data/annotations.gpkg.
#
# Run: shiny::runApp()

library(shiny)
library(bslib)
library(leaflet)
library(leaflet.extras)
library(sf)
library(DT)

# ---- Configuration ---------------------------------------------------------

cover_classes <- c(
  "Native prairie"     = "#FFD700",
  "Hay/pasture"        = "#00E5FF",
  "Row crop"           = "#FF1493",
  "Ruderal vegetation" = "#B388FF"
)
confidence_levels <- c("High", "Medium", "Low")

data_dir         <- "data"
annotations_path <- file.path(data_dir, "annotations.gpkg")
dir.create(data_dir, showWarnings = FALSE)

aoi <- st_read("inputs/tpos.shp", quiet = TRUE) |>
  st_make_valid() |>
  st_transform(4326)
aoi_bbox <- st_bbox(aoi)

imagery_catalog <- build_imagery_catalog()

# ---- Storage ---------------------------------------------------------------

read_annotations <- function() {
  if (!file.exists(annotations_path)) return(NULL)
  st_read(annotations_path, layer = "annotations", quiet = TRUE)
}

# Writes to a temp file then renames, so a crash mid-write cannot corrupt the
# existing annotations.
write_annotations <- function(x) {
  if (is.null(x) || nrow(x) == 0) {
    unlink(annotations_path)
    return(invisible())
  }
  tmp <- tempfile(tmpdir = data_dir, fileext = ".gpkg")
  st_write(x, tmp, layer = "annotations", layer_options = "GEOMETRY_NAME=geometry", quiet = TRUE)
  file.rename(tmp, annotations_path)
  invisible()
}

append_annotations <- function(new) {
  old <- read_annotations()
  write_annotations(if (is.null(old)) new else rbind(old[, names(new)], new))
}

file_signature <- function(path) {
  if (file.exists(path)) paste(as.numeric(file.mtime(path)), file.size(path)) else ""
}

drawn_features_to_sf <- function(fc) {
  if (is.null(fc) || length(fc$features) == 0) return(NULL)
  x <- st_read(as.character(jsonlite::toJSON(fc, auto_unbox = TRUE, digits = NA)), quiet = TRUE)
  x <- st_make_valid(x)
  if (any(st_geometry_type(x) == "GEOMETRYCOLLECTION")) x <- st_collection_extract(x, "POLYGON")
  st_cast(st_geometry(x), "MULTIPOLYGON")
}

area_acres <- function(geom) as.numeric(st_area(st_transform(geom, 5070))) / 4046.856

# ---- UI --------------------------------------------------------------------

class_tips <- list(
  "Native prairie" = "Remnant, never-plowed grassland. Irregular boundaries that follow terrain (steep or rocky slopes, wet swales, railroad rights-of-way, cemeteries); mottled, heterogeneous texture from mixed grasses, forbs, and scattered shrubs; no row or tillage patterns. Warm-season grasses green up late, so remnants can look duller than cool-season hay in spring imagery.",
  "Hay/pasture" = "Planted or managed grass/legume cover. Regular field shapes and uniform texture. Hay: mowing swaths, windrows, bales, sharp cut/uncut contrasts. Pasture: livestock trails, stock ponds and tanks, fences, worn areas near water. Cool-season species (brome, fescue) are bright green or bright red in color infrared early in the season.",
  "Row crop" = "Annual cultivated crops. Linear row patterns, uniform canopy in mid-summer, bare or residue-covered soil in spring and fall, center pivots, terraces. Grassed waterways inside crop fields are not hay.",
  "Ruderal vegetation" = "Weedy, disturbance-driven cover. Abandoned or fallow fields, field margins, recently disturbed ground; patchy texture with bare spots and weedy colonizers; often transitional between other classes."
)

tips_ui <- tagList(
  lapply(names(class_tips), function(cls) {
    tags$p(
      tags$span(style = sprintf("display:inline-block;width:12px;height:12px;background:%s;margin-right:6px;border:1px solid #555;", cover_classes[[cls]])),
      tags$strong(cls), tags$br(), tags$small(class_tips[[cls]])
    )
  }),
  tags$p(tags$small(
    tags$strong("General:"),
    " Draw polygons well inside a single cover type and stay off edges and mixed areas. Compare several dates and the NAIP color infrared view before deciding. Planted grasslands (CRP, reconstructions) can look like prairie but usually have straight edges and uniform texture; say so in the notes."
  ))
)

# Runs imagery-date queries from the browser and returns the response body.
imagery_date_js <- tags$script(HTML("
Shiny.addCustomMessageHandler('fetch_imagery_date', function(msg) {
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, 30000);
  fetch(msg.url, { signal: ctrl.signal })
    .then(function(r) { return r.text(); })
    .catch(function() { return null; })
    .then(function(body) {
      clearTimeout(timer);
      Shiny.setInputValue('imagery_date_response', { id: msg.id, body: body }, { priority: 'event' });
    });
});
"))

ui <- page_sidebar(
  title = "LANDFIRE Tallgrass Prairie training polygons",
  theme = bs_theme(version = 5),
  tags$head(imagery_date_js),
  sidebar = sidebar(
    width = 380,
    textInput("annotator", "Your name"),
    selectInput("imagery", "Imagery", choices = imagery_choices(imagery_catalog)),
    uiOutput("imagery_date"),
    accordion(
      open = "Label polygons",
      accordion_panel(
        "Label polygons",
        uiOutput("pending_summary"),
        selectInput("class", "Cover type", choices = c("Choose a cover type" = "", names(cover_classes))),
        radioButtons("confidence", "Confidence", confidence_levels, selected = "Medium", inline = TRUE),
        textAreaInput("notes", "Notes", rows = 3,
                      placeholder = "What did you see? e.g. mowing swaths, cattle trails, rocky hillside remnant"),
        layout_columns(
          actionButton("save", "Save", class = "btn-primary"),
          actionButton("discard", "Discard", class = "btn-outline-danger")
        )
      ),
      accordion_panel("Interpretation tips", tips_ui)
    )
  ),
  navset_card_underline(
    id = "map_tabs",
    full_screen = TRUE,
    nav_panel("Map", leafletOutput("map", height = "100%")),
    nav_panel(
      "Annotations",
      div(
        class = "d-flex gap-2 justify-content-end",
        actionButton("zoom_selected", "Zoom to selected", class = "btn-sm"),
        actionButton("delete_selected", "Delete selected", class = "btn-sm btn-outline-danger"),
        downloadButton("download_gpkg", "GeoPackage", class = "btn-sm"),
        downloadButton("download_csv", "CSV", class = "btn-sm")
      ),
      DTOutput("annotation_table")
    )
  )
)

# ---- Server ----------------------------------------------------------------

add_draw_toolbar <- function(map) {
  shape <- drawShapeOptions(color = "#FFFFFF", weight = 2, fillColor = "#FFFFFF",
                            fillOpacity = 0.15, dashArray = "6 4")
  addDrawToolbar(
    map,
    targetGroup = "pending",
    polylineOptions = FALSE, circleOptions = FALSE,
    markerOptions = FALSE, circleMarkerOptions = FALSE,
    polygonOptions = drawPolygonOptions(shapeOptions = shape),
    rectangleOptions = drawRectangleOptions(shapeOptions = shape),
    editOptions = editToolbarOptions(edit = TRUE, remove = TRUE)
  )
}

server <- function(input, output, session) {

  annotations <- reactivePoll(1000, session,
                              function() file_signature(annotations_path), read_annotations)

  pending <- reactiveVal(NULL)
  imagery <- reactive(imagery_catalog[[req(input$imagery)]])

  annotator <- reactive(trimws(input$annotator))
  require_annotator <- function() {
    if (!nzchar(annotator())) {
      showNotification("Enter your name at the top of the sidebar first.", type = "warning")
      return(FALSE)
    }
    TRUE
  }

  # ---- Map ----

  output$map <- renderLeaflet({
    labels_opts <- tileOptions(zIndex = 10, maxZoom = 20)
    leaflet(options = leafletOptions(maxZoom = 20)) |>
      add_imagery_layer(imagery_catalog[[1]]) |>
      addTiles("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
               group = "Labels", options = labels_opts) |>
      addTiles("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
               group = "Labels", options = labels_opts) |>
      addPolylines(data = st_cast(aoi, "MULTILINESTRING"), group = "Study area",
                   color = "#FFFFFF", weight = 2, opacity = 0.9,
                   options = pathOptions(interactive = FALSE)) |>
      fitBounds(aoi_bbox[["xmin"]], aoi_bbox[["ymin"]], aoi_bbox[["xmax"]], aoi_bbox[["ymax"]]) |>
      add_draw_toolbar() |>
      addSearchOSM(options = searchOptions(autoCollapse = TRUE, minLength = 2, zoom = 13,
                                           hideMarkerOnCollapse = TRUE, position = "topright")) |>
      addScaleBar(position = "bottomleft") |>
      addLegend("bottomright", colors = unname(cover_classes), labels = names(cover_classes),
                title = "Cover type", opacity = 1) |>
      addLayersControl(
        overlayGroups = c("Annotations", "Study area", "Labels"),
        options = layersControlOptions(collapsed = TRUE)
      )
  })

  observeEvent(input$imagery, ignoreInit = TRUE, {
    leafletProxy("map") |> add_imagery_layer(imagery())
  })

  observe({
    a <- annotations()
    proxy <- leafletProxy("map") |> clearGroup("Annotations")
    if (is.null(a) || nrow(a) == 0) return()
    colors <- unname(cover_classes[a$class])
    colors[is.na(colors)] <- "#FFFFFF"
    popups <- sprintf(
      "<b>%s</b> (%s confidence)<br>%s<br><small>%s, %s<br>Imagery: %s %s</small>",
      htmltools::htmlEscape(a$class), htmltools::htmlEscape(a$confidence),
      htmltools::htmlEscape(ifelse(is.na(a$notes), "", a$notes)),
      htmltools::htmlEscape(a$annotator), substr(a$created_utc, 1, 10),
      htmltools::htmlEscape(a$imagery), ifelse(is.na(a$imagery_date), "", a$imagery_date)
    )
    proxy |> addPolygons(
      data = a, group = "Annotations", layerId = a$annotation_id,
      color = colors, fillColor = colors, weight = 2, opacity = 1, fillOpacity = 0.25,
      label = a$class, popup = popups
    )
  })

  # ---- Pending polygons ----

  observeEvent(input$map_draw_all_features, {
    pending(drawn_features_to_sf(input$map_draw_all_features))
  })

  clear_pending <- function() {
    pending(NULL)
    leafletProxy("map") |> removeDrawToolbar(clearFeatures = TRUE) |> add_draw_toolbar()
  }

  output$pending_summary <- renderUI({
    p <- pending()
    if (is.null(p)) {
      return(tags$p(class = "text-muted small",
        "Draw a polygon or rectangle with the tools on the map. Every shape you draw before saving gets the same label."))
    }
    tags$p(class = "small", tags$strong(sprintf(
      "%d %s ready to label (%.1f acres)", length(p),
      if (length(p) == 1) "polygon" else "polygons", sum(area_acres(p))
    )))
  })

  observe({
    updateActionButton(session, "save", disabled = is.null(pending()))
    updateActionButton(session, "discard", disabled = is.null(pending()))
  })

  observeEvent(input$discard, clear_pending())

  # ---- Imagery capture date ----

  view <- debounce(reactive(list(center = input$map_center, zoom = input$map_zoom)), 1200)
  date_request  <- reactiveVal(NULL)
  date_response <- reactiveVal(NULL)
  request_count <- 0

  observe({
    entry <- imagery()
    p <- pending()
    if (!is.null(p)) {
      xy <- st_coordinates(st_centroid(st_union(p)))
      target <- list(lng = xy[1], lat = xy[2], zoom = isolate(input$map_zoom) %||% 15, what = "polygon")
    } else {
      v <- view()
      req(v$center, v$zoom)
      if (v$zoom < 11) {
        date_request(NULL)
        return()
      }
      target <- list(lng = v$center$lng, lat = v$center$lat, zoom = v$zoom, what = "center")
    }
    request_count <<- request_count + 1
    request <- c(target, list(id = request_count, imagery_id = entry$id))
    date_request(request)
    url <- imagery_date_query_url(entry, target$lng, target$lat, target$zoom)
    if (is.null(url)) {
      date_response(list(id = request$id, result = static_imagery_date(entry)))
    } else {
      date_response(NULL)
      session$sendCustomMessage("fetch_imagery_date", list(id = request$id, url = url))
    }
  })

  observeEvent(input$imagery_date_response, {
    r <- input$imagery_date_response
    request <- date_request()
    if (is.null(request) || !identical(as.integer(r$id), as.integer(request$id))) return()
    date_response(list(id = request$id, result = parse_imagery_date(imagery(), r$body)))
  })

  current_imagery_date <- reactive({
    request  <- date_request()
    response <- date_response()
    if (is.null(request) || is.null(response) || response$id != request$id) return(NULL)
    c(response$result, list(what = request$what))
  })

  output$imagery_date <- renderUI({
    request <- date_request()
    if (is.null(request)) {
      return(tags$p(class = "small text-muted", "Zoom in to see when this imagery was captured."))
    }
    where <- if (request$what == "polygon") "Under your polygons" else "At map center"
    d <- current_imagery_date()
    text <- if (is.null(d)) "looking up capture date..." else describe_imagery_date(d)
    tags$p(class = "small", tags$strong(paste0(where, ": ")), text)
  })

  # ---- Save ----

  observeEvent(input$save, {
    p <- pending()
    req(p)
    if (!require_annotator()) return()
    if (!nzchar(input$class)) {
      showNotification("Choose a cover type before saving.", type = "warning")
      return()
    }

    inside <- lengths(st_intersects(p, aoi)) > 0
    if (!all(inside)) {
      showNotification("Some polygons are outside the Tallgrass Prairie study area; saved anyway.",
                       type = "warning")
    }

    xy <- st_coordinates(st_centroid(p))
    d <- current_imagery_date()
    if (is.null(d) || d$what != "polygon") d <- empty_imagery_date
    now <- Sys.time()

    new <- st_sf(
      annotation_id = vapply(seq_along(p), function(i) uuid::UUIDgenerate(), ""),
      class         = input$class,
      confidence    = input$confidence,
      notes         = trimws(input$notes),
      annotator     = annotator(),
      imagery       = imagery()$label,
      imagery_date  = d$date,
      imagery_source = d$source,
      imagery_res_m = d$resolution_m,
      map_zoom      = as.integer(input$map_zoom),
      area_acres    = round(area_acres(p), 2),
      lon           = round(xy[, 1], 6),
      lat           = round(xy[, 2], 6),
      created_utc   = format(now, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
      geometry      = p
    )
    append_annotations(new)

    showNotification(sprintf("Saved %d %s polygon%s.", nrow(new), input$class,
                             if (nrow(new) == 1) "" else "s"), type = "message")
    clear_pending()
    updateSelectInput(session, "class", selected = "")
    updateTextAreaInput(session, "notes", value = "")
  })

  # ---- Annotation table ----

  table_data <- reactive({
    a <- annotations()
    if (is.null(a)) return(NULL)
    a <- st_drop_geometry(a)
    a[order(a$created_utc, decreasing = TRUE), ]
  })

  output$annotation_table <- renderDT({
    d <- table_data()
    if (is.null(d)) d <- data.frame(Message = "No annotations saved yet.")
    else d <- d[, c("created_utc", "annotator", "class", "confidence", "area_acres",
                    "imagery", "imagery_date", "notes")]
    datatable(d, rownames = FALSE, filter = "top",
              options = list(pageLength = 25, scrollX = TRUE))
  })

  selected_ids <- reactive({
    rows <- input$annotation_table_rows_selected
    d <- table_data()
    if (is.null(d) || length(rows) == 0) return(character())
    d$annotation_id[rows]
  })

  observeEvent(input$zoom_selected, {
    ids <- selected_ids()
    if (length(ids) == 0) return(showNotification("Select rows in the table first.", type = "warning"))
    bb <- st_bbox(annotations()[annotations()$annotation_id %in% ids, ])
    leafletProxy("map") |> fitBounds(bb[["xmin"]], bb[["ymin"]], bb[["xmax"]], bb[["ymax"]])
    nav_select("map_tabs", "Map")
  })

  observeEvent(input$delete_selected, {
    ids <- selected_ids()
    if (length(ids) == 0) return(showNotification("Select rows in the table first.", type = "warning"))
    showModal(modalDialog(
      title = "Delete annotations",
      sprintf("Permanently delete %d selected annotation%s?", length(ids), if (length(ids) == 1) "" else "s"),
      footer = tagList(modalButton("Cancel"),
                       actionButton("confirm_delete", "Delete", class = "btn-danger"))
    ))
  })

  observeEvent(input$confirm_delete, {
    ids <- selected_ids()
    a <- read_annotations()
    write_annotations(a[!a$annotation_id %in% ids, ])
    removeModal()
    showNotification(sprintf("Deleted %d annotation%s.", length(ids), if (length(ids) == 1) "" else "s"))
  })

  output$download_gpkg <- downloadHandler(
    filename = function() sprintf("tpos_annotations_%s.gpkg", format(Sys.Date())),
    content = function(file) {
      a <- annotations()
      req(a)
      st_write(a, file, layer = "annotations", driver = "GPKG", quiet = TRUE)
    }
  )

  output$download_csv <- downloadHandler(
    filename = function() sprintf("tpos_annotations_%s.csv", format(Sys.Date())),
    content = function(file) {
      a <- annotations()
      req(a)
      a$wkt <- st_as_text(st_geometry(a))
      write.csv(st_drop_geometry(a), file, row.names = FALSE)
    }
  )
}

shinyApp(ui, server)
