#!/usr/bin/env python3
"""
=============================================================================
  GLOBAL REAL-TIME WILDFIRE ANALYSIS PIPELINE
  VIIRS 375m (NOAA-20 / Suomi NPP) + MODIS 1km (Terra / Aqua)
  Last 7 Days | Disaster Response & Emergency Management
=============================================================================

  RESEARCH CONTEXT:
    - B.Tech Geoinformatics — JNTUH Hyderabad
    - Dashboard: Global Real-Time Wildfire Monitoring System
    - Region: India subcontinent (expandable to global)

  TASKS COVERED:
    1. Active fire detection with FRP thresholding
    2. Burn scar mapping (dNBR via GEE REST API)
    3. Vegetation stress / pre-fire risk (NDVI decline)
    4. Fire severity classification (4-class USGS scheme)

  OUTPUT:
    - GeoJSON (Leaflet / QGIS compatible)
    - CSV (lat/lon/FRP/confidence)
    - Severity polygon GeoJSON

  USAGE:
    pip install requests pandas geopandas shapely numpy matplotlib
    python fire_analysis_pipeline.py --key YOUR_FIRMS_MAP_KEY --days 7

  DATA SOURCES:
    - NASA FIRMS API:  https://firms.modaps.eosdis.nasa.gov/api/
    - NASA GIBS:       https://gibs.earthdata.nasa.gov/
    - Copernicus:      https://catalogue.dataspace.copernicus.eu/

=============================================================================
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from io import StringIO

import numpy as np
import pandas as pd
import requests
import warnings

warnings.filterwarnings("ignore")

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────

# NASA FIRMS API
FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api"

# Default Region of Interest — Indian subcontinent
# Format: west, south, east, north  (WGS84 decimal degrees)
DEFAULT_BBOX = "66.0,6.0,97.5,37.5"

# GEE REST API base (requires OAuth2 access token)
GEE_BASE = "https://earthengine.googleapis.com/v1alpha/projects/earthengine-public/maps"

# Severity classification (USGS key)
SEVERITY_CLASSES = {
    "enhanced_regrowth_high":  (-999.0, -0.500),
    "enhanced_regrowth_low":   (-0.500, -0.251),
    "unburned":                (-0.250,  0.099),
    "low_severity":             (0.100,  0.269),
    "moderate_low_severity":    (0.270,  0.439),
    "moderate_high_severity":   (0.440,  0.659),
    "high_severity":            (0.660,  999.0),
}

SEVERITY_COLORS = {
    "enhanced_regrowth_high":   "#1a7a2e",
    "enhanced_regrowth_low":    "#5aae61",
    "unburned":                 "#f7f7f7",
    "low_severity":             "#fee08b",
    "moderate_low_severity":    "#fc8d59",
    "moderate_high_severity":   "#d73027",
    "high_severity":            "#7a0026",
}

# ─────────────────────────────────────────────────────────────────────────────
# HELPER FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

def log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    symbol = {"INFO": "ℹ️", "SUCCESS": "✅", "WARN": "⚠️", "ERROR": "❌"}.get(level, "•")
    print(f"[{ts}] {symbol}  {msg}")


def classify_frp(frp: float) -> str:
    """Classify FRP into intensity categories for emergency management."""
    if frp is None or math.isnan(float(frp)):
        return "unknown"
    frp = float(frp)
    if frp < 10:    return "low"
    if frp < 50:    return "moderate"
    if frp < 200:   return "high"
    return "extreme"


def classify_severity(dnbr: float) -> str:
    """Map dNBR value to USGS fire severity class."""
    for cls, (lo, hi) in SEVERITY_CLASSES.items():
        if lo <= dnbr < hi:
            return cls
    return "high_severity"


def bbox_str_to_list(bbox: str) -> list:
    """Parse 'west,south,east,north' string to [west, south, east, north] floats."""
    return [float(x.strip()) for x in bbox.split(",")]


# ─────────────────────────────────────────────────────────────────────────────
# TASK 1: ACTIVE FIRE DETECTION — NASA FIRMS
# ─────────────────────────────────────────────────────────────────────────────

class FIRMSFetcher:
    """
    Fetches near-real-time active fire data from NASA FIRMS API.

    Sensors supported:
      - VIIRS_SNPP_NRT  : Suomi NPP, 375m resolution
      - VIIRS_NOAA20_NRT: NOAA-20,  375m resolution
      - MODIS_NRT       : Terra/Aqua, 1km resolution

    API documentation:
      https://firms.modaps.eosdis.nasa.gov/api/
    """

    SOURCES = {
        "VIIRS_SNPP":    "VIIRS_SNPP_NRT",
        "VIIRS_NOAA20":  "VIIRS_NOAA20_NRT",
        "MODIS":         "MODIS_NRT",
    }

    def __init__(self, map_key: str, bbox: str = DEFAULT_BBOX, days: int = 7):
        self.map_key = map_key
        self.bbox = bbox
        self.days = days
        self.raw_dfs = {}

    def _build_url(self, source_id: str) -> str:
        return f"{FIRMS_BASE}/area/csv/{self.map_key}/{source_id}/{self.bbox}/{self.days}"

    def fetch_source(self, label: str, source_id: str) -> pd.DataFrame | None:
        url = self._build_url(source_id)
        log(f"Fetching {label} from: {url}")
        try:
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            content = resp.text.strip()

            # FIRMS returns "VIIRS data is not available" for empty results
            if "not available" in content.lower() or len(content) < 50:
                log(f"No data returned for {label} in the specified region/period.", "WARN")
                return None

            df = pd.read_csv(StringIO(content))
            df["_source"] = label
            df["_sensor"] = "VIIRS" if "VIIRS" in label else "MODIS"
            log(f"  → {len(df):,} detections fetched ({label})", "SUCCESS")
            return df
        except requests.RequestException as e:
            log(f"HTTP error fetching {label}: {e}", "ERROR")
            return None
        except pd.errors.ParserError as e:
            log(f"CSV parse error for {label}: {e}", "ERROR")
            return None

    def fetch_all(self) -> pd.DataFrame:
        frames = []
        for label, source_id in self.SOURCES.items():
            df = self.fetch_source(label, source_id)
            if df is not None:
                frames.append(df)

        if not frames:
            log("No fire data retrieved from any source.", "ERROR")
            return pd.DataFrame()

        combined = pd.concat(frames, ignore_index=True)

        # ── Standardise columns ──────────────────────────────────────────────
        # VIIRS uses bright_ti4; MODIS uses brightness — normalise to bright_ti4
        if "brightness" in combined.columns:
            combined["bright_ti4"] = combined.get("bright_ti4", combined["brightness"])

        required_cols = ["latitude", "longitude", "frp", "confidence", "acq_date",
                         "acq_time", "satellite", "daynight", "_source", "_sensor"]
        for col in required_cols:
            if col not in combined.columns:
                combined[col] = None

        # ── FRP thresholding & classification ───────────────────────────────
        combined["frp"] = pd.to_numeric(combined["frp"], errors="coerce").fillna(0.0)
        combined["frp_class"] = combined["frp"].apply(classify_frp)

        # ── Confidence normalisation ─────────────────────────────────────────
        # VIIRS:  'n', 'l', 'h'  |  MODIS: 0–100 numeric
        combined["confidence_raw"] = combined["confidence"].astype(str)
        combined["confidence_label"] = combined["confidence_raw"].apply(
            self._normalise_confidence
        )

        # ── Timestamp ────────────────────────────────────────────────────────
        combined["acq_datetime"] = pd.to_datetime(
            combined["acq_date"].astype(str) + " " +
            combined["acq_time"].astype(str).str.zfill(4),
            format="%Y-%m-%d %H%M", errors="coerce"
        )

        log(f"Total merged detections: {len(combined):,}", "SUCCESS")
        return combined

    @staticmethod
    def _normalise_confidence(raw: str) -> str:
        if raw in ("h", "high"):    return "high"
        if raw in ("l", "low"):     return "low"
        if raw in ("n", "nominal"): return "nominal"
        try:
            val = int(raw)
            if val >= 80: return "high"
            if val >= 50: return "nominal"
            return "low"
        except ValueError:
            return "nominal"


# ─────────────────────────────────────────────────────────────────────────────
# TASK 2: NDVI DECLINE ANALYSIS (Vegetation Stress / Pre-Fire Risk)
# ─────────────────────────────────────────────────────────────────────────────

class NDVIAnalyser:
    """
    Estimates NDVI decline from NASA GIBS WMTS tiles or user-supplied arrays.

    For a fully automated pipeline, use Google Earth Engine (GEE script below).
    This class demonstrates the algorithm with synthetic sample data when GEE
    access is unavailable.
    """

    @staticmethod
    def compute_ndvi(nir: np.ndarray, red: np.ndarray) -> np.ndarray:
        """
        NDVI = (NIR − Red) / (NIR + Red)
        Bands:
          Sentinel-2: NIR=B8 (842nm), Red=B4 (665nm)
          Landsat 9:  NIR=Band5,      Red=Band4
          MODIS:      NIR=Band2,      Red=Band1
        """
        nir  = nir.astype(float)
        red  = red.astype(float)
        denom = nir + red
        denom = np.where(denom == 0, np.nan, denom)
        return (nir - red) / denom

    @staticmethod
    def compute_ndvi_decline(ndvi_current: np.ndarray,
                              ndvi_baseline: np.ndarray) -> np.ndarray:
        """
        dNDVI = NDVI_current − NDVI_baseline
        Negative values indicate vegetation stress / die-off.
        Baseline: same 7-day window from prior year or 5-year mean.
        """
        return ndvi_current - ndvi_baseline

    @staticmethod
    def classify_stress(dndvi: np.ndarray) -> np.ndarray:
        """
        Map dNDVI values to pre-fire risk classes.
        Returns string array matching input shape.
        """
        classes = np.full(dndvi.shape, "normal", dtype=object)
        classes = np.where(dndvi <  0.00,  "slight_stress",   classes)
        classes = np.where(dndvi < -0.05,  "moderate_stress", classes)
        classes = np.where(dndvi < -0.10,  "high_stress",     classes)
        classes = np.where(dndvi < -0.20,  "severe_stress",   classes)
        return classes

    @staticmethod
    def pre_fire_risk_index(ndvi: np.ndarray,
                             frp_density: np.ndarray,
                             slope: np.ndarray,
                             wind_speed: np.ndarray,
                             weights: tuple = (0.35, 0.25, 0.20, 0.20)) -> np.ndarray:
        """
        Composite Pre-Fire Risk Index (0–1).
        PFR = w1*(1-NDVI_n) + w2*FRP_density_n + w3*slope_n + w4*wind_n
        All inputs should be normalised 0–1.
        """
        w1, w2, w3, w4 = weights
        return (w1 * (1 - ndvi) + w2 * frp_density +
                w3 * slope + w4 * wind_speed)


# ─────────────────────────────────────────────────────────────────────────────
# TASK 3 & 4: dNBR + SEVERITY CLASSIFICATION (using sample data)
# ─────────────────────────────────────────────────────────────────────────────

class BurnScarAnalyser:
    """
    Compute dNBR and classify fire severity.
    For production use, run the companion GEE script (fire_analysis_gee.js).

    NBR = (NIR − SWIR2) / (NIR + SWIR2)
    dNBR = NBR_prefire − NBR_postfire

    Bands:
      Sentinel-2: NIR=B8 (842nm), SWIR2=B12 (2190nm)
      Landsat 9:  NIR=Band5,      SWIR2=Band7
      MODIS:      NIR=Band2,      SWIR2=Band7
    """

    @staticmethod
    def compute_nbr(nir: np.ndarray, swir2: np.ndarray) -> np.ndarray:
        nir   = nir.astype(float)
        swir2 = swir2.astype(float)
        denom = nir + swir2
        denom = np.where(denom == 0, np.nan, denom)
        return (nir - swir2) / denom

    @staticmethod
    def compute_dnbr(nbr_pre: np.ndarray, nbr_post: np.ndarray) -> np.ndarray:
        return nbr_pre - nbr_post

    @staticmethod
    def compute_rdnbr(dnbr: np.ndarray, nbr_pre: np.ndarray) -> np.ndarray:
        """
        Relativised dNBR — normalises dNBR by pre-fire vegetation level.
        Better for inter-site comparisons in peer-reviewed literature.
        RdNBR = dNBR / sqrt(|NBR_pre|)
        """
        denom = np.sqrt(np.abs(nbr_pre))
        denom = np.where(denom == 0, np.nan, denom)
        return dnbr / denom

    @staticmethod
    def classify_dnbr(dnbr: np.ndarray) -> np.ndarray:
        """
        Apply USGS dNBR classification key.
        Returns string array with severity class names.
        """
        out = np.full(dnbr.shape, "unburned", dtype=object)
        out[dnbr < -0.500]                         = "enhanced_regrowth_high"
        out[(dnbr >= -0.500) & (dnbr < -0.251)]   = "enhanced_regrowth_low"
        out[(dnbr >= -0.250) & (dnbr <  0.100)]   = "unburned"
        out[(dnbr >=  0.100) & (dnbr <  0.270)]   = "low_severity"
        out[(dnbr >=  0.270) & (dnbr <  0.440)]   = "moderate_low_severity"
        out[(dnbr >=  0.440) & (dnbr <  0.660)]   = "moderate_high_severity"
        out[dnbr  >= 0.660]                         = "high_severity"
        return out

    def area_statistics(self, classified: np.ndarray,
                         pixel_area_m2: float = 100.0) -> dict:
        """
        Compute burned area per severity class.
        Default pixel_area_m2 = 10m × 10m = 100m² (Sentinel-2 10m bands)
        Returns dict: {class_name: area_ha}
        """
        stats = {}
        for cls in SEVERITY_CLASSES:
            count = np.sum(classified == cls)
            area_ha = (count * pixel_area_m2) / 10000  # m² → ha
            stats[cls] = round(area_ha, 2)
        return stats


# ─────────────────────────────────────────────────────────────────────────────
# TASK 5: OUTPUT EXPORTERS
# ─────────────────────────────────────────────────────────────────────────────

class DataExporter:
    """
    Export fire detection data to GeoJSON and CSV.
    GeoJSON is Leaflet / QGIS compatible (WGS84, RFC 7946).
    """

    @staticmethod
    def to_csv(df: pd.DataFrame, output_path: str) -> None:
        """
        Export standardised CSV with lat/lon/FRP/confidence columns.
        """
        if df.empty:
            log("DataFrame is empty — skipping CSV export.", "WARN")
            return

        # Select and reorder columns for publication-ready output
        cols = ["latitude", "longitude", "frp", "confidence_label", "frp_class",
                "acq_date", "acq_time", "acq_datetime", "satellite", "daynight",
                "_source", "_sensor", "bright_ti4"]

        available = [c for c in cols if c in df.columns]
        export_df = df[available].copy()

        # Rename for publication clarity
        rename_map = {
            "confidence_label": "confidence",
            "frp_class": "intensity_class",
            "_source": "data_source",
            "_sensor": "sensor",
            "bright_ti4": "brightness_K",
            "acq_datetime": "datetime_utc"
        }
        export_df.rename(columns={k: v for k, v in rename_map.items()
                                   if k in export_df.columns}, inplace=True)

        export_df.to_csv(output_path, index=False)
        log(f"CSV exported → {output_path} ({len(export_df):,} rows)", "SUCCESS")

    @staticmethod
    def to_geojson(df: pd.DataFrame, output_path: str,
                   description: str = "Active fire detections — last 7 days") -> None:
        """
        Export Leaflet/QGIS-ready GeoJSON (RFC 7946, WGS84).
        """
        if df.empty:
            log("DataFrame is empty — skipping GeoJSON export.", "WARN")
            return

        features = []
        for _, row in df.iterrows():
            try:
                lat = float(row.get("latitude", 0))
                lon = float(row.get("longitude", 0))
                frp = float(row.get("frp", 0))
            except (ValueError, TypeError):
                continue

            props = {
                "acq_date":     str(row.get("acq_date", "")),
                "acq_time":     str(row.get("acq_time", "")),
                "satellite":    str(row.get("satellite", "")),
                "frp":          round(frp, 2),
                "confidence":   str(row.get("confidence_label", row.get("confidence", ""))),
                "intensity":    str(row.get("frp_class", classify_frp(frp))),
                "daynight":     str(row.get("daynight", "")),
                "sensor":       str(row.get("_sensor", "")),
                "source":       str(row.get("_source", "")),
                "brightness_K": float(row.get("bright_ti4", 0) or 0),
            }

            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat]
                },
                "properties": props
            }
            features.append(feature)

        geojson = {
            "type": "FeatureCollection",
            "metadata": {
                "description": description,
                "generated_utc": datetime.now(timezone.utc).isoformat(),
                "total_features": len(features),
                "bbox": DEFAULT_BBOX,
                "days": 7,
                "sensors": ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"],
                "crs": "WGS84 (EPSG:4326)",
                "frp_unit": "MW (Megawatts)",
                "confidence_values": "high | nominal | low"
            },
            "features": features
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, indent=2, ensure_ascii=False)

        log(f"GeoJSON exported → {output_path} ({len(features):,} features)", "SUCCESS")

    @staticmethod
    def severity_to_geojson(burn_features: list, output_path: str) -> None:
        """
        Export burn scar severity polygons as GeoJSON.
        Input: list of dicts with keys: geometry, class_name, area_ha, dnbr_mean
        """
        features = []
        for feat in burn_features:
            cls = feat.get("class_name", "unknown")
            feature = {
                "type": "Feature",
                "geometry": feat.get("geometry"),
                "properties": {
                    "severity_class": cls,
                    "dnbr_mean":      round(feat.get("dnbr_mean", 0.0), 3),
                    "area_ha":        round(feat.get("area_ha", 0.0), 2),
                    "fill_color":     SEVERITY_COLORS.get(cls, "#999999"),
                    "fill_opacity":   0.7,
                    "stroke":         True,
                    "weight":         1,
                }
            }
            features.append(feature)

        geojson = {
            "type": "FeatureCollection",
            "metadata": {
                "description": "dNBR Fire Severity Classification — USGS Key",
                "generated_utc": datetime.now(timezone.utc).isoformat(),
                "severity_scheme": "USGS Burn Severity Classification",
                "reference": "https://burnseverity.cr.usgs.gov/",
            },
            "features": features
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, indent=2)

        log(f"Severity GeoJSON → {output_path} ({len(features)} polygons)", "SUCCESS")


# ─────────────────────────────────────────────────────────────────────────────
# VALIDATION MODULE
# ─────────────────────────────────────────────────────────────────────────────

class AccuracyAssessment:
    """
    Binary confusion matrix statistics for fire detection validation.
    Supports omission/commission error computation for publication.
    """

    def __init__(self, tp: int, fp: int, fn: int, tn: int):
        self.tp = tp
        self.fp = fp
        self.fn = fn
        self.tn = tn
        self.total = tp + fp + fn + tn

    @property
    def overall_accuracy(self) -> float:
        return (self.tp + self.tn) / self.total if self.total else 0

    @property
    def producers_accuracy(self) -> float:  # Recall / sensitivity
        return self.tp / (self.tp + self.fn) if (self.tp + self.fn) else 0

    @property
    def users_accuracy(self) -> float:  # Precision
        return self.tp / (self.tp + self.fp) if (self.tp + self.fp) else 0

    @property
    def f1_score(self) -> float:
        p = self.users_accuracy
        r = self.producers_accuracy
        return 2 * p * r / (p + r) if (p + r) else 0

    @property
    def kappa(self) -> float:
        """Cohen's Kappa Coefficient."""
        po = self.overall_accuracy
        pe = (((self.tp + self.fp) * (self.tp + self.fn) +
               (self.fn + self.tn) * (self.fp + self.tn)) / self.total ** 2)
        return (po - pe) / (1 - pe) if (1 - pe) else 0

    @property
    def omission_error(self) -> float:
        return 1 - self.producers_accuracy

    @property
    def commission_error(self) -> float:
        return 1 - self.users_accuracy

    def report(self) -> dict:
        return {
            "TP": self.tp, "FP": self.fp, "FN": self.fn, "TN": self.tn,
            "Overall_Accuracy":    round(self.overall_accuracy, 4),
            "Producers_Accuracy":  round(self.producers_accuracy, 4),
            "Users_Accuracy":      round(self.users_accuracy, 4),
            "Omission_Error":      round(self.omission_error, 4),
            "Commission_Error":    round(self.commission_error, 4),
            "F1_Score":            round(self.f1_score, 4),
            "Kappa":               round(self.kappa, 4),
        }

    def print_report(self) -> None:
        r = self.report()
        print("\n" + "═" * 50)
        print("  🎯  ACCURACY ASSESSMENT REPORT")
        print("═" * 50)
        print(f"  Confusion Matrix:   TP={r['TP']}, FP={r['FP']}, FN={r['FN']}, TN={r['TN']}")
        print(f"  Overall Accuracy:   {r['Overall_Accuracy']:.4f}  ({r['Overall_Accuracy']*100:.1f}%)")
        print(f"  Producer's Acc:     {r['Producers_Accuracy']:.4f}  (Recall / Sensitivity)")
        print(f"  User's Accuracy:    {r['Users_Accuracy']:.4f}  (Precision)")
        print(f"  F1 Score:           {r['F1_Score']:.4f}")
        print(f"  Kappa Coefficient:  {r['Kappa']:.4f}")
        print(f"  Omission Error:     {r['Omission_Error']:.4f}")
        print(f"  Commission Error:   {r['Commission_Error']:.4f}")
        print("═" * 50 + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY STATISTICS
# ─────────────────────────────────────────────────────────────────────────────

def print_summary(df: pd.DataFrame) -> None:
    if df.empty:
        log("No data to summarise.", "WARN")
        return

    print("\n" + "═" * 60)
    print("  🔥  WILDFIRE DETECTION SUMMARY — LAST 7 DAYS")
    print("═" * 60)
    print(f"  Total detections:    {len(df):,}")
    print(f"  Date range:          {df['acq_date'].min()}  →  {df['acq_date'].max()}")
    print(f"  Mean FRP:            {df['frp'].mean():.1f} MW")
    print(f"  Max  FRP:            {df['frp'].max():.1f} MW")
    print(f"  Median FRP:          {df['frp'].median():.1f} MW")
    print()
    print("  By Sensor:")
    for src, cnt in df.groupby("_source").size().items():
        print(f"    {src:<20} {cnt:,} detections")
    print()
    print("  By Intensity Class:")
    for cls, cnt in df.groupby("frp_class").size().items():
        pct = 100 * cnt / len(df)
        print(f"    {cls:<20} {cnt:,}  ({pct:.1f}%)")
    print()
    print("  By Confidence:")
    for c, cnt in df.groupby("confidence_label").size().items():
        pct = 100 * cnt / len(df)
        print(f"    {c:<20} {cnt:,}  ({pct:.1f}%)")
    print("═" * 60 + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="🔥 FIRMS Wildfire Analysis Pipeline — VIIRS + MODIS",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument("--key",  required=True,
                        help="NASA FIRMS MAP_KEY (get free key at "
                             "https://firms.modaps.eosdis.nasa.gov/api/map_key/)")
    parser.add_argument("--bbox", default=DEFAULT_BBOX,
                        help="Region of Interest as 'west,south,east,north'")
    parser.add_argument("--days", type=int, default=7,
                        help="Number of days to look back (1–10)")
    parser.add_argument("--out",  default="output",
                        help="Output directory for GeoJSON and CSV files")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    log(f"Output directory: {os.path.abspath(args.out)}")
    log(f"Region of Interest (bbox): {args.bbox}")
    log(f"Days: {args.days}")

    # ── Step 1: Fetch active fire data ───────────────────────────────────────
    log("─── STEP 1: Fetching active fire detections from NASA FIRMS ───")
    fetcher = FIRMSFetcher(map_key=args.key, bbox=args.bbox, days=args.days)
    df = fetcher.fetch_all()

    if df.empty:
        log("Pipeline halted: no data fetched. Check MAP_KEY and region.", "ERROR")
        sys.exit(1)

    # ── Step 2: Print summary statistics ────────────────────────────────────
    log("─── STEP 2: Analysis Summary ───")
    print_summary(df)

    # ── Step 3: Export CSV ───────────────────────────────────────────────────
    log("─── STEP 3: Exporting CSV ───")
    csv_path = os.path.join(args.out, "active_fires_7day.csv")
    DataExporter.to_csv(df, csv_path)

    # ── Step 4: Export GeoJSON ───────────────────────────────────────────────
    log("─── STEP 4: Exporting GeoJSON ───")
    geojson_path = os.path.join(args.out, "active_fires_7day.geojson")
    DataExporter.to_geojson(df, geojson_path,
                             description="Active fire detections — VIIRS+MODIS, last 7 days")

    # ── Step 5: dNBR burn scar demo (synthetic data if no imagery) ───────────
    log("─── STEP 5: dNBR Burn Scar Analysis (demo with synthetic data) ───")
    log("  ℹ️  For production dNBR, run companion GEE script: fire_analysis_gee.js")
    rng = np.random.default_rng(42)
    shape = (100, 100)

    # Simulate pre-fire NIR/SWIR2 bands (high vegetation, low disturbance)
    nir_pre   = rng.uniform(0.4, 0.8, shape)
    swir_pre  = rng.uniform(0.05, 0.15, shape)

    # Simulate post-fire NIR/SWIR2 (burned pixels have lower NIR, higher SWIR2)
    nir_post  = nir_pre  - rng.uniform(0, 0.4, shape)   # NIR drops after fire
    swir_post = swir_pre + rng.uniform(0, 0.5, shape)   # SWIR2 rises after fire

    analyser = BurnScarAnalyser()
    nbr_pre  = analyser.compute_nbr(nir_pre,  swir_pre)
    nbr_post = analyser.compute_nbr(nir_post, swir_post)
    dnbr     = analyser.compute_dnbr(nbr_pre, nbr_post)
    rdnbr    = analyser.compute_rdnbr(dnbr, nbr_pre)
    severity = analyser.classify_dnbr(dnbr)

    area_stats = analyser.area_statistics(severity, pixel_area_m2=100)

    print("\n  📊 Burn Scar Area Statistics (synthetic demo):")
    total_burned = 0
    for cls, ha in area_stats.items():
        if "severity" in cls or "high" in cls:
            total_burned += ha
        print(f"    {cls:<35} {ha:>10,.2f} ha")
    print(f"\n    {'TOTAL BURNED (severity ≥ low)':<35} {total_burned:>10,.2f} ha\n")

    # ── Step 6: NDVI Decline Analysis ────────────────────────────────────────
    log("─── STEP 6: NDVI Decline / Pre-Fire Risk (demo) ───")
    ndvi_analyser = NDVIAnalyser()
    red_current   = rng.uniform(0.05, 0.20, shape)
    nir_current   = rng.uniform(0.30, 0.65, shape)
    red_baseline  = rng.uniform(0.05, 0.15, shape)
    nir_baseline  = rng.uniform(0.45, 0.75, shape)

    ndvi_current  = ndvi_analyser.compute_ndvi(nir_current, red_current)
    ndvi_baseline = ndvi_analyser.compute_ndvi(nir_baseline, red_baseline)
    dndvi         = ndvi_analyser.compute_ndvi_decline(ndvi_current, ndvi_baseline)
    stress_map    = ndvi_analyser.classify_stress(dndvi)

    print(f"  dNDVI stats: mean={dndvi.mean():.3f}, min={dndvi.min():.3f}, max={dndvi.max():.3f}")
    print(f"  Pixels at HIGH or SEVERE stress: "
          f"{np.sum((stress_map == 'high_stress') | (stress_map == 'severe_stress')):,} "
          f"/ {stress_map.size:,}")

    # ── Step 7: Validation demo ──────────────────────────────────────────────
    log("─── STEP 7: Accuracy Assessment (example values) ───")
    log("  Replace TP/FP/FN/TN with real ground truth comparison.")
    aa = AccuracyAssessment(tp=1842, fp=198, fn=231, tn=9412)
    aa.print_report()

    log("Pipeline complete. Outputs written to: " + os.path.abspath(args.out), "SUCCESS")
    log("Next step: Run fire_analysis_gee.js in Google Earth Engine Code Editor "
        "for satellite-derived dNBR and NDVI rasters.", "INFO")


if __name__ == "__main__":
    main()
