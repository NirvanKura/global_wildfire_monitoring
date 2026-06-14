// =============================================================================
//  GOOGLE EARTH ENGINE SCRIPT — PRODUCTION-READY
//  Global Wildfire Analysis: dNBR, dNDVI, Fire Severity (Last 7 Days)
//
//  USAGE:
//    1. Go to https://code.earthengine.google.com/
//    2. Paste this entire script and click RUN
//    3. Adjust ROI and date range at the top as needed
//
//  OUTPUTS (auto-exported to Google Drive):
//    - dNBR raster (GeoTIFF, 20m)
//    - Fire severity polygon (GeoJSON)
//    - dNDVI raster (GeoTIFF, 10m)
//    - Active FRP raster (GeoTIFF, 375m equivalent via MODIS)
//
//  DATA SOURCES USED:
//    - COPERNICUS/S2_SR_HARMONIZED (Sentinel-2 L2A, 10/20m)
//    - MODIS/061/MOD13Q1             (MODIS NDVI, 250m, 16-day)
//    - FIRMS via ee.ImageCollection  (MODIS active fire)
//
//  SPECTRAL BANDS (Sentinel-2):
//    B4  = Red (665nm)
//    B8  = NIR (842nm)     ← Used for NDVI
//    B12 = SWIR2 (2190nm)  ← Used for NBR
//
//  FIRE SEVERITY CLASSES (USGS Key):
//    High Severity:           dNBR ≥  0.660
//    Moderate-High Severity:  dNBR 0.440–0.659
//    Moderate-Low Severity:   dNBR 0.270–0.439
//    Low Severity:            dNBR 0.100–0.269
//    Unburned:                dNBR -0.250–0.099
//
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — EDIT THESE
// ─────────────────────────────────────────────────────────────────────────────

// Region of Interest: Nallamala Hills / Andhra Pradesh (India) — matches dashboard GeoJSON
// Replace with your own coordinates or draw a geometry in the GEE map panel
var ROI = ee.Geometry.Rectangle([78.4, 15.3, 79.6, 16.8]);

// Date ranges
var TODAY       = ee.Date(Date.now());
var POST_START  = TODAY.advance(-7, 'day');   // Last 7 days (post-fire)
var POST_END    = TODAY;
var PRE_START   = TODAY.advance(-21, 'day');  // 21–14 days ago (pre-fire reference)
var PRE_END     = TODAY.advance(-14, 'day');

// Maximum cloud cover allowed (%)
var CLOUD_PCT   = 20;

// Output Google Drive folder
var DRIVE_FOLDER = 'wildfire_analysis_output';

// ─────────────────────────────────────────────────────────────────────────────
// COLOUR PALETTES
// ─────────────────────────────────────────────────────────────────────────────

var dnbr_palette = [
  '#1a7a2e',  // enhanced regrowth high  (< -0.500)
  '#5aae61',  // enhanced regrowth low   (-0.500 to -0.251)
  '#f7f7f7',  // unburned                (-0.250 to +0.099)
  '#fee08b',  // low severity            (+0.100 to +0.269)
  '#fc8d59',  // moderate-low            (+0.270 to +0.439)
  '#d73027',  // moderate-high           (+0.440 to +0.659)
  '#7a0026'   // high severity           (≥ +0.660)
];

var ndvi_palette    = ['#d73027','#fc8d59','#fee08b','#d9ef8b','#91cf60','#1a9850'];
var frp_palette     = ['#ffeda0','#feb24c','#f03b20','#bd0026'];
var severity_colors = ['#fee08b','#fc8d59','#d73027','#7a0026'];  // low → very high

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: LOAD SENTINEL-2 IMAGERY
// ─────────────────────────────────────────────────────────────────────────────

// Cloud masking function (uses Scene Classification Layer, SCL band)
function maskS2clouds(image) {
  var scl = image.select('SCL');
  // SCL classes: 4=Vegetation, 5=Non-Veg, 6=Water, 7=Unclassified
  // Exclude: 3=Cloud Shadow, 8=Cloud Med, 9=Cloud High, 10=Thin Cirrus
  var clearMask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10));
  return image.updateMask(clearMask)
    .divide(10000)  // Scale to 0–1 reflectance
    .copyProperties(image, ['system:time_start', 'CLOUDY_PIXEL_PERCENTAGE']);
}

// Pre-fire composite
var s2_pre = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(ROI)
  .filterDate(PRE_START, PRE_END)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_PCT))
  .map(maskS2clouds)
  .median()
  .clip(ROI);

// Post-fire composite (last 7 days)
var s2_post = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(ROI)
  .filterDate(POST_START, POST_END)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_PCT))
  .map(maskS2clouds)
  .median()
  .clip(ROI);

// Count available scenes for QA
var pre_count  = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(ROI).filterDate(PRE_START,  PRE_END)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_PCT)).size();
var post_count = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(ROI).filterDate(POST_START, POST_END)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_PCT)).size();

print('Pre-fire scenes available:',  pre_count);
print('Post-fire scenes available:', post_count);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: NDVI COMPUTATION (Pre-Fire Vegetation Stress)
// ─────────────────────────────────────────────────────────────────────────────

// NDVI = (B8 - B4) / (B8 + B4)
var ndvi_pre  = s2_pre.normalizedDifference(['B8', 'B4']).rename('NDVI_pre');
var ndvi_post = s2_post.normalizedDifference(['B8', 'B4']).rename('NDVI_post');

// dNDVI = NDVI_post - NDVI_pre (negative = vegetation loss = stress/fire damage)
var dNDVI = ndvi_post.subtract(ndvi_pre).rename('dNDVI');

// Vegetation stress classification
var stress_thresholds = [-0.20, -0.10, -0.05, 0.00];
var stress_class = dNDVI
  .where(dNDVI.gte(-0.05).and(dNDVI.lt(0)),   1)  // slight stress
  .where(dNDVI.gte(-0.10).and(dNDVI.lt(-0.05)), 2)  // moderate stress
  .where(dNDVI.gte(-0.20).and(dNDVI.lt(-0.10)), 3)  // high stress
  .where(dNDVI.lt(-0.20),                         4)  // severe stress
  .toInt().rename('stress_class');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: dNBR BURN SCAR MAPPING
// ─────────────────────────────────────────────────────────────────────────────

// NBR = (B8 - B12) / (B8 + B12)
// Sentinel-2:  B8 = NIR (842nm), B12 = SWIR2 (2190nm)
var nbr_pre  = s2_pre.normalizedDifference(['B8', 'B12']).rename('NBR_pre');
var nbr_post = s2_post.normalizedDifference(['B8', 'B12']).rename('NBR_post');

// dNBR = NBR_pre − NBR_post
var dNBR = nbr_pre.subtract(nbr_post).rename('dNBR');

// Relativised dNBR (Miller & Thode 2007) — use for publication
// RdNBR = dNBR / sqrt(|NBR_pre|)
var rdNBR = dNBR.divide(nbr_pre.abs().sqrt()).rename('RdNBR');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: FIRE SEVERITY CLASSIFICATION (USGS Key)
// ─────────────────────────────────────────────────────────────────────────────

// Re-class dNBR into 4 severity classes (disaster response simplified)
// 1 = Low, 2 = Moderate-Low, 3 = Moderate-High, 4 = High Severity
var severity_4class = ee.Image(0)
  .where(dNBR.gte(0.100).and(dNBR.lt(0.270)), 1)   // Low
  .where(dNBR.gte(0.270).and(dNBR.lt(0.440)), 2)   // Moderate-Low
  .where(dNBR.gte(0.440).and(dNBR.lt(0.660)), 3)   // Moderate-High
  .where(dNBR.gte(0.660),                      4)   // High Severity
  .selfMask()  // Mask out unburned / regrowth pixels
  .rename('severity_4class')
  .clip(ROI);

// Full 7-class USGS classification
var severity_7class = ee.Image(0)
  .where(dNBR.lt(-0.500),                                        1)  // Enhanced Regrowth High
  .where(dNBR.gte(-0.500).and(dNBR.lt(-0.251)),                 2)  // Enhanced Regrowth Low
  .where(dNBR.gte(-0.250).and(dNBR.lt( 0.100)),                 3)  // Unburned
  .where(dNBR.gte( 0.100).and(dNBR.lt( 0.270)),                 4)  // Low Severity
  .where(dNBR.gte( 0.270).and(dNBR.lt( 0.440)),                 5)  // Moderate-Low
  .where(dNBR.gte( 0.440).and(dNBR.lt( 0.660)),                 6)  // Moderate-High
  .where(dNBR.gte( 0.660),                                       7)  // High Severity
  .rename('severity_7class')
  .clip(ROI);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: MODIS ACTIVE FIRE PRODUCT (FRP)
// ─────────────────────────────────────────────────────────────────────────────

// MODIS Terra Active Fire Product (MOD14A1, 1km daily)
// Dataset: MODIS/006/MOD14A1 — MaxFRP band (scaled by 0.1 to get MW)
var modis_fire = ee.ImageCollection('MODIS/006/MOD14A1')
  .filterDate(POST_START, POST_END)
  .filterBounds(ROI)
  .select('MaxFRP')
  .max()  // Maximum FRP in the 7-day period
  .multiply(0.1)  // Scale factor: stored in units of 0.1 MW
  .rename('MaxFRP_MW')
  .clip(ROI);

// FRP intensity classification (MW thresholds)
var frp_class = ee.Image(0)
  .where(modis_fire.gt(0).and(modis_fire.lte(10)),   1)  // Low
  .where(modis_fire.gt(10).and(modis_fire.lte(50)),  2)  // Moderate
  .where(modis_fire.gt(50).and(modis_fire.lte(200)), 3)  // High
  .where(modis_fire.gt(200),                          4)  // Extreme
  .selfMask()
  .rename('FRP_class')
  .clip(ROI);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: AREA STATISTICS
// ─────────────────────────────────────────────────────────────────────────────

// Compute burned area per severity class (hectares)
var pixel_area = ee.Image.pixelArea().divide(10000);  // m² → ha

var severity_area_stats = pixel_area.addBands(severity_4class)
  .reduceRegion({
    reducer: ee.Reducer.sum().group({
      groupField: 1,
      groupName: 'severity_class'
    }),
    geometry:  ROI,
    scale:     20,   // Sentinel-2 SWIR resolution
    maxPixels: 1e10
  });

print('Burned area by severity class (ha):', severity_area_stats);

// Mean dNBR per severity class
var dnbr_stats = dNBR.reduceRegion({
  reducer:   ee.Reducer.mean().combine(ee.Reducer.stdDev(), null, true)
                              .combine(ee.Reducer.minMax(), null, true),
  geometry:  ROI,
  scale:     20,
  maxPixels: 1e10
});
print('dNBR statistics:', dnbr_stats);

// Mean NDVI pre/post
var ndvi_stats = ndvi_pre.addBands(ndvi_post).addBands(dNDVI)
  .reduceRegion({
    reducer:   ee.Reducer.mean(),
    geometry:  ROI,
    scale:     10,
    maxPixels: 1e10
  });
print('NDVI statistics (pre / post / delta):', ndvi_stats);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: VISUALISATION — ADD LAYERS TO MAP
// ─────────────────────────────────────────────────────────────────────────────

Map.centerObject(ROI, 10);

// True Color (post-fire)
Map.addLayer(s2_post, {bands:['B4','B3','B2'], min:0, max:0.3},
             '1. Post-fire True Color (S2)', true);

// False Color (SWIR composite — fire sensitive)
Map.addLayer(s2_post, {bands:['B12','B8','B4'], min:0, max:0.5},
             '2. Post-fire SWIR Composite (B12/B8/B4)', false);

// NDVI (Post-fire)
Map.addLayer(ndvi_post, {min:-0.2, max:0.8, palette: ndvi_palette},
             '3. NDVI Post-fire', false);

// dNDVI (Vegetation Loss)
Map.addLayer(dNDVI, {min:-0.4, max:0.2, palette: ['red','orange','white','green']},
             '4. dNDVI (Vegetation Change)', false);

// dNBR
Map.addLayer(dNBR, {min:-0.5, max:0.9, palette: dnbr_palette},
             '5. dNBR (Burn Severity Index)', true);

// Fire Severity (4-class simplified)
Map.addLayer(severity_4class,
  {min:1, max:4, palette: severity_colors},
  '6. Fire Severity (4-class)', true);

// Fire Severity (7-class USGS)
Map.addLayer(severity_7class,
  {min:1, max:7, palette: dnbr_palette},
  '7. Fire Severity (7-class USGS)', false);

// MODIS FRP (last 7 days max)
Map.addLayer(modis_fire,
  {min:0, max:500, palette: frp_palette},
  '8. MODIS Max FRP (MW, last 7 days)', false);

// FRP Classification
Map.addLayer(frp_class,
  {min:1, max:4, palette: frp_palette},
  '9. FRP Intensity Class (MODIS)', false);

// RdNBR
Map.addLayer(rdNBR,
  {min:-2, max:4, palette: dnbr_palette},
  '10. Relativised dNBR (RdNBR)', false);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8: VECTOR EXPORT — SEVERITY POLYGONS TO GEOJSON
// ─────────────────────────────────────────────────────────────────────────────

// Vectorise severity classes to polygons (for Leaflet / QGIS import)
var severity_vectors = severity_4class.reduceToVectors({
  reducer:        ee.Reducer.countEvery(),
  geometry:       ROI,
  scale:          30,    // Reduced for vector export performance
  maxPixels:      1e10,
  geometryType:   'polygon',
  eightConnected: false,
  labelProperty:  'severity_class',
});

// Add severity label and colour properties
var label_map = ee.Dictionary({
  '1': 'low_severity',
  '2': 'moderate_low_severity',
  '3': 'moderate_high_severity',
  '4': 'high_severity',
});
var color_map = ee.Dictionary({
  '1': '#fee08b',
  '2': '#fc8d59',
  '3': '#d73027',
  '4': '#7a0026',
});

severity_vectors = severity_vectors.map(function(feat) {
  var cls = feat.get('severity_class').toString();
  return feat
    .set('severity_label', label_map.get(cls, 'unburned'))
    .set('fill_color',     color_map.get(cls, '#ffffff'))
    .set('fill_opacity',   0.7)
    .set('stroke',         true)
    .set('weight',         1);
});

// Export severity polygons to Google Drive as GeoJSON / Shapefile
Export.table.toDrive({
  collection:   severity_vectors,
  description:  'fire_severity_polygons_7day',
  folder:       DRIVE_FOLDER,
  fileFormat:   'GeoJSON',
  fileNamePrefix: 'fire_severity_polygons_7day'
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 9: RASTER EXPORTS TO GOOGLE DRIVE
// ─────────────────────────────────────────────────────────────────────────────

// Export dNBR raster (20m resolution)
Export.image.toDrive({
  image:          dNBR,
  description:    'dNBR_burn_severity_20m',
  folder:         DRIVE_FOLDER,
  fileNamePrefix: 'dNBR_burn_severity_20m',
  region:         ROI,
  scale:          20,
  crs:            'EPSG:4326',
  maxPixels:      1e10
});

// Export RdNBR (for publication)
Export.image.toDrive({
  image:          rdNBR,
  description:    'RdNBR_relativised_20m',
  folder:         DRIVE_FOLDER,
  fileNamePrefix: 'RdNBR_relativised_20m',
  region:         ROI,
  scale:          20,
  crs:            'EPSG:4326',
  maxPixels:      1e10
});

// Export dNDVI (10m — Sentinel-2 native NIR resolution)
Export.image.toDrive({
  image:          dNDVI,
  description:    'dNDVI_vegetation_change_10m',
  folder:         DRIVE_FOLDER,
  fileNamePrefix: 'dNDVI_vegetation_change_10m',
  region:         ROI,
  scale:          10,
  crs:            'EPSG:4326',
  maxPixels:      1e10
});

// Export post-fire NDVI
Export.image.toDrive({
  image:          ndvi_post,
  description:    'NDVI_postfire_10m',
  folder:         DRIVE_FOLDER,
  fileNamePrefix: 'NDVI_postfire_10m',
  region:         ROI,
  scale:          10,
  crs:            'EPSG:4326',
  maxPixels:      1e10
});

// Export 7-class severity map
Export.image.toDrive({
  image:          severity_7class,
  description:    'severity_7class_USGS_20m',
  folder:         DRIVE_FOLDER,
  fileNamePrefix: 'severity_7class_USGS_20m',
  region:         ROI,
  scale:          20,
  crs:            'EPSG:4326',
  maxPixels:      1e10
});

// Export MODIS FRP
Export.image.toDrive({
  image:          modis_fire,
  description:    'MODIS_MaxFRP_MW_7day',
  folder:         DRIVE_FOLDER,
  fileNamePrefix: 'MODIS_MaxFRP_MW_7day',
  region:         ROI,
  scale:          1000,   // MODIS native resolution
  crs:            'EPSG:4326',
  maxPixels:      1e10
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 10: GEE ASSET EXPORT (for REST API integration in dashboard)
// ─────────────────────────────────────────────────────────────────────────────

// Export dNBR as GEE Image Asset (needed for dashboard tile overlay via REST API)
Export.image.toAsset({
  image:        dNBR.rename('dNBR'),
  description:  'dNBR_asset_7day',
  assetId:      'users/YOUR_GEE_USERNAME/wildfire_dashboard/dNBR_7day',
  region:       ROI,
  scale:        20,
  maxPixels:    1e10
});

Export.image.toAsset({
  image:        severity_4class,
  description:  'severity_4class_asset',
  assetId:      'users/YOUR_GEE_USERNAME/wildfire_dashboard/severity_4class_7day',
  region:       ROI,
  scale:        20,
  maxPixels:    1e10
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 11: MAP LEGEND (UI Widget)
// ─────────────────────────────────────────────────────────────────────────────

var legend_panel = ui.Panel({
  style: {
    position:        'bottom-right',
    padding:         '8px 15px',
    backgroundColor: '#1a1a2e'
  }
});

var legend_title = ui.Label({
  value: '🔥 dNBR Fire Severity',
  style: { fontWeight: 'bold', fontSize: '14px', color: '#ffffff', margin: '0 0 6px 0' }
});
legend_panel.add(legend_title);

var severity_labels = [
  { label: 'High Severity  (≥ 0.660)',         color: '#7a0026' },
  { label: 'Moderate-High (0.440–0.659)',       color: '#d73027' },
  { label: 'Moderate-Low  (0.270–0.439)',       color: '#fc8d59' },
  { label: 'Low Severity  (0.100–0.269)',       color: '#fee08b' },
  { label: 'Unburned      (-0.250–0.099)',      color: '#f7f7f7' },
  { label: 'Enhanced Regrowth (< -0.250)',      color: '#5aae61' },
];

severity_labels.forEach(function(item) {
  var row = ui.Panel({ layout: ui.Panel.Layout.Flow('horizontal') });
  row.add(ui.Label({ value: '█', style: { color: item.color, margin: '0 6px 0 0', fontSize: '14px' } }));
  row.add(ui.Label({ value: item.label, style: { color: '#dddddd', fontSize: '11px' } }));
  legend_panel.add(row);
});

Map.add(legend_panel);

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE — Check Tasks panel for export progress
// ─────────────────────────────────────────────────────────────────────────────

print('══════════════════════════════════════════');
print('✅  GEE Fire Analysis Script Complete');
print('══════════════════════════════════════════');
print('Region:', ROI.coordinates());
print('Post-fire window: Last 7 days');
print('Exports queued to Drive folder:', DRIVE_FOLDER);
print('Check the Tasks panel → to run exports.');
print('');
print('Key dNBR thresholds (USGS):');
print('  High Severity:        dNBR ≥ 0.660');
print('  Moderate-High:   0.440–0.659');
print('  Moderate-Low:    0.270–0.439');
print('  Low Severity:    0.100–0.269');
print('  Unburned:        -0.250–0.099');
print('');
print('⚠️  DATA GAPS TO NOTE:');
print('  - Cloud cover may mask post-fire pixels in monsoon season');
print('  - SWIR2 (B12) resolution is 20m vs B8 10m — resampled to 20m');
print('  - GEE temporal latency: S2 L2A typically 1–3 days behind real-time');
print('  - Replace assetId paths with your GEE username before Asset export');
