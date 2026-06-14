# global_wildfire_monitoring
The Global Real-Time Wildfire Monitor is an interactive GIS dashboard that streams active fire detections from NASA FIRMS. It integrates the Google Earth Engine REST API to calculate and overlay high-resolution Sentinel-2 raster layers (dNBR, RdNBR, severity) and export customized spatial data (GeoJSON/CSV) for selected regions of interest.
# 🔥 Global Real-Time Wildfire Monitor

The Global Real-Time Wildfire Monitor is an interactive GIS dashboard that streams active fire detections from NASA FIRMS. It integrates the Google Earth Engine REST API to calculate and overlay high-resolution Sentinel-2 raster layers (dNBR, RdNBR, severity) and export customized spatial data (GeoJSON/CSV) for selected regions of interest.

---

## 🛰️ Key Features

- **Live Fire Streaming**: Connects to the NASA FIRMS API to plot near-real-time thermal anomaly detections (VIIRS S-NPP, NOAA-20, MODIS).
- **Google Earth Engine Integration**: Leverages the GEE v1alpha REST API for client-side raster calculations:
  - **dNBR** (differenced Normalized Burn Ratio)
  - **RdNBR** (Relativised differenced Normalized Burn Ratio)
  - **Severity Classifications** (USGS 4-Class categories with transparent unburned masking)
  - **dNDVI** (differenced Normalized Difference Vegetation Index)
  - **MODIS FRP** (Fire Radiative Power accumulation)
- **Flexible Bounding Boxes**: Draw custom regions of interest (ROI) using mapping tools or select from presets (e.g. Nallamala Hills, AP).
- **Clipboard Utility**: Instantly copy Earth Engine scripts pre-injected with your active map/preset ROI coordinates for seamless copy-pasting into the [GEE Code Editor](https://code.earthengine.google.com/).
- **Data Downloader**: Download active fire records and estimated severity polygons locally in **GeoJSON** or **CSV** formats customized by ROI, date ranges, and satellite filters.

---

## 🚀 Getting Started

### 1. Run the Dashboard Locally
This project is built using a zero-friction, client-side architecture (pure HTML/CSS/JavaScript). No complex server setups are needed. Simply serve the folder locally:

```bash
# Using Python
python3 -m http.server 8001
```
Now, open your browser and navigate to `http://localhost:8001`.

### 2. Enter Your API Credentials
- **NASA FIRMS**: Obtain a free `MAP_KEY` from [NASA FIRMS API Key Request](https://firms.modaps.eosdis.nasa.gov/api/map_key/) and enter it in the dashboard.
- **Google Earth Engine**: Enter your GEE Personal Access Token (PAT) and Google Cloud Project ID in the **🛰️ GEE Analysis** sidebar to load high-resolution satellite tiles directly on the Leaflet map.

---

## 🛠️ Tech Stack
- **Map Renderer**: [Leaflet.js](https://leafletjs.com/) (Open-Source Interactive Map library)
- **Map Draw Tools**: [Geoman.io Leaflet Plugin](https://geoman.io/)
- **Clustering Engine**: Leaflet.markercluster
- **API Interfaces**: NASA FIRMS API & Google Earth Engine REST API
- **Styling**: Modern dark-mode glassmorphic CSS
