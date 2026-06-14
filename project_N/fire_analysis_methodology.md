# 🔥 GIS Fire Analysis — Complete Research Methodology
## VIIRS 375m + MODIS 1km | Last 7 Days | Disaster Response Context

---

## Table of Contents
1. [Data Acquisition](#1-data-acquisition)
2. [Active Fire Detection](#2-active-fire-detection)
3. [Burn Scar Mapping (dNBR)](#3-burn-scar-mapping-dnbr)
4. [Vegetation Stress & Pre-Fire Risk (NDVI)](#4-vegetation-stress--pre-fire-risk)
5. [Fire Severity Classification](#5-fire-severity-classification)
6. [Output Formats](#6-output-formats)
7. [Data Gaps & Known Issues](#7-data-gaps--known-issues)
8. [Validation & Accuracy Assessment](#8-validation--accuracy-assessment)

---

## 1. Data Acquisition

### 1.1 NASA FIRMS — Active Fire Data

**Base URL:** `https://firms.modaps.eosdis.nasa.gov/api/`

**Step 1:** Get a free MAP_KEY at:
`https://firms.modaps.eosdis.nasa.gov/api/map_key/`

**Step 2:** Use the following endpoints to fetch CSVs for the last 7 days:

| Sensor | Resolution | Endpoint Template |
|--------|-----------|-------------------|
| VIIRS S-NPP | 375m | `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_SNPP_NRT/{WEST},{SOUTH},{EAST},{NORTH}/7` |
| VIIRS NOAA-20 | 375m | `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_NOAA20_NRT/{WEST},{SOUTH},{EAST},{NORTH}/7` |
| MODIS Terra | 1km | `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/MODIS_NRT/{WEST},{SOUTH},{EAST},{NORTH}/7` |

**Global fetch (no bbox):**
```
https://firms.modaps.eosdis.nasa.gov/api/country/csv/{MAP_KEY}/VIIRS_SNPP_NRT/IND/7
```

**CSV Column Schema (VIIRS):**
```
latitude, longitude, bright_ti4, scan, track, acq_date, acq_time, satellite, instrument,
confidence, version, bright_ti5, frp, daynight
```

**CSV Column Schema (MODIS):**
```
latitude, longitude, brightness, scan, track, acq_date, acq_time, satellite, instrument,
confidence, version, bright_t31, frp, daynight
```

---

### 1.2 NASA Earthdata — Sentinel-2 / Landsat 9 (for dNBR)

**Dataset:** Sentinel-2 Level-2A via Copernicus Open Access Hub
- **URL:** `https://scihub.copernicus.eu/dhus/`
- **Free alternative (no account):** `https://browser.dataspace.copernicus.eu/`

**OpenSearch API (Sentinel-2):**
```
https://catalogue.dataspace.copernicus.eu/odata/v1/Products?$filter=
  Collection/Name eq 'SENTINEL-2' and
  OData.CSC.Intersects(area=geography'SRID=4326;POLYGON((...))')  and
  ContentDate/Start gt 2026-05-24T00:00:00.000Z and
  ContentDate/Start lt 2026-05-31T00:00:00.000Z and
  Attributes/OData.CSC.DoubleAttribute/any(att:att/Name eq 'cloudCover' and att/OData.CSC.DoubleAttribute/Value lt 30)
```

**Landsat 9 via USGS EarthExplorer:**
- URL: `https://earthexplorer.usgs.gov/`
- Dataset ID: `landsat_ot_c2_l2` (Collection 2 Level-2)
- Machine API: `https://m2m.cr.usgs.gov/api/api/json/stable/`

**Google Earth Engine Datasets:**
```javascript
// Pre-fire image (7+ days before event)
var prefire = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterDate('2026-05-17', '2026-05-24')
  .filterBounds(roi)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .median();

// Post-fire image (last 7 days)
var postfire = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterDate('2026-05-24', '2026-05-31')
  .filterBounds(roi)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .median();
```

---

## 2. Active Fire Detection

### 2.1 VIIRS 375m — Thermal Anomaly Detection

**Algorithm:** VIIRS Active Fire Product (VNP14IMG, VJ114IMG)
- **Sensor bands used:** Band I4 (3.74 µm, MIR), Band I5 (11.45 µm, TIR)
- **Fire pixel algorithm:** Contextual algorithm comparing candidate pixels to background

**FRP (Fire Radiative Power) Formula:**
```
FRP (MW) = 4.34 × 10⁻¹⁹ × σ × A × (T_fire⁴ - T_background⁴)
```
Where:
- σ = Stefan-Boltzmann constant = 5.67 × 10⁻⁸ W m⁻² K⁻⁴
- A = pixel area (m²) = 375² = 140,625 m²
- T_fire, T_background = brightness temperatures in Kelvin

**Confidence Thresholds (VIIRS):**

| Confidence Value | Classification |
|-----------------|----------------|
| `n` (nominal) | Use for broad monitoring |
| `l` (low) | Possible fire, high false-alarm risk |
| `h` (high) | High-confidence fire detection |

**FRP Thresholds for Disaster Response:**

| FRP (MW) | Fire Intensity Class |
|----------|---------------------|
| 0 – 10 | Low intensity |
| 10 – 50 | Moderate intensity |
| 50 – 200 | High intensity |
| > 200 | Extreme / megafire |

**MODIS — Bands Used:**
- Band 21/22 (3.959 µm, MIR) — fire detection
- Band 31 (11.03 µm, TIR) — background thermal
- Band 32 (12.02 µm, TIR) — atmospheric correction

---

## 3. Burn Scar Mapping (dNBR)

### 3.1 NBR Formula

```
NBR = (NIR - SWIR2) / (NIR + SWIR2)
```

**Band Assignments:**

| Sensor | NIR Band | SWIR2 Band |
|--------|---------|-----------|
| Sentinel-2 | B8 (842 nm) | B12 (2190 nm) |
| Landsat 9 OLI | Band 5 (865 nm) | Band 7 (2200 nm) |
| MODIS | Band 2 (865 nm) | Band 7 (2130 nm) |

### 3.2 dNBR (Differenced NBR)

```
dNBR = NBR_prefire − NBR_postfire
```

**Rescaled dNBR (for comparison across studies):**
```
RdNBR = dNBR / √|NBR_prefire|
```

### 3.3 Fire Severity Classes (USGS Key)

| dNBR Range | Severity Class | Color Code |
|------------|---------------|-----------|
| < -0.500 | Enhanced Regrowth (High) | Dark Green |
| -0.500 to -0.251 | Enhanced Regrowth (Low) | Light Green |
| -0.250 to +0.099 | Unburned | Yellow |
| +0.100 to +0.269 | Low Severity | Pale Orange |
| +0.270 to +0.439 | Moderate-Low Severity | Orange |
| +0.440 to +0.659 | Moderate-High Severity | Red |
| > +0.660 | High Severity | Dark Red / Maroon |

---

## 4. Vegetation Stress & Pre-Fire Risk

### 4.1 NDVI Formula

```
NDVI = (NIR − Red) / (NIR + Red)
```

**Band Assignments:**

| Sensor | NIR | Red |
|--------|-----|-----|
| Sentinel-2 | B8 (842nm) | B4 (665nm) |
| Landsat 9 | Band 5 | Band 4 |
| MODIS | Band 2 | Band 1 |

### 4.2 NDVI Decline Analysis

```
dNDVI = NDVI_current − NDVI_baseline
```
Where baseline = same 7-day window from prior year (or 5-year mean).

**Vegetation Stress Thresholds:**

| dNDVI Value | Interpretation |
|-------------|---------------|
| > 0 | Normal/improved vegetation |
| -0.05 to 0 | Slight stress |
| -0.10 to -0.05 | Moderate stress — elevated pre-fire risk |
| -0.20 to -0.10 | High stress — critical pre-fire risk |
| < -0.20 | Severe stress / drought-driven die-off |

### 4.3 Pre-Fire Risk Index (Composite)

```
PFR_Index = w1×(1-NDVI_normalized) + w2×(FRP_density) + w3×(slope_factor) + w4×(wind_speed)
```
Recommended weights: w1=0.35, w2=0.25, w3=0.20, w4=0.20

---

## 5. Fire Severity Classification

### 5.1 dNBR-Based Classification Workflow

1. Acquire pre/post fire Sentinel-2 or Landsat 9 imagery
2. Apply atmospheric correction (BOA reflectance for S2 L2A, already corrected)
3. Mask clouds using SCL band (Sentinel-2) or QA_PIXEL band (Landsat)
4. Compute NBR for both epochs
5. Compute dNBR = NBR_pre − NBR_post
6. Apply USGS severity thresholds
7. Vectorize severity classes to polygon GeoJSON
8. Compute area statistics per class

### 5.2 Composite Severity Score

For multi-temporal robustness, use median composite:
```javascript
// GEE
var preNBR = prefire.normalizedDifference(['B8', 'B12']).rename('NBR_pre');
var postNBR = postfire.normalizedDifference(['B8', 'B12']).rename('NBR_post');
var dNBR = preNBR.subtract(postNBR).rename('dNBR');
```

---

## 6. Output Formats

### 6.1 GeoJSON Schema (Active Fires)

```json
{
  "type": "FeatureCollection",
  "metadata": {
    "source": "NASA FIRMS — VIIRS SNPP + NOAA20 + MODIS",
    "generated": "2026-05-31T00:00:00Z",
    "days": 7,
    "total_features": 0
  },
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [longitude, latitude]
      },
      "properties": {
        "acq_date": "YYYY-MM-DD",
        "acq_time": "HHMM",
        "satellite": "N (NOAA-20) | S (Suomi NPP) | T (Terra) | A (Aqua)",
        "frp": 0.0,
        "confidence": "n|l|h",
        "bright_ti4": 0.0,
        "daynight": "D|N",
        "sensor": "VIIRS|MODIS",
        "severity_class": "low|moderate|high|extreme"
      }
    }
  ]
}
```

### 6.2 CSV Schema

```csv
latitude,longitude,frp,confidence,acq_date,acq_time,satellite,bright_ti4,bright_ti5,daynight,sensor,severity_class
```

---

## 7. Data Gaps & Known Issues

| Issue | Sensor | Impact | Mitigation |
|-------|--------|--------|-----------|
| **Cloud cover** | VIIRS, MODIS | Optical bands masked; thermal (MIR) partially penetrates smoke | Use SAR (Sentinel-1) for smoke-obscured regions |
| **Temporal latency** | VIIRS NRT | 1–3 hours after overpass | Use both NOAA-20 & Suomi NPP for combined ~3h revisit |
| **MODIS saturation** | MODIS | Pixels saturate above ~800 MW FRP | Supplement with VIIRS 375m for extreme fires |
| **Bowtie effect** | MODIS | Duplicate pixels at scan edges | Use Collection 6.1 which corrects bowtie overlap |
| **Sub-pixel fires** | Both | Small fires (<0.1 ha) may go undetected | VIIRS 375m outperforms MODIS 1km for small fires |
| **GIBS tile latency** | NASA GIBS | WMTS tiles have 24–48h latency; use D-2 date | Hardcode offset in GIBS requests: `date - 2 days` |
| **Commission errors** | Both | Industrial heat sources, volcanoes flagged as fires | Use land cover mask to exclude industrial zones |
| **Night vs Day** | Both | Daytime pixels slightly over-estimated FRP due to solar reflection in MIR | Flag with `daynight` column; analyze separately |
| **Smoke aerosol** | Sentinel-2 | High aerosol loads corrupt BOA reflectance | Apply aerosol optical depth (AOD) correction; use MODIS MCD19A2 |

---

## 8. Validation & Accuracy Assessment

### 8.1 Omission & Commission Error Matrix

Construct a standard binary confusion matrix using independent validation data:

| | Detected (Fire) | Detected (No-Fire) |
|---|---|---|
| **Reference (Fire)** | True Positive (TP) | False Negative (FN) → Omission Error |
| **Reference (No-Fire)** | False Positive (FP) → Commission Error | True Negative (TN) |

**Metrics:**
```
Producer's Accuracy (Recall) = TP / (TP + FN)
User's Accuracy (Precision)  = TP / (TP + FP)
Overall Accuracy             = (TP + TN) / Total
F1-Score                     = 2 × (Precision × Recall) / (Precision + Recall)
Kappa Coefficient            = (OA - Pe) / (1 - Pe)
```

### 8.2 Reference Data Sources for Validation

1. **Ground truth:** Fire department incident reports, NRSC fire alert database (India)
2. **Cross-sensor validation:** Compare VIIRS vs MODIS detections; disagreements = suspect pixels
3. **High-resolution imagery:** Planet Labs (3m), Google Earth historical imagery
4. **Field validation:** GPS-logged field survey points with burn/no-burn labels

### 8.3 dNBR Accuracy Assessment

- **Reference dataset:** Field-measured CBI (Composite Burn Index) plots
- **Regression analysis:** Linear regression between CBI and dNBR (R² target > 0.70)
- **RMSE calculation:** Root Mean Square Error per severity class
- **Cross-validation:** k-fold (k=5) spatial cross-validation to avoid spatial autocorrelation bias

### 8.4 Publication-Suitable Metrics

For peer-reviewed publication, report:
- Kappa coefficient with 95% CI (bootstrap)
- Per-class accuracy (Producer's + User's)
- Area-weighted accuracy if class imbalance present
- Spatial autocorrelation test (Moran's I) on residuals
- Comparison against established products (e.g., MCD64A1 burn area product)
