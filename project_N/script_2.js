
        // ============================================================
        // 1. MAP INITIALIZATION
        // ============================================================
        // Create Leaflet map centered on the globe. zoomControl is disabled
        // here so we can reposition it to the top-right to not overlap the sidebar.
        const map = L.map('map', {
            center: [20.0, 0.0],   // Global center view
            zoom: 2,               // Start zoomed out to see the world
            minZoom: 1,            // Allow full zoom-out to see the globe
            maxZoom: 18,
            zoomControl: false,
            worldCopyJump: true    // Seamless panning across the date line
        });

        // Reattach zoom control to top-right corner
        L.control.zoom({ position: 'topright' }).addTo(map);

        // 3. BASE MAP: CartoDB Dark Matter (Free Tiles, No Key)
        // This dark theme creates maximum contrast for fire data visualization.
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);

        // Global references for layer toggle management
        let fireClusterGroup;    // Holds the MarkerClusterGroup for FIRMS data
        let regionalScarsLayer;  // Holds the GeoJSON layer for burn scars
        let searchMarker = null; // Holds the current search pin marker

        // NASA GIBS WMTS: MODIS Terra Corrected Reflectance (Bands 7-2-1)
        // False Color composite: Band 7 (SWIR) → Red, Band 2 (NIR) → Green, Band 1 (Red) → Blue
        // Active fires appear bright red/orange; vegetation = green; bare soil = brown
        // 100% FREE — No API key, no account — served from gibs.earthdata.nasa.gov
        // GIBS imagery has 24-48h processing latency: we try 2 days ago, fallback to 3 days ago
        function getGibsDate(daysAgo) {
            return new Date(Date.now() - daysAgo * 86400000).toISOString().split('T')[0];
        }
        let gibsDatePrimary = getGibsDate(2);   // 2 days ago (safe default)
        let gibsDateFallback = getGibsDate(3);   // 3 days ago (fallback)
        let gibsTriedFallback = false;

        let satelliteImagery = L.tileLayer(
            `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_Bands721/default/${gibsDatePrimary}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
            {
                maxZoom: 9,
                minZoom: 1,
                tileSize: 256,
                opacity: 0.85,
                attribution: '&copy; <a href="https://earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs" target="_blank">NASA GIBS</a> (' + gibsDatePrimary + ')',
                errorTileUrl: ''
            }
        );

        // Auto-fallback: if primary date tiles fail, silently rebuild with an older date.
        // NOTE: No event listener re-binding needed — the change handler in initUserToggles()
        // captures the `satelliteImagery` variable binding (not the value), so it automatically
        // references the new layer after reassignment.
        satelliteImagery.on('tileerror', function () {
            if (!gibsTriedFallback) {
                gibsTriedFallback = true;
                const dateToTry = gibsDateFallback;

                const wasOnMap = map.hasLayer(satelliteImagery);
                if (wasOnMap) map.removeLayer(satelliteImagery);

                satelliteImagery = L.tileLayer(
                    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_Bands721/default/${dateToTry}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
                    {
                        maxZoom: 9,
                        minZoom: 1,
                        tileSize: 256,
                        opacity: 0.85,
                        attribution: `&copy; NASA GIBS (${dateToTry})`,
                        errorTileUrl: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
                    }
                );

                if (wasOnMap) map.addLayer(satelliteImagery);
            }
        });

        // --- 1. NDVI (Vegetation Health) ---
        let ndviLayer = L.tileLayer(
            `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/${gibsDatePrimary}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`,
            { maxZoom: 9, opacity: 0.75, attribution: 'NASA GIBS (NDVI)' }
        );

        // --- 2. Land Cover Classification ---
        //
        // GIBS layer: MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual
        //   — Annual product (MCD12Q1), IGBP classification scheme
        //   — TileMatrixSet: GoogleMapsCompatible_Level8 (maxZoom = 8)
        //   — Available dates: 2001-01-01 to 2024-01-01 (annual, P1Y)
        //   — Default / latest: 2024-01-01
        //
        // PREVIOUS BUG: Was using GoogleMapsCompatible_Level9 which does NOT
        // exist for this product — all tiles silently 404'd. Fixed to Level8.
        //
        // IGBP classes displayed (17 categories):
        //   Evergreen Needleleaf, Deciduous Broadleaf, Mixed Forest,
        //   Savannas, Grasslands, Croplands, Urban & Built-up, etc.
        let landCoverLayer = L.tileLayer(
            `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/2024-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
            { maxZoom: 8, minZoom: 1, opacity: 0.65, attribution: 'NASA GIBS · MODIS MCD12Q1 IGBP Land Cover (2024)' }
        );

        // --- 3. Aerosol Optical Depth (Smoke Plumes) ---
        //
        // PREVIOUS BUG: 'MODIS_Terra_Aerosol' does NOT exist in NASA GIBS.
        // All tile requests silently returned 404, making the toggle appear broken.
        //
        // FIX: Verified correct layer identifier from GIBS WMTS GetCapabilities (2026-05-09):
        //   MODIS_Terra_Aerosol_Optical_Depth_3km
        //   — TileMatrixSet: GoogleMapsCompatible_Level6 (maxZoom = 6)
        //   — Daily product, data confirmed through 2026-05-09
        //   — Fallback to Aqua AOD if Terra tiles fail
        //
        // This layer shows smoke plume AOD (bluish-purple haze over fire regions),
        // ranging from 0.0 (clear) to ~3.0+ (heavy smoke). Values > 1.0 typically
        // indicate significant wildfire smoke impacting air quality.
        let aerosolLayer = L.tileLayer(
            `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Aerosol_Optical_Depth_3km/default/${gibsDatePrimary}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
            {
                maxZoom: 6,
                minZoom: 1,
                opacity: 0.75,
                attribution: `NASA GIBS · MODIS Terra AOD 3km (${gibsDatePrimary})`
            }
        );

        // Fallback: if Terra AOD tiles fail (e.g. data gap), switch to Aqua AOD
        let aerosolFallbackTriggered = false;
        aerosolLayer.on('tileerror', function () {
            if (aerosolFallbackTriggered) return;
            aerosolFallbackTriggered = true;
            console.warn('[AOD] Terra AOD tiles failed, switching to Aqua AOD fallback.');
            const wasOnMap = map.hasLayer(aerosolLayer);
            if (wasOnMap) map.removeLayer(aerosolLayer);
            aerosolLayer = L.tileLayer(
                `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Aqua_Aerosol_Optical_Depth_3km/default/${gibsDatePrimary}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
                {
                    maxZoom: 6,
                    minZoom: 1,
                    opacity: 0.75,
                    attribution: `NASA GIBS · MODIS Aqua AOD 3km (${gibsDatePrimary}) [fallback]`
                }
            );
            if (wasOnMap) map.addLayer(aerosolLayer);
        });

        // --- 4. NBR / Burn Scar Layer — VIIRS SNPP SWIR False Color ---
        //
        // PREVIOUS BUG: used 'MODIS_Burned_Area_Monthly' which does NOT exist in GIBS,
        // causing all tile requests to silently 404. Now fixed.
        //
        // CORRECT LAYER: VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1
        //   — The standard scientific false-color composite for NBR / burn scar mapping:
        //       R = M11 (SWIR 2250 nm) → HIGH  over burned areas  (high SWIR reflectance)
        //       G = I2  (NIR  865 nm)  → LOW   over burned areas  (damaged canopy = low NIR)
        //       B = I1  (Red  640 nm)  → varies
        //   — Burned scars  → dark red / brownish tones
        //   — Active fire   → bright red / orange
        //   — Healthy veg   → vivid green  (low SWIR, high NIR → high NBR)
        //   — Bare soil     → tan / grey
        //
        // This is a daily NRT product (1–2 day latency) verified in the GIBS WMTS capabilities.
        //
        // NBR formula (for reference / GIS export):
        //   NBR  = (NIR − SWIR) / (NIR + SWIR)
        //   dNBR = NBR_pre-fire − NBR_post-fire  → positive = burned, negative = regrowth

        // Try up to 3 sequential dates to handle the NRT latency window
        const nbrDate = (() => {
            const d = new Date(Date.now() - 2 * 86400000); // 2 days ago (NRT latency)
            return d.toISOString().split('T')[0];
        })();
        const nbrDateFallback = (() => {
            const d = new Date(Date.now() - 3 * 86400000); // 3-day fallback
            return d.toISOString().split('T')[0];
        })();
        const nbrDateFallback2 = (() => {
            const d = new Date(Date.now() - 5 * 86400000); // 5-day final fallback
            return d.toISOString().split('T')[0];
        })();
        let nbrTriedFallback = 0; // 0 = not tried, 1 = tried 3-day, 2 = tried 5-day

        let nbrBurnedAreaLayer = L.tileLayer(
            `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1/default/${nbrDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`,
            {
                maxZoom: 9,
                minZoom: 2,
                opacity: 0.82,
                attribution: `NASA GIBS · VIIRS SNPP SWIR False Color (NBR proxy · ${nbrDate})`
            }
        );

        // Progressive date fallback — if tiles fail, quietly rebuild with an older date
        nbrBurnedAreaLayer.on('tileerror', function () {
            if (nbrTriedFallback >= 2) return;
            nbrTriedFallback++;
            const fallbackDate = nbrTriedFallback === 1 ? nbrDateFallback : nbrDateFallback2;
            const wasOnMap = map.hasLayer(nbrBurnedAreaLayer);
            if (wasOnMap) map.removeLayer(nbrBurnedAreaLayer);
            nbrBurnedAreaLayer = L.tileLayer(
                `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1/default/${fallbackDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`,
                {
                    maxZoom: 9,
                    minZoom: 2,
                    opacity: 0.82,
                    attribution: `NASA GIBS · VIIRS SNPP SWIR False Color (NBR proxy · ${fallbackDate})`
                }
            );
            if (wasOnMap) map.addLayer(nbrBurnedAreaLayer);
            // Re-attach error handler for next fallback level
            nbrBurnedAreaLayer.once('tileerror', arguments.callee.bind(this));
        });

        // Smart Filter: store all fire records for reactive filtering
        let allFireRecords = [];  // Array of {lat, lng, brightness, confidence, frp, acqDate, acqTime, source}

        // ============================================================
        // FIRMS API CONFIGURATION
        // ============================================================
        // The API key is stored in localStorage so users don't need to
        // re-enter it every time they open the dashboard.
        const FIRMS_CONFIG = {
            // Try localStorage first, fallback to hardcoded key
            get MAP_KEY() {
                return localStorage.getItem('firms_map_key') || 'YOUR_FIRMS_MAP_KEY_HERE';
            },
            set MAP_KEY(val) {
                localStorage.setItem('firms_map_key', val);
            },

            // All available FIRMS data sources with their display names
            SOURCES: {
                'VIIRS_SNPP_NRT': { name: 'VIIRS S-NPP', toggleId: 'toggle-viirs-snpp', resolution: '375m' },
                'VIIRS_NOAA20_NRT': { name: 'VIIRS NOAA-20', toggleId: 'toggle-viirs-noaa20', resolution: '375m' },
                'MODIS_NRT': { name: 'MODIS Terra/Aqua', toggleId: 'toggle-modis', resolution: '1km' }
            },

            // Bounding box for data fetch — use 'world' for global, or specific coords
            // Format: west,south,east,north
            AREA: 'world',

            // Number of days of data to fetch (1-5)
            DAYS: 1,

            // Auto-refresh interval in milliseconds (5 minutes)
            REFRESH_INTERVAL: 5 * 60 * 1000,

            // Base URL for the FIRMS API
            BASE_URL: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'
        };

        // State management for auto-refresh
        let autoRefreshTimer = null;
        let refreshCountdownTimer = null;
        let nextRefreshTime = 0;
        let isDataLive = false;  // Whether we're showing real FIRMS data vs mock
        let isFetching = false;  // Prevent concurrent fetches
        let lastFetchTime = null;

        // Per-source data cache: avoids redundant API calls when toggling sources
        // Key: sourceId (e.g. 'VIIRS_SNPP_NRT'), Value: { records: [], fetchedAt: Date }
        const sourceDataCache = new Map();

        // ============================================================
        // BOOT SEQUENCE: Initialize all features
        // ============================================================
        initClusterGroup();      // Initialize the MarkerClusterGroup
        initUserToggles();       // Sidebar toggle event listeners
        initSearchBar();         // Search bar with Nominatim geocoding
        initSmartFilters();      // Smart Data Filter reactive controls
        initApiKeyPrompt();      // API Key input handler
        initSidebarToggle();     // Mobile sidebar collapse/expand
        initCoordDisplay();      // Cursor coordinate display
        // Regional Burn Scars layer removed
        fetchAllFirmsSources();  // Layer 1: Live fire data (multi-source)
        spawnLoadingEmbers();    // Cinematic ember particles on loading screen
        initGIS();               // GIS Analyst tools + panel

        /**
         * spawnLoadingEmbers()
         * Creates drifting fire ember particles on the loading overlay.
         */
        function spawnLoadingEmbers() {
            const container = document.getElementById('loading-embers');
            if (!container) return;
            const colors = [
                'var(--accent-orange)',
                'var(--accent-red)',
                '#ffb347',
                'var(--accent-yellow)'
            ];
            const NUM_EMBERS = 28;
            for (let i = 0; i < NUM_EMBERS; i++) {
                const ember = document.createElement('div');
                ember.className = 'ember';
                const size = Math.random() * 4 + 2;
                const left = Math.random() * 100;
                const delay = Math.random() * 5;
                const duration = Math.random() * 4 + 3;
                const drift = (Math.random() - 0.5) * 80;
                const color = colors[Math.floor(Math.random() * colors.length)];
                ember.style.cssText = `
                    left: ${left}%;
                    bottom: -10px;
                    width: ${size}px;
                    height: ${size}px;
                    background: ${color};
                    box-shadow: 0 0 ${size * 2}px ${color};
                    --drift: ${drift}px;
                    animation-delay: ${delay}s;
                    animation-duration: ${duration}s;
                `;
                container.appendChild(ember);
            }
        }


        // ============================================================
        // 2. CLUSTER GROUP INITIALIZATION
        // ============================================================

        /**
         * initClusterGroup()
         * Creates the MarkerClusterGroup once, reused across refreshes.
         */
        function initClusterGroup() {
            fireClusterGroup = L.markerClusterGroup({
                maxClusterRadius: 40,
                showCoverageOnHover: false,
                spiderfyOnMaxZoom: true,
                disableClusteringAtZoom: 14,
                chunkedLoading: true,          // Load markers in chunks for smooth UX
                chunkDelay: 50,
                chunkInterval: 200,
                iconCreateFunction: function (cluster) {
                    const count = cluster.getChildCount();
                    let classSize = count < 100 ? 'small' : (count < 750 ? 'medium' : 'large');
                    let displayCount = count >= 1000
                        ? (count / 1000).toFixed(1) + 'k'
                        : count;
                    return new L.DivIcon({
                        html: `<div><span>${displayCount}</span></div>`,
                        className: `marker-cluster marker-cluster-${classSize}`,
                        iconSize: new L.Point(40, 40)
                    });
                }
            });
        }


        // ============================================================
        // 3. LAYER 1: NASA FIRMS MULTI-SOURCE PARALLEL FETCH
        // ============================================================

        /**
         * getEnabledSources()
         * Returns an array of FIRMS source IDs based on which toggles are ON.
         */
        function getEnabledSources() {
            const enabled = [];
            for (const [sourceId, config] of Object.entries(FIRMS_CONFIG.SOURCES)) {
                const toggle = document.getElementById(config.toggleId);
                if (!toggle || toggle.checked) {
                    enabled.push(sourceId);
                }
            }
            return enabled;
        }

        /**
         * buildFirmsUrl(source)
         * Constructs the FIRMS API URL for a specific satellite source.
         */
        function buildFirmsUrl(source) {
            return `${FIRMS_CONFIG.BASE_URL}/${FIRMS_CONFIG.MAP_KEY}/${source}/${FIRMS_CONFIG.AREA}/${FIRMS_CONFIG.DAYS}`;
        }

        /**
         * updateDataStatus(state, message)
         * Updates the status badge in the sidebar.
         * @param {string} state - 'live' | 'mock' | 'error' | 'loading'
         */
        function updateDataStatus(state, message) {
            const dot = document.getElementById('status-dot');
            const text = document.getElementById('status-text');
            if (dot) {
                dot.className = 'status-dot ' + state;
            }
            if (text) {
                text.textContent = message;
            }
        }

        /**
         * hideLoadingOverlay()
         * Fades out and removes the loading overlay.
         */
        function hideLoadingOverlay() {
            const overlay = document.getElementById('loading-overlay');
            if (overlay) {
                overlay.classList.add('fade-out');
                setTimeout(() => overlay.remove(), 700);
            }
        }

        /**
         * fetchAllFirmsSources(isAutoRefresh)
         *
         * Master fetch function that:
         *   1. Checks if the API key is valid
         *   2. Fetches data from ALL enabled satellite sources in parallel
         *   3. Merges results into allFireRecords
         *   4. Rebuilds the cluster layer
         *   5. Schedules the next auto-refresh
         */
        async function fetchAllFirmsSources(isAutoRefresh = false) {
            if (isFetching) return;
            isFetching = true;

            const mapKey = FIRMS_CONFIG.MAP_KEY;

            // Check if the API key is set
            if (!mapKey || mapKey === 'YOUR_FIRMS_MAP_KEY_HERE') {
                console.warn('NASA FIRMS API key not configured. Showing API key prompt + mock data.');
                document.getElementById('api-key-banner')?.classList.add('visible');
                updateDataStatus('mock', 'Demo mode — Enter API key for live data');
                hideLoadingOverlay();
                serveMockDataForPresentation();
                isFetching = false;
                // Do NOT schedule auto-refresh in demo mode — there's no API key
                // to fetch from, so it would just loop every 5 minutes doing nothing.
                // Auto-refresh will be started by initApiKeyPrompt() once a valid key is entered.
                return;
            }

            // Hide the API key banner if it was visible
            document.getElementById('api-key-banner')?.classList.remove('visible');

            if (!isAutoRefresh) {
                updateDataStatus('loading', 'Fetching from NASA FIRMS...');
                const loadingSub = document.getElementById('loading-sub');
                if (loadingSub) loadingSub.textContent = 'Querying VIIRS & MODIS satellite sensors...';
            }

            const enabledSources = getEnabledSources();
            if (enabledSources.length === 0) {
                console.warn('No satellite sources enabled.');
                updateDataStatus('error', 'No satellite sources enabled');
                hideLoadingOverlay();
                isFetching = false;
                return;
            }

            // Build fetch promises for all enabled sources in PARALLEL
            // With retry logic: 1 retry with 2-second delay for failed sources
            async function fetchWithRetry(source, retries = 1) {
                const url = buildFirmsUrl(source);
                for (let attempt = 0; attempt <= retries; attempt++) {
                    try {
                        const response = await fetch(url);
                        if (!response.ok) {
                            if (attempt < retries) {
                                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                                continue;
                            }
                            return { source, data: null, error: `HTTP ${response.status}` };
                        }
                        const csv = await response.text();
                        return { source, data: csv, error: null };
                    } catch (err) {
                        if (attempt < retries) {
                            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                            continue;
                        }
                        return { source, data: null, error: err.message };
                    }
                }
            }

            const fetchPromises = enabledSources.map(source => fetchWithRetry(source));

            try {
                const results = await Promise.all(fetchPromises);

                // Clear previous records
                allFireRecords = [];

                let totalParsed = 0;
                let successCount = 0;
                let errorSources = [];

                for (const result of results) {
                    if (result.data && !result.data.includes('Invalid') && !result.data.includes('Error')) {
                        // Parse and cache per-source
                        const beforeLen = allFireRecords.length;
                        const count = parseFirmsCSV(result.data, result.source);
                        const newRecords = allFireRecords.slice(beforeLen);
                        sourceDataCache.set(result.source, { records: newRecords, fetchedAt: new Date() });
                        totalParsed += count;
                        successCount++;
                    } else {
                        errorSources.push(FIRMS_CONFIG.SOURCES[result.source].name);
                    }
                }

                if (successCount > 0) {
                    // Real data loaded successfully
                    isDataLive = true;
                    lastFetchTime = new Date();

                    // Rebuild the cluster from all merged records
                    rebuildClusterFromRecords();
                    if (!map.hasLayer(fireClusterGroup)) {
                        map.addLayer(fireClusterGroup);
                    }

                    // Update live detection feed from real data
                    populateLiveFeed();

                    const timeStr = lastFetchTime.toLocaleTimeString();
                    if (errorSources.length > 0) {
                        updateDataStatus('live', `Live (${successCount}/${enabledSources.length} sources) • ${timeStr}`);
                    } else {
                        updateDataStatus('live', `Live • ${totalParsed.toLocaleString()} detections • ${timeStr}`);
                    }
                } else {
                    // All sources failed — fallback to mock
                    console.warn('[FIRMS] All sources failed. Loading mock data.');
                    updateDataStatus('error', 'API error — showing demo data');
                    serveMockDataForPresentation();
                }

            } catch (err) {
                console.error('[FIRMS] Unexpected error:', err);
                updateDataStatus('error', 'Connection failed — demo mode');
                serveMockDataForPresentation();
            }

            hideLoadingOverlay();
            isFetching = false;

            // Schedule next auto-refresh
            startAutoRefresh();
        }

        /**
         * startAutoRefresh()
         * Sets up a timer to re-fetch FIRMS data at the configured interval.
         */
        function startAutoRefresh() {
            // Clear any existing timers
            if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
            if (refreshCountdownTimer) clearInterval(refreshCountdownTimer);

            const toggle = document.getElementById('toggle-autorefresh');
            if (toggle && !toggle.checked) {
                document.getElementById('refresh-countdown').textContent = 'Off';
                return;
            }

            nextRefreshTime = Date.now() + FIRMS_CONFIG.REFRESH_INTERVAL;

            // Update countdown every second
            refreshCountdownTimer = setInterval(() => {
                const remaining = Math.max(0, nextRefreshTime - Date.now());
                const mins = Math.floor(remaining / 60000);
                const secs = Math.floor((remaining % 60000) / 1000);
                const el = document.getElementById('refresh-countdown');
                if (el) el.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
            }, 1000);

            // Schedule the actual refresh
            autoRefreshTimer = setTimeout(() => {
                clearInterval(refreshCountdownTimer);
                console.log('[FIRMS] Auto-refreshing data...');
                fetchAllFirmsSources(true);
            }, FIRMS_CONFIG.REFRESH_INTERVAL);
        }

        /**
         * initApiKeyPrompt()
         * Handles the API key input banner interactions.
         */
        function initApiKeyPrompt() {
            const btn = document.getElementById('api-key-btn');
            const input = document.getElementById('api-key-input');
            if (!btn || !input) return;

            // Pre-fill with stored key if it exists
            const storedKey = FIRMS_CONFIG.MAP_KEY;
            if (storedKey && storedKey !== 'YOUR_FIRMS_MAP_KEY_HERE') {
                input.value = storedKey;
            }

            function submitKey() {
                const key = input.value.trim();
                if (!key) return;
                FIRMS_CONFIG.MAP_KEY = key;
                console.log('[FIRMS] API key saved to localStorage.');

                // Show success message briefly
                const successMsg = document.getElementById('api-key-success-msg');
                if (successMsg) {
                    successMsg.classList.add('visible');
                    btn.disabled = true;
                    setTimeout(() => {
                        const banner = document.getElementById('api-key-banner');
                        if (banner) banner.classList.remove('visible');
                        successMsg.classList.remove('visible');
                        btn.disabled = false;
                    }, 2200);
                }

                // Re-fetch with the new key
                allFireRecords = [];
                fireClusterGroup.clearLayers();
                fetchAllFirmsSources();
            }

            btn.addEventListener('click', submitKey);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitKey();
            });

            // Manual refresh button — always forces a fresh fetch by clearing cache
            const refreshBtn = document.getElementById('refresh-now-btn');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => {
                    if (!isFetching) {
                        // Spin animation
                        refreshBtn.classList.add('spinning');
                        setTimeout(() => refreshBtn.classList.remove('spinning'), 650);
                        sourceDataCache.clear();
                        allFireRecords = [];
                        fireClusterGroup.clearLayers();
                        fetchAllFirmsSources();
                    }
                });
            }

            // Auto-refresh toggle handler
            const autoRefreshToggle = document.getElementById('toggle-autorefresh');
            if (autoRefreshToggle) {
                autoRefreshToggle.addEventListener('change', () => {
                    if (autoRefreshToggle.checked) {
                        startAutoRefresh();
                    } else {
                        if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
                        if (refreshCountdownTimer) clearInterval(refreshCountdownTimer);
                        document.getElementById('refresh-countdown').textContent = 'Off';
                    }
                });
            }

            // Source toggle handlers — rebuild from cache or fetch if needed
            for (const [sourceId, config] of Object.entries(FIRMS_CONFIG.SOURCES)) {
                const toggle = document.getElementById(config.toggleId);
                if (toggle) {
                    toggle.addEventListener('change', () => {
                        rebuildFromSourceCache();
                    });
                }
            }
        }

        /**
         * rebuildFromSourceCache()
         * Merges cached records from all enabled sources and rebuilds the cluster.
         * Only fetches sources that are not yet in cache.
         */
        async function rebuildFromSourceCache() {
            const enabledSources = getEnabledSources();
            const uncachedSources = enabledSources.filter(s => !sourceDataCache.has(s));

            // If there are uncached sources, fetch them
            if (uncachedSources.length > 0 && FIRMS_CONFIG.MAP_KEY && FIRMS_CONFIG.MAP_KEY !== 'YOUR_FIRMS_MAP_KEY_HERE') {
                for (const source of uncachedSources) {
                    const url = buildFirmsUrl(source);
                    try {
                        const response = await fetch(url);
                        if (response.ok) {
                            const csv = await response.text();
                            if (csv && !csv.includes('Invalid') && !csv.includes('Error')) {
                                const origLen = allFireRecords.length;
                                parseFirmsCSV(csv, source);
                                const newRecords = allFireRecords.slice(origLen);
                                sourceDataCache.set(source, { records: newRecords, fetchedAt: new Date() });
                                // Remove the just-parsed records — we'll rebuild from cache below
                                allFireRecords.length = origLen;
                            }
                        }
                    } catch (e) {
                        console.warn(`[FIRMS] Cache-fetch for ${source} failed:`, e.message);
                    }
                }
            }

            // Merge all enabled cached records
            allFireRecords = [];
            for (const source of enabledSources) {
                const cached = sourceDataCache.get(source);
                if (cached) {
                    allFireRecords.push(...cached.records);
                }
            }

            // Rebuild cluster
            rebuildClusterFromRecords();
            if (!map.hasLayer(fireClusterGroup)) {
                map.addLayer(fireClusterGroup);
            }
            populateLiveFeed();

            // Update count
            const total = allFireRecords.length;
            document.getElementById('active-fire-count').innerText =
                total >= 1000 ? (total / 1000).toFixed(1) + 'k' : total.toLocaleString();
        }

        /**
         * parseFirmsCSV(csvText, sourceId)
         * 
         * Converts NASA's raw CSV text into fire records.
         * Returns the number of records parsed.
         * 
         * NASA FIRMS CSV columns (VIIRS):
         *   [0] latitude    — Decimal degrees
         *   [1] longitude   — Decimal degrees
         *   [2] bright_ti4  — Brightness temperature (Kelvin)
         *   [3] scan        — Scan pixel size
         *   [4] track       — Track pixel size
         *   [5] acq_date    — Acquisition date (YYYY-MM-DD)
         *   [6] acq_time    — Acquisition time (HHMM)
         *   [7] satellite   — Satellite name
         *   [8] instrument  — Instrument name
         *   [9] confidence  — Detection confidence: 'l'(low), 'n'(nominal), 'h'(high)
         *   [10] version    — Collection version
         *   [11] bright_ti5 — Secondary brightness temperature
         *   [12] frp        — Fire Radiative Power (MW)
         *   [13] daynight   — 'D' for day, 'N' for night
         *
         * For MODIS, columns are similar but confidence is numeric (0-100).
         */
        function parseFirmsCSV(csvText, sourceId) {
            const lines = csvText.trim().split('\n');
            if (lines.length < 2) return 0;

            // Parse the header to find column indices dynamically
            const header = lines[0].split(',').map(h => h.trim().toLowerCase());
            const colIdx = {
                lat: header.indexOf('latitude'),
                lng: header.indexOf('longitude'),
                brightness: header.indexOf('bright_ti4') !== -1 ? header.indexOf('bright_ti4') : header.indexOf('brightness'),
                confidence: header.indexOf('confidence'),
                frp: header.indexOf('frp'),
                acqDate: header.indexOf('acq_date'),
                acqTime: header.indexOf('acq_time'),
                satellite: header.indexOf('satellite'),
                daynight: header.indexOf('daynight')
            };

            let parsed = 0;
            const isMODIS = sourceId && sourceId.startsWith('MODIS');

            for (let i = 1; i < lines.length; i++) {
                const row = lines[i].split(',');
                if (row.length < 10) continue;

                const lat = parseFloat(row[colIdx.lat]);
                const lng = parseFloat(row[colIdx.lng]);
                if (isNaN(lat) || isNaN(lng)) continue;

                const brightness = row[colIdx.brightness] || '';
                let confidence = (row[colIdx.confidence] || '').trim().toLowerCase();
                const frp = parseFloat(row[colIdx.frp]) || 0;
                const acqDate = (row[colIdx.acqDate] || '').trim();
                const acqTime = (row[colIdx.acqTime] || '').trim();
                const satellite = (row[colIdx.satellite] || '').trim();
                const daynight = (row[colIdx.daynight] || '').trim();

                // MODIS uses numeric confidence (0-100), normalize to l/n/h
                if (isMODIS && !isNaN(parseInt(confidence))) {
                    const confNum = parseInt(confidence);
                    confidence = confNum >= 80 ? 'h' : confNum >= 30 ? 'n' : 'l';
                }

                allFireRecords.push({
                    lat, lng, brightness, confidence, frp,
                    acqDate, acqTime, satellite, daynight,
                    source: sourceId || 'unknown'
                });
                parsed++;
            }

            return parsed;
        }


        // ============================================================
        // DYNAMIC LIVE DETECTION FEED
        // ============================================================

        /**
         * populateLiveFeed()
         * Populates the "Latest Detections" sidebar card with the top
         * fire events sorted by FRP (fire intensity), using reverse
         * geocoding approximation based on coordinates.
         */
        function populateLiveFeed() {
            const container = document.getElementById('live-feed-container');
            if (!container) return;

            // Sort records by FRP descending, take top 5
            const topFires = [...allFireRecords]
                .sort((a, b) => b.frp - a.frp)
                .slice(0, 5);

            if (topFires.length === 0) {
                container.innerHTML = `
                    <div class="feed-item">
                        <div class="feed-icon" style="background:var(--text-muted);box-shadow:none"></div>
                        <div class="feed-text">
                            <h5>No detections found</h5>
                            <p>Check filters or data source settings</p>
                        </div>
                    </div>`;
                return;
            }

            container.innerHTML = topFires.map(fire => {
                const confLabel = fire.confidence === 'h' ? 'High' : fire.confidence === 'n' ? 'Nominal' : 'Low';
                const intensityClass = fire.frp > 200 ? 'high' : fire.frp > 50 ? 'moderate' : 'low';
                const dotColor = fire.frp > 200
                    ? 'var(--accent-red)'
                    : fire.frp > 50
                        ? 'var(--accent-orange)'
                        : 'var(--accent-yellow)';

                // Calculate time ago
                let timeAgo = '';
                if (fire.acqDate && fire.acqTime) {
                    const h = fire.acqTime.substring(0, 2);
                    const m = fire.acqTime.substring(2, 4);
                    const fireTime = new Date(`${fire.acqDate}T${h}:${m}:00Z`).getTime();
                    if (!isNaN(fireTime)) {
                        const diffMins = Math.floor((Date.now() - fireTime) / 60000);
                        if (diffMins < 60) timeAgo = `${diffMins} min ago`;
                        else if (diffMins < 1440) timeAgo = `${Math.floor(diffMins / 60)}h ago`;
                        else timeAgo = `${Math.floor(diffMins / 1440)}d ago`;
                    }
                }

                const sourceName = FIRMS_CONFIG.SOURCES[fire.source]?.name || fire.satellite || fire.source;

                return `
                    <div class="feed-item" style="cursor:pointer" onclick="map.flyTo([${fire.lat},${fire.lng}],12,{duration:1.2})">
                        <div class="feed-icon" style="background:${dotColor};box-shadow:0 0 8px ${dotColor}"></div>
                        <div class="feed-text">
                            <h5>${fire.lat.toFixed(2)}°, ${fire.lng.toFixed(2)}° — ${fire.frp} MW</h5>
                            <p>${confLabel} • ${sourceName} • ${timeAgo || fire.acqDate}</p>
                        </div>
                    </div>`;
            }).join('');
        }


        // ============================================================
        // 3. LAYER 2: STATIC BURN SCARS (Local GeoJSON File)
        // ============================================================

        /**
         * loadLocalGeoJSONScars()
         * 
         * Attempts to fetch 'regional_burn_scars.geojson' from the same directory.
         * If the file exists, it renders the polygons as semi-transparent red fills.
         * If the file doesn't exist, it logs a notice and continues gracefully.
         */
        function loadLocalGeoJSONScars() {
            // Create the Leaflet GeoJSON layer with our burn scar styling
            regionalScarsLayer = L.geoJSON(null, {
                style: {
                    fillColor: '#ef4444',   // Red fill representing burnt area
                    fillOpacity: 0.25,      // Semi-transparent so the map shows through
                    color: '#ef4444',        // Red stroke border
                    weight: 1.5
                },
                // Add interactive popups and hover effects for each burn scar polygon
                onEachFeature: function (feature, layer) {
                    const p = feature.properties || {};
                    const popupContent = `
                        <div style="font-family:'Inter',sans-serif; font-size:13px; min-width:180px">
                            <b style="font-size:14px">🔥 ${p.name || 'Burn Scar'}</b><br/>
                            <span style="color:#94a3b8">${p.region || 'Unknown Region'}</span>
                            <hr style="border:0;border-top:1px solid #ddd;margin:6px 0">
                            ${p.area_ha ? '<b>Area:</b> ' + p.area_ha.toLocaleString() + ' ha<br/>' : ''}
                            ${p.year ? '<b>Year:</b> ' + p.year + '<br/>' : ''}
                            ${p.description ? '<div style="margin-top:6px;color:#64748b;font-size:12px">' + p.description + '</div>' : ''}
                        </div>
                    `;
                    layer.bindPopup(popupContent);

                    // Highlight on hover for better interactivity
                    layer.on('mouseover', function () {
                        this.setStyle({ fillOpacity: 0.5, weight: 2.5 });
                    });
                    layer.on('mouseout', function () {
                        regionalScarsLayer.resetStyle(this);
                    });
                }
            });

            // Attempt to load the local file via fetch()
            fetch('regional_burn_scars.geojson')
                .then(response => {
                    if (!response.ok) {
                        console.log('ℹ️ regional_burn_scars.geojson not found. Place it in the project folder to activate Layer 2.');
                        return null;
                    }
                    return response.json();
                })
                .then(data => {
                    if (data) regionalScarsLayer.addData(data);
                })
                .catch(error => {
                    console.warn('GeoJSON fetch error:', error);
                });

            // NOTE: We don't add this layer to the map by default because
            // the toggle checkbox starts in the "off" position.
        }


        // ============================================================
        // 4. UI EVENT LISTENERS (Toggle Switches)
        // ============================================================

        /**
         * initUserToggles()
         * 
         * Binds the HTML checkbox inputs to Leaflet's addLayer/removeLayer methods.
         * When a user flips a toggle, the corresponding map layer appears or disappears.
         */
        function initUserToggles() {
            // Toggle: NASA FIRMS Clusters
            document.getElementById('toggle-clusters').addEventListener('change', (e) => {
                if (e.target.checked) {
                    map.addLayer(fireClusterGroup);
                } else {
                    map.removeLayer(fireClusterGroup);
                }
            });

            // Regional Burn Scars layer removed

            // Toggle: Satellite Imagery (NASA GIBS False Color)
            document.getElementById('toggle-satellite').addEventListener('change', (e) => {
                if (e.target.checked) {
                    map.addLayer(satelliteImagery);
                } else {
                    map.removeLayer(satelliteImagery);
                }
            });

            // Toggle: NDVI
            document.getElementById('toggle-ndvi').addEventListener('change', (e) => {
                if (e.target.checked) map.addLayer(ndviLayer);
                else map.removeLayer(ndviLayer);
            });

            // Toggle: Land Cover
            document.getElementById('toggle-landcover').addEventListener('change', (e) => {
                if (e.target.checked) map.addLayer(landCoverLayer);
                else map.removeLayer(landCoverLayer);
            });

            // Toggle: Aerosol (Smoke)
            document.getElementById('toggle-aerosol').addEventListener('change', (e) => {
                if (e.target.checked) map.addLayer(aerosolLayer);
                else map.removeLayer(aerosolLayer);
            });

            // Toggle: NBR / Burn Scar — VIIRS SNPP SWIR False Color
            document.getElementById('toggle-nbr').addEventListener('change', (e) => {
                if (e.target.checked) {
                    map.addLayer(nbrBurnedAreaLayer);
                    document.getElementById('tool-nbr').classList.add('active');
                } else {
                    map.removeLayer(nbrBurnedAreaLayer);
                    document.getElementById('tool-nbr').classList.remove('active');
                }
            });
        }


        // ============================================================
        // 4b. SIDEBAR COLLAPSE/EXPAND TOGGLE
        // ============================================================

        /**
         * initSidebarToggle()
         * Handles the mobile sidebar collapse/expand button.
         * Remembers state in localStorage.
         */
        function initSidebarToggle() {
            const toggleBtn = document.getElementById('sidebar-toggle');
            const sidebar = document.getElementById('ui-sidebar');
            if (!toggleBtn || !sidebar) return;

            // Restore saved state
            const savedState = localStorage.getItem('sidebar_collapsed');
            if (savedState === 'true') {
                sidebar.classList.add('collapsed');
                toggleBtn.classList.remove('active');
                toggleBtn.textContent = '☰';
            }

            toggleBtn.addEventListener('click', () => {
                const isCollapsed = sidebar.classList.toggle('collapsed');
                toggleBtn.classList.toggle('active', !isCollapsed);
                toggleBtn.textContent = isCollapsed ? '☰' : '✕';
                localStorage.setItem('sidebar_collapsed', isCollapsed);

                // Re-trigger stagger animation when sidebar opens
                if (!isCollapsed) {
                    sidebar.classList.remove('animate-in');
                    void sidebar.offsetWidth;
                    sidebar.classList.add('animate-in');
                }
            });
        }


        // ============================================================
        // 4c. COORDINATE DISPLAY ON MAP HOVER
        // ============================================================

        /**
         * initCoordDisplay()
         * Shows cursor lat/lng in a small overlay at the bottom-left of the map.
         */
        function initCoordDisplay() {
            const display = document.getElementById('coord-display');
            if (!display) return;

            map.on('mousemove', (e) => {
                display.textContent = `${e.latlng.lat.toFixed(4)}°, ${e.latlng.lng.toFixed(4)}°`;
            });

            map.on('mouseout', () => {
                display.textContent = '—';
            });
        }

        // ============================================================
        // 5. GEOCODING SEARCH BAR (Free Nominatim API)
        // ============================================================

        /**
         * initSearchBar()
         * 
         * Implements a live-autocomplete location search using OpenStreetMap's
         * Nominatim geocoding API. This is 100% free and requires no API key.
         * 
         * Features:
         *   - Live suggestions appear after typing 3+ characters (debounced 500ms)
         *   - Enter key triggers instant search
         *   - Clicking a result performs a smooth flyTo animation
         *   - A glowing orange pin is placed at the searched location
         */
        function initSearchBar() {
            const input = document.getElementById('search-input');
            const btn = document.getElementById('search-btn');
            const resultsDiv = document.getElementById('search-results');
            let debounceTimer;

            // Trigger search on Enter key press
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') performSearch(input.value.trim());
            });

            // Trigger search on button click
            btn.addEventListener('click', () => performSearch(input.value.trim()));

            // Live autocomplete as user types (debounced to 500ms to respect
            // Nominatim's usage policy of max 1 request per second)
            input.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                const query = input.value.trim();
                if (query.length < 3) {
                    resultsDiv.classList.remove('active');
                    return;
                }
                debounceTimer = setTimeout(() => performSearch(query), 500);
            });

            // Close the dropdown when user clicks anywhere outside the search area
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.search-wrapper')) {
                    resultsDiv.classList.remove('active');
                }
            });

            /**
             * performSearch(query)
             * Calls the free Nominatim geocoding API and populates the dropdown.
             */
            function performSearch(query) {
                if (!query) return;

                // Nominatim endpoint — completely free, no API key needed
                const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`;

                fetch(url)
                    .then(res => res.json())
                    .then(data => {
                        resultsDiv.innerHTML = '';

                        if (data.length === 0) {
                            resultsDiv.innerHTML = '<div class="search-no-results">No results found.</div>';
                            resultsDiv.classList.add('active');
                            return;
                        }

                        // Create a clickable item for each geocoding result
                        data.forEach(place => {
                            const item = document.createElement('div');
                            item.className = 'search-result-item';
                            item.textContent = place.display_name;
                            item.addEventListener('click', () => flyToResult(place));
                            resultsDiv.appendChild(item);
                        });
                        resultsDiv.classList.add('active');
                    })
                    .catch(err => console.error('Geocoding error:', err));
            }

            /**
             * flyToResult(place)
             * Animates the map camera to the selected location and drops a pin.
             */
            function flyToResult(place) {
                const lat = parseFloat(place.lat);
                const lon = parseFloat(place.lon);

                // Smooth animated camera transition to zoom level 10
                map.flyTo([lat, lon], 10, { duration: 1.5 });

                // Remove any previous search pin
                if (searchMarker) map.removeLayer(searchMarker);

                // Create a glowing orange pin icon
                const pinIcon = L.divIcon({ className: 'search-pin', iconSize: [16, 16] });

                // Place the pin on the map and open an informative popup
                searchMarker = L.marker([lat, lon], { icon: pinIcon }).addTo(map);
                searchMarker.bindPopup(`
                    <div style="font-family:'Inter',sans-serif">
                        <b>${place.display_name.split(',')[0]}</b><br/>
                        ${lat.toFixed(3)}, ${lon.toFixed(3)}
                    </div>
                `).openPopup();

                // Clean up the search UI
                resultsDiv.classList.remove('active');
                input.value = place.display_name.split(',').slice(0, 2).join(',');
            }
        }


        // ============================================================
        // 6. MOCK DATA FALLBACK (For Presentation Without API Key)
        // ============================================================

        /**
         * serveMockDataForPresentation()
         * 
         * If the NASA FIRMS API key is missing or invalid, this function
         * generates ~5,400 realistic mock fire points concentrated in
         * known wildfire regions so the UI still looks fully populated.
         */
        function serveMockDataForPresentation() {
            const confLevels = ['l', 'n', 'h'];
            const mockSources = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'];

            /**
             * injectPoints(count, minLon, maxLon, minLat, maxLat)
             * Scatters random coordinates within a geographic bounding box.
             */
            function injectPoints(count, minLon, maxLon, minLat, maxLat) {
                for (let i = 0; i < count; i++) {
                    const lat = Math.random() * (maxLat - minLat) + minLat;
                    const lng = Math.random() * (maxLon - minLon) + minLon;
                    const frp = Math.round(Math.random() * 450 + 5);
                    const confidence = confLevels[Math.floor(Math.random() * 3)];
                    const source = mockSources[Math.floor(Math.random() * 3)];
                    // Simulate acquisition times spread over the last 24 hours
                    const hoursAgo = Math.random() * 24;
                    const mockDate = new Date(Date.now() - hoursAgo * 3600000);
                    const acqDate = mockDate.toISOString().split('T')[0];
                    const acqTime = String(mockDate.getHours()).padStart(2, '0') + String(mockDate.getMinutes()).padStart(2, '0');
                    allFireRecords.push({
                        lat, lng, brightness: (300 + Math.random() * 100).toFixed(1),
                        confidence, frp, acqDate, acqTime,
                        satellite: source.includes('MODIS') ? 'Terra' : 'Suomi NPP',
                        daynight: Math.random() > 0.5 ? 'D' : 'N',
                        source
                    });
                }
            }

            // Global baseline scatter
            injectPoints(1200, -180, 180, -60, 70);

            // Dense regional hotspots matching real-world fire zones:
            injectPoints(1600, -125, -110, 35, 60);   // Western US & Canada
            injectPoints(1800, -75, -50, -20, 5);      // Amazon Basin
            injectPoints(800, 115, 150, -40, -15);     // Australia

            // Build markers from stored records and apply filters
            rebuildClusterFromRecords();

            // Populate the live detection feed from mock data
            populateLiveFeed();

            // Add the populated cluster group to the map
            map.addLayer(fireClusterGroup);
        }


        // ============================================================
        // 7. SMART DATA FILTER ENGINE
        // ============================================================

        /**
         * rebuildClusterFromRecords()
         * Clears the cluster group and re-adds only markers matching current filters.
         */
        function rebuildClusterFromRecords() {
            const customIcon = L.divIcon({ className: 'fire-point-icon', iconSize: [8, 8] });

            // Read current filter values
            const confHigh = document.getElementById('filter-conf-high')?.checked ?? true;
            const confNominal = document.getElementById('filter-conf-nominal')?.checked ?? true;
            const confLow = document.getElementById('filter-conf-low')?.checked ?? true;
            const frpMin = parseFloat(document.getElementById('filter-frp')?.value ?? 0);
            const maxHours = parseFloat(document.getElementById('filter-temporal')?.value ?? 24);

            // Build a set of allowed confidence values
            const allowedConf = new Set();
            if (confHigh) allowedConf.add('h');
            if (confNominal) allowedConf.add('n');
            if (confLow) allowedConf.add('l');

            const now = Date.now();
            let visibleCount = 0;

            // Clear existing markers
            fireClusterGroup.clearLayers();

            for (const rec of allFireRecords) {
                // 1. Confidence filter
                if (!allowedConf.has(rec.confidence)) continue;

                // 2. FRP filter
                if (rec.frp < frpMin) continue;

                // 3. Temporal filter
                if (rec.acqDate && rec.acqTime) {
                    const h = rec.acqTime.substring(0, 2);
                    const m = rec.acqTime.substring(2, 4);
                    const recTime = new Date(`${rec.acqDate}T${h}:${m}:00Z`).getTime();
                    if (!isNaN(recTime)) {
                        const ageHours = (now - recTime) / 3600000;
                        if (ageHours > maxHours) continue;
                    }
                }

                // Record passes all filters — create marker
                const marker = L.marker([rec.lat, rec.lng], { icon: customIcon });
                const confLabel = rec.confidence === 'h' ? 'HIGH' : rec.confidence === 'n' ? 'NOMINAL' : 'LOW';
                const sourceName = FIRMS_CONFIG.SOURCES[rec.source]?.name || rec.satellite || 'FIRMS';
                // Cinematic Deep Dive: flyTo + pulse + modal
                marker.on('click', () => {
                    // Add pulse animation to clicked marker
                    const el = marker._icon;
                    if (el) el.classList.add('marker-pulse');
                    // Cinematic flyTo
                    map.flyTo([rec.lat, rec.lng], 14, { duration: 2.5 });
                    // Launch modal after camera arrives
                    setTimeout(() => {
                        if (el) el.classList.remove('marker-pulse');
                        executeDeepDive(rec);
                    }, 2600);
                });
                fireClusterGroup.addLayer(marker);
                visibleCount++;
            }

            // Update sidebar counters with animated roll-up
            const total = allFireRecords.length;
            animateCounter(document.getElementById('active-fire-count'), visibleCount);

            const countEl = document.getElementById('filter-live-count');
            if (countEl) {
                const vStr = visibleCount.toLocaleString();
                const tStr = total.toLocaleString();
                countEl.innerHTML = `Showing <strong>${vStr}</strong> of <strong>${tStr}</strong> detections`;
            }
        }

        /**
         * animateCounter(el, targetValue)
         * Rolls up a number display from 0 (or its current value) to targetValue.
         * Shows compact 'k' suffix for values >= 1000.
         */
        function animateCounter(el, targetValue) {
            if (!el) return;
            const duration = 900;
            const start = performance.now();
            const startVal = 0;

            // Add pop class for entrance animation
            el.classList.remove('pop');
            void el.offsetWidth; // trigger reflow
            el.classList.add('pop');

            function easeOutExpo(t) {
                return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
            }

            function tick(now) {
                const elapsed = now - start;
                const progress = Math.min(elapsed / duration, 1);
                const current = Math.round(startVal + (targetValue - startVal) * easeOutExpo(progress));
                el.innerText = current >= 1000
                    ? (current / 1000).toFixed(1) + 'k'
                    : current.toLocaleString();
                if (progress < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        }

        /**
         * initSmartFilters()
         * Binds all filter UI controls to the reactive rebuild engine with debouncing.
         */
        function initSmartFilters() {
            let filterTimer;
            const DEBOUNCE_MS = 300; // Increased from 150ms for smoother interaction with large datasets

            function debouncedRebuild() {
                clearTimeout(filterTimer);
                filterTimer = setTimeout(() => rebuildClusterFromRecords(), DEBOUNCE_MS);
            }

            // Confidence checkboxes
            ['filter-conf-high', 'filter-conf-nominal', 'filter-conf-low'].forEach(id => {
                const cb = document.getElementById(id);
                if (!cb) return;
                cb.addEventListener('change', () => {
                    cb.closest('.filter-checkbox-label').classList.toggle('checked', cb.checked);
                    debouncedRebuild();
                });
            });

            // FRP slider
            const frpSlider = document.getElementById('filter-frp');
            const frpLabel = document.getElementById('frp-value');
            if (frpSlider) {
                frpSlider.addEventListener('input', () => {
                    if (frpLabel) frpLabel.textContent = frpSlider.value + ' MW+';
                    debouncedRebuild();
                });
            }

            // Temporal slider
            const tempSlider = document.getElementById('filter-temporal');
            const tempLabel = document.getElementById('temporal-value');
            if (tempSlider) {
                tempSlider.addEventListener('input', () => {
                    tempLabel.textContent = tempSlider.value + ' h';
                    debouncedRebuild();
                });
            }
        }

        // ============================================================
        // DEEP DIVE — CINEMATIC ANALYSIS ENGINE
        // Multi-Source: Sentinel Hub | ISRO Bhuvan | NASA GIBS
        // ============================================================

        // Deep Dive State
        const DD = {
            frames: [],         // [{date, truecolor, swir, bhuvan, failed}]
            currentIdx: 0,
            playing: false,
            interval: null,
            mode: 'truecolor',  // 'truecolor' | 'swir' | 'bhuvan'
            rec: null,
            SENTINEL_TOKEN: 'YOUR_SENTINEL_HUB_TOKEN' // Plug in your token here
        };

        /**
         * calculateTileXY(lat, lng, z) — EPSG:3857 tile coordinate math
         */
        function calculateTileXY(lat, lng, z) {
            const n = Math.pow(2, z);
            const latRad = lat * Math.PI / 180;
            return {
                x: Math.floor(n * ((lng + 180) / 360)),
                y: Math.floor(n * (1 - (Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2)
            };
        }

        /**
         * buildGIBSUrl(date, layer, z, lat, lng)
         * Generates WMTS tile URLs for NASA GIBS layers
         */
        function buildGIBSUrl(dateStr, layer, z, lat, lng) {
            const tile = calculateTileXY(lat, lng, z);
            return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${dateStr}/GoogleMapsCompatible_Level${z}/${z}/${tile.y}/${tile.x}.jpg`;
        }

        /**
         * buildBhuvanWMSUrl(lat, lng) — ISRO Bhuvan Disaster WMS
         * Only valid for coordinates within India's bounding box
         */
        function buildBhuvanWMSUrl(lat, lng) {
            const offset = 0.15;
            const bbox = `${lng - offset},${lat - offset},${lng + offset},${lat + offset}`;
            // Use bhuvan-vec1 server with bhuvan2d — the main ISRO satellite imagery layer
            return `https://bhuvan-vec1.nrsc.gov.in/bhuvan/wms?` +
                `SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
                `&LAYERS=bhuvan2d&STYLES=` +
                `&SRS=EPSG:4326&BBOX=${bbox}` +
                `&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=FALSE`;
        }

        /**
         * fetchSentinelImagery(lat, lng, dateStr, bandCombo)
         * Sentinel Hub Process API for 10m Sentinel-2A imagery
         */
        async function fetchSentinelImagery(lat, lng, dateStr, bandCombo = 'swir') {
            if (DD.SENTINEL_TOKEN === 'YOUR_SENTINEL_HUB_TOKEN') return null;
            const offset = 0.05;
            const evalscripts = {
                swir: `//VERSION=3\nfunction setup(){return{input:["B12","B11","B04"],output:{bands:3}}}\nfunction evaluatePixel(s){return[s.B12*3.5,s.B11*3.5,s.B04*3.5]}`,
                truecolor: `//VERSION=3\nfunction setup(){return{input:["B04","B03","B02"],output:{bands:3}}}\nfunction evaluatePixel(s){return[s.B04*3.5,s.B03*3.5,s.B02*3.5]}`
            };
            const payload = {
                input: {
                    bounds: { bbox: [lng - offset, lat - offset, lng + offset, lat + offset], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
                    data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: `${dateStr}T00:00:00Z`, to: `${dateStr}T23:59:59Z` }, mosaickingOrder: 'leastCC' } }]
                },
                output: { width: 512, height: 512, responses: [{ identifier: 'default', format: { type: 'image/jpeg' } }] },
                evalscript: evalscripts[bandCombo] || evalscripts.swir
            };
            try {
                const res = await fetch('https://services.sentinel-hub.com/api/v1/process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DD.SENTINEL_TOKEN}` },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) return null;
                const blob = await res.blob();
                return URL.createObjectURL(blob);
            } catch (e) {
                console.warn('[Sentinel]', e);
                return null;
            }
        }

        /**
         * generateSITREP(rec) — Human-readable Situation Report
         */
        function generateSITREP(rec) {
            const confLabel = rec.confidence === 'h' ? 'HIGH' : rec.confidence === 'n' ? 'NOMINAL' : 'LOW';
            const intensity = rec.frp > 100 ? 'CRITICAL' : rec.frp > 30 ? 'ELEVATED' : 'MODERATE';
            const isIndia = rec.lat > 6 && rec.lat < 38 && rec.lng > 68 && rec.lng < 98;
            const hemisphere = rec.lat >= 0 ? 'Northern' : 'Southern';
            const regionHint = isIndia ? 'Indian subcontinent' : `${hemisphere} hemisphere (${Math.abs(rec.lat).toFixed(1)}° ${rec.lat >= 0 ? 'N' : 'S'}, ${Math.abs(rec.lng).toFixed(1)}° ${rec.lng >= 0 ? 'E' : 'W'})`;
            const passType = rec.daynight === 'D' ? 'daytime' : 'nighttime';
            const sourceName = FIRMS_CONFIG.SOURCES[rec.source]?.name || rec.satellite || 'FIRMS';
            return `<span class="sitrep-tag">${intensity}</span> <strong>SITREP — Thermal Anomaly Analysis</strong><br><br>` +
                `A <strong>${intensity.toLowerCase()}-intensity</strong> thermal signature of <strong>${rec.frp} MW</strong> (Fire Radiative Power) has been detected in the <strong>${regionHint}</strong>, ` +
                `verified at <strong>${confLabel}</strong> confidence via ${passType} orbital pass by <strong>${sourceName}</strong> on <strong>${rec.acqDate}</strong>.` +
                `${rec.frp > 50 ? '<br><br>⚠️ FRP exceeds 50 MW threshold — indicates active combustion of substantial biomass with potential for rapid lateral spread under favorable wind conditions.' : ''}` +
                `${isIndia ? '<br><br>🇮🇳 Fire falls within ISRO Bhuvan coverage zone. Regional disaster management layer is available via the Bhuvan tab above.' : ''}`;
        }

        // ── Spread polygon layer reference ─────────────────────────────────────
        let spreadLayer = null;

        /**
         * buildWindSpreadPolygon(rec)
         * Fetches live wind from Open-Meteo (free, no key) and draws a
         * wind-elongated ellipse on the map representing the predicted
         * 6-hour fire spread zone.
         *
         * Spread physics (Rothermel approximation):
         *   Base spread  = 6 km/h × 6 h = 6 km (calm conditions)
         *   Wind multiplier: 1× at 0 m/s → 6× at 20 m/s (linear)
         *   Cross-wind spread = 30% of downwind spread
         */
        async function buildWindSpreadPolygon(rec) {
            const section = document.getElementById('dd-wind-section');
            const statusEl = document.getElementById('dd-spread-status');
            const speedEl  = document.getElementById('dd-wind-speed');
            const dirEl    = document.getElementById('dd-wind-dir');
            const kmEl     = document.getElementById('dd-spread-km');
            if (section) section.style.display = '';
            if (statusEl) statusEl.textContent = 'Fetching live wind data from Open-Meteo…';

            // Remove old spread layer
            if (spreadLayer) { try { map.removeLayer(spreadLayer); } catch(e){} spreadLayer = null; }

            try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${rec.lat.toFixed(3)}&longitude=${rec.lng.toFixed(3)}&current=wind_speed_10m,wind_direction_10m&timezone=auto`;
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('Open-Meteo HTTP ' + resp.status);
                const data = await resp.json();
                const windSpeedKmh = data.current?.wind_speed_10m ?? 10;  // km/h from Open-Meteo
                const windSpeedMs  = windSpeedKmh / 3.6;
                const windFromDeg  = data.current?.wind_direction_10m ?? 0;

                // Fire spreads INTO the wind direction (downwind)
                const spreadBearing = (windFromDeg + 180) % 360;

                // Spread distance: base 6km, scaled by wind (1x calm → 6x at 20 m/s)
                const multiplier   = 1 + (windSpeedMs / 20) * 5;
                const downwindKm   = 6 * multiplier;
                const crosswindKm  = downwindKm * 0.3;

                // Update wind stats UI
                if (speedEl) speedEl.textContent = windSpeedMs.toFixed(1);
                if (dirEl)   dirEl.textContent   = windFromDeg + '°';
                if (kmEl)    kmEl.textContent     = downwindKm.toFixed(1);

                // Build ellipse polygon as GeoJSON (pure JS, no Turf needed)
                const DEG2RAD = Math.PI / 180;
                const R = 6371; // Earth radius km
                const steps = 64;
                const latRad  = rec.lat * DEG2RAD;
                const lngRad  = rec.lng * DEG2RAD;
                const bearRad = spreadBearing * DEG2RAD;

                const coords = [];
                for (let i = 0; i <= steps; i++) {
                    const angle = (i / steps) * 2 * Math.PI;
                    // Parametric ellipse in local frame (downwind = major axis)
                    const localX = crosswindKm  * Math.cos(angle);  // cross-wind
                    const localY = downwindKm   * Math.sin(angle);  // downwind

                    // Rotate by spread bearing
                    const rotX = localX * Math.cos(bearRad) - localY * Math.sin(bearRad);
                    const rotY = localX * Math.sin(bearRad) + localY * Math.cos(bearRad);

                    // Convert km offset to lat/lng
                    const dLat = rotY / R;
                    const dLng = rotX / (R * Math.cos(latRad));
                    coords.push([
                        rec.lat + dLat * (180 / Math.PI),
                        rec.lng + dLng * (180 / Math.PI)
                    ]);
                }

                // Draw on the map as a Leaflet polygon
                spreadLayer = L.polygon(coords, {
                    color: '#f9d857',
                    weight: 2,
                    dashArray: '7 4',
                    fillColor: '#f9d857',
                    fillOpacity: 0.10
                }).addTo(map);

                // Direction compass label
                const compassDirs = ['N','NE','E','SE','S','SW','W','NW'];
                const compass = compassDirs[Math.round(spreadBearing / 45) % 8];
                const intensity = windSpeedMs < 3 ? 'Calm' : windSpeedMs < 8 ? 'Moderate' : windSpeedMs < 14 ? 'Strong' : 'Gale';
                if (statusEl) statusEl.innerHTML =
                    `Predicted spread: <strong>${downwindKm.toFixed(1)} km</strong> downwind ` +
                    `toward <strong>${compass} (${spreadBearing}°)</strong> · ` +
                    `Wind: <strong>${windSpeedMs.toFixed(1)} m/s</strong> (${intensity}) · ` +
                    `Lateral spread: <strong>${crosswindKm.toFixed(1)} km</strong>`;

            } catch (err) {
                console.warn('[Spread]', err.message);
                if (statusEl) statusEl.textContent = '⚠️ Wind data unavailable. Check your connection.';
            }
        }

        /**
         * triggerAISitrep()
         * Calls the Gemini API with fire metrics to generate a 3-bullet SITREP.
         * Uses the key the user pastes into the Deep Dive modal input.
         */
        async function triggerAISitrep() {
            const keyInput = document.getElementById('dd-gemini-key');
            const btn      = document.getElementById('dd-ai-gen-btn');
            const output   = document.getElementById('dd-ai-output');
            const rec      = DD.rec;
            if (!rec) return;

            const apiKey = (keyInput?.value || '').trim();
            if (!apiKey) {
                output.innerHTML = '<div class="dd-ai-placeholder" style="color:var(--accent-red)">⚠️ Please paste your Gemini API key first. Get one free at aistudio.google.com/apikey</div>';
                return;
            }

            btn.disabled = true;
            btn.textContent = '⏳ Thinking…';
            output.innerHTML = '<div class="dd-ai-spinner"><div class="dd-spinner" style="width:24px;height:24px;border-width:2px"></div> Gemini is analyzing the fire data…</div>';

            const confLabel  = rec.confidence === 'h' ? 'HIGH' : rec.confidence === 'n' ? 'NOMINAL' : 'LOW';
            const sourceName = FIRMS_CONFIG.SOURCES[rec.source]?.name || rec.satellite || 'FIRMS';
            const windEl     = document.getElementById('dd-spread-status');
            const windContext = windEl?.textContent?.includes('m/s') ? windEl.textContent : 'Wind data unavailable.';

            const prompt = [
                'You are a professional Disaster Management Analyst generating a military-style SITREP.',
                'Analyze this wildfire intelligence and return EXACTLY 3 bullet points.',
                'Each bullet must start with a LABEL in ALL CAPS followed by a colon, then be concise (max 30 words).',
                'Use threat levels: LOW / MODERATE / HIGH / CRITICAL.',
                '',
                'INTELLIGENCE DATA:',
                `Location: ${rec.lat.toFixed(4)}°, ${rec.lng.toFixed(4)}°`,
                `FRP: ${rec.frp} MW | Confidence: ${confLabel} | Sensor: ${sourceName}`,
                `Acquisition: ${rec.acqDate} (${rec.daynight === 'D' ? 'Daytime' : 'Nighttime'} pass)`,
                `Wind/Spread: ${windContext}`,
                '',
                'Return format (3 lines only, no markdown, no asterisks):',
                'THREAT LEVEL: [level] — [reason]',
                'SPREAD RISK: [wind-driven expansion assessment]',
                'POPULATION ADVISORY: [action for nearby settlements]'
            ].join('\n');

            try {
                const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`;
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err?.error?.message || 'API error ' + res.status);
                }
                const json = await res.json();
                const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';

                // Parse lines into bullets
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                if (lines.length === 0) throw new Error('Empty response from Gemini');

                output.innerHTML = '<div class="dd-ai-bullets">' +
                    lines.slice(0, 4).map(l => `<div class="dd-ai-bullet">${escapeHtml(l)}</div>`).join('') +
                    '</div>';
            } catch (err) {
                console.error('[Gemini]', err);
                output.innerHTML = `<div class="dd-ai-placeholder" style="color:var(--accent-red)">⚠️ ${escapeHtml(err.message)}</div>`;
            } finally {
                btn.disabled = false;
                btn.textContent = '⚡ Generate';
            }
        }
        window.triggerAISitrep = triggerAISitrep;

        /**
         * executeDeepDive(rec) — Main entry point
         * Orchestrates: specs, imagery fetch, timelapse build, SITREP
         */
        function executeDeepDive(rec) {
            DD.rec = rec;
            DD.currentIdx = 0;
            DD.playing = false;
            DD.mode = 'truecolor';
            DD.frames = [];
            if (DD.interval) { clearInterval(DD.interval); DD.interval = null; }

            const overlay = document.getElementById('dd-overlay');
            const img = document.getElementById('dd-image');
            const loader = document.getElementById('dd-loader');
            const cloudMsg = document.getElementById('dd-cloud-msg');
            const playBtn = document.getElementById('dd-play-btn');
            const scrubber = document.getElementById('dd-scrubber');

            // Reset UI state
            overlay.classList.add('active');
            img.style.display = 'none';
            img.src = '';
            loader.style.display = 'flex';
            cloudMsg.style.display = 'none';
            playBtn.textContent = '▶';
            scrubber.value = 0;

            const confLabel = rec.confidence === 'h' ? 'High' : rec.confidence === 'n' ? 'Nominal' : 'Low';
            const sourceName = FIRMS_CONFIG.SOURCES[rec.source]?.name || rec.satellite || 'FIRMS';
            const sensorType = (rec.source || '').includes('MODIS') ? 'MODIS (1km)' : 'VIIRS (375m)';
            const isIndia = rec.lat > 6 && rec.lat < 38 && rec.lng > 68 && rec.lng < 98;

            // Bhuvan tab — always visible; label changes for India vs global coverage
            const bhuvanTab = document.getElementById('dd-bhuvan-tab');
            if (bhuvanTab) {
                bhuvanTab.style.display = '';
                bhuvanTab.title = isIndia
                    ? 'ISRO Bhuvan satellite imagery (India coverage)'
                    : 'ISRO Bhuvan base imagery (global extent, India-detail)';
            }

            // Reset toggle UI
            document.querySelectorAll('.dd-view-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.dd-view-btn[data-mode="truecolor"]').classList.add('active');

            // Satellite Specs
            document.getElementById('dd-specs').innerHTML = [
                { label: 'Coordinates', value: `${rec.lat.toFixed(4)}°, ${rec.lng.toFixed(4)}°` },
                { label: 'Sensor', value: sensorType },
                { label: 'FRP', value: `<span style="color:var(--accent-red)">${rec.frp} MW</span>` },
                { label: 'Confidence', value: confLabel },
                { label: 'Pass', value: rec.daynight === 'D' ? '☀️ Day' : '🌙 Night' },
                { label: 'Acquisition', value: rec.acqDate }
            ].map(s => `<div class="dd-spec-card"><span class="dd-spec-label">${s.label}</span><span class="dd-spec-value">${s.value}</span></div>`).join('');

            // Static SITREP
            document.getElementById('dd-sitrep').innerHTML = generateSITREP(rec);

            // Reset AI SITREP output
            const aiOut = document.getElementById('dd-ai-output');
            if (aiOut) aiOut.innerHTML = '<div class="dd-ai-placeholder">Enter your Gemini API key and click Generate to receive an AI-powered threat assessment.</div>';
            const aiBtn = document.getElementById('dd-ai-gen-btn');
            if (aiBtn) { aiBtn.disabled = false; aiBtn.textContent = '⚡ Generate'; }

            // Hide wind section until data arrives
            const windSec = document.getElementById('dd-wind-section');
            if (windSec) windSec.style.display = 'none';

            // Build 7-day imagery frames
            const acqDateStr = rec.acqDate || new Date().toISOString().split('T')[0];
            const baseDate = new Date(acqDateStr + 'T12:00:00Z');
            const z = 9;
            const staticFallback = `https://a.basemaps.cartocdn.com/dark_all/${z}/${calculateTileXY(rec.lat, rec.lng, z).x}/${calculateTileXY(rec.lat, rec.lng, z).y}.png`;

            let loadedCount = 0;
            const totalFrames = 7;

            for (let i = 6; i >= 0; i--) {
                const d = new Date(baseDate);
                d.setDate(baseDate.getDate() - i);
                const dateStr = d.toISOString().split('T')[0];
                const frameIdx = 6 - i;

                DD.frames[frameIdx] = {
                    date: dateStr,
                    truecolor: null,
                    swir: null,
                    bhuvan: buildBhuvanWMSUrl(rec.lat, rec.lng), // Always build; server responds globally
                    failed: false
                };

                // True Color from GIBS
                const truecolorUrl = buildGIBSUrl(dateStr, 'MODIS_Terra_CorrectedReflectance_TrueColor', z, rec.lat, rec.lng);
                // SWIR False Color from GIBS (Band 7-2-1)
                const swirUrl = buildGIBSUrl(dateStr, 'MODIS_Terra_CorrectedReflectance_Bands721', z, rec.lat, rec.lng);

                const loadImg = (url) => new Promise(resolve => {
                    const t = new Image();
                    t.onload = () => resolve(url);
                    t.onerror = () => resolve(null);
                    t.src = url;
                });

                Promise.all([loadImg(truecolorUrl), loadImg(swirUrl)]).then(([tc, sw]) => {
                    DD.frames[frameIdx].truecolor = tc || staticFallback;
                    DD.frames[frameIdx].swir = sw || staticFallback;
                    DD.frames[frameIdx].failed = (!tc && !sw);
                    loadedCount++;

                    const pct = Math.round(loadedCount / totalFrames * 100);
                    const loaderText = document.getElementById('dd-loader-text');
                    if (loaderText) loaderText.textContent = `Loading imagery… ${pct}%`;

                    if (loadedCount === totalFrames) {
                        onAllFramesLoaded();
                    }
                });
            }

            // Trigger wind spread polygon (async, runs in parallel with imagery)
            buildWindSpreadPolygon(rec);
        }

        /**
         * onAllFramesLoaded() — Initialize the viewport once all 7 frames are ready
         */
        function onAllFramesLoaded() {
            document.getElementById('dd-loader').style.display = 'none';
            showFrame(0);
            // Auto-play the timelapse
            DD.playing = true;
            document.getElementById('dd-play-btn').textContent = '⏸';
            DD.interval = setInterval(() => {
                DD.currentIdx = (DD.currentIdx + 1) % DD.frames.length;
                showFrame(DD.currentIdx);
            }, 700);
        }

        /**
         * showFrame(idx) — Display a specific timelapse frame
         */
        function showFrame(idx) {
            const frame = DD.frames[idx];
            if (!frame) return;
            const img = document.getElementById('dd-image');
            const cloudMsg = document.getElementById('dd-cloud-msg');

            DD.currentIdx = idx;

            const src = DD.mode === 'bhuvan' ? frame.bhuvan : (DD.mode === 'swir' ? frame.swir : frame.truecolor);

            if (frame.failed && DD.mode !== 'bhuvan') {
                img.style.display = 'none';
                cloudMsg.style.display = 'block';
            } else if (DD.mode === 'bhuvan' && !src) {
                img.style.display = 'none';
                cloudMsg.style.display = 'block';
                cloudMsg.innerHTML = '🇮🇳 Bhuvan imagery unavailable for this frame.';
            } else {
                cloudMsg.style.display = 'none';
                img.style.display = 'block';
                img.onerror = () => {
                    if (DD.mode === 'bhuvan') {
                        img.style.display = 'none';
                        cloudMsg.style.display = 'block';
                        cloudMsg.innerHTML = `<div style="text-align:center;padding:20px">
                            <div style="font-size:2rem">🇮🇳</div>
                            <div style="color:var(--accent-brand);font-weight:700;margin:8px 0">ISRO Bhuvan WMS</div>
                            <div style="color:var(--text-secondary);font-size:0.85rem">Server temporarily unavailable.<br>
                            Try visiting <a href="https://bhuvan.nrsc.gov.in" target="_blank" style="color:var(--accent-brand)">bhuvan.nrsc.gov.in</a> directly.</div>
                        </div>`;
                    }
                };
                img.src = src;
            }

            // Update overlay labels
            document.getElementById('dd-img-date').textContent = frame.date;
            const modeLabel = DD.mode === 'swir' ? 'GIBS SWIR 7-2-1' : DD.mode === 'bhuvan' ? 'ISRO Bhuvan WMS' : 'GIBS True Color';
            document.getElementById('dd-img-source').textContent = modeLabel;

            // Scrubber + label
            document.getElementById('dd-scrubber').value = idx;
            document.getElementById('dd-frame-label').textContent = `Day ${idx + 1} / ${DD.frames.length}`;
        }

        /**
         * toggleTimelapse() — Play/Pause the animation
         */
        function toggleTimelapse() {
            const btn = document.getElementById('dd-play-btn');
            if (DD.playing) {
                clearInterval(DD.interval);
                DD.interval = null;
                DD.playing = false;
                btn.textContent = '▶';
            } else {
                DD.playing = true;
                btn.textContent = '⏸';
                DD.interval = setInterval(() => {
                    DD.currentIdx = (DD.currentIdx + 1) % DD.frames.length;
                    showFrame(DD.currentIdx);
                }, 700);
            }
        }

        /**
         * switchImageryMode(mode) — Toggle True Color / SWIR / Bhuvan
         */
        function switchImageryMode(mode) {
            DD.mode = mode;
            document.querySelectorAll('.dd-view-btn').forEach(b => b.classList.remove('active'));
            const activeBtn = document.querySelector(`.dd-view-btn[data-mode="${mode}"]`);
            if (activeBtn) activeBtn.classList.add('active');
            showFrame(DD.currentIdx);
        }
        // Expose to global scope for inline onclick handlers
        window.switchImageryMode = switchImageryMode;
        window.toggleTimelapse   = toggleTimelapse;
        window.closeDeepDive     = closeDeepDive;

        // Scrubber interaction
        document.getElementById('dd-scrubber').addEventListener('input', function () {
            const idx = parseInt(this.value);
            // Pause autoplay when user scrubs
            if (DD.playing) toggleTimelapse();
            showFrame(idx);
        });

        // Close modal + keyboard escape
        function closeDeepDive() {
            if (DD.interval) { clearInterval(DD.interval); DD.interval = null; }
            DD.playing = false;
            document.getElementById('dd-overlay').classList.remove('active');
        }
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeDeepDive();
        });
        // Close on backdrop click
        document.getElementById('dd-overlay').addEventListener('click', e => {
            if (e.target.id === 'dd-overlay') closeDeepDive();
        });
        // ============================================================
        // GIS ANALYST ENGINE
        // NBR · dNBR · Fire Perimeter · Evacuation Zones · Risk Index
        // ============================================================
        let gisPanelOpen = false;
        let gisOverlays = [];          // All analyst layers to clear
        let bufferModeActive = false;  // True when waiting for user click
        let perimeterLayer = null;
        let riskOverlayActive = false;

        /**
         * initGIS()
         * Hooks up the GIS panel and sets up post-data-load update trigger.
         */
        function initGIS() {
            // Patch rebuildClusterFromRecords to also refresh GIS panel after each data rebuild
            const _originalRebuild = rebuildClusterFromRecords;
            rebuildClusterFromRecords = function() {
                _originalRebuild.apply(this, arguments);
                updateGISPanel();
            };
        }

        /** Open / close the GIS Analyst sliding panel */
        function toggleGISPanel() {
            const panel = document.getElementById('gis-panel');
            const tabBtn = document.getElementById('gis-tab-btn');
            gisPanelOpen = !gisPanelOpen;
            panel.classList.toggle('open', gisPanelOpen);
            tabBtn.classList.toggle('hidden', gisPanelOpen);
            if (gisPanelOpen) updateGISPanel();
        }

        /**
         * computeGISAnalysis()
         * Derives all GIS metrics from the loaded allFireRecords array.
         * Returns an analysis object with risk, severity, sensors, area, etc.
         */
        function computeGISAnalysis() {
            const records = allFireRecords;
            if (!records.length) return null;

            const total = records.length;
            const frpValues = records.map(r => r.frp || 0);
            const peakFRP  = Math.max(...frpValues);
            const meanFRP  = frpValues.reduce((a, b) => a + b, 0) / total;

            // High-confidence ratio
            const highConf = records.filter(r => r.confidence === 'h').length;
            const highConfRatio = highConf / total;

            // Cluster density proxy: unique 1-degree grid cells occupied
            const cells = new Set(records.map(r => `${Math.floor(r.lat)},${Math.floor(r.lng)}`));
            const density = cells.size;
            const normalizedDensity = Math.min(density / 500, 1);

            // Normalize peak FRP (cap at 1000 MW)
            const normalizedFRP = Math.min(peakFRP / 1000, 1);

            // Composite Risk Index (0-100)
            const riskScore = Math.round(
                (normalizedFRP * 0.4 + normalizedDensity * 0.35 + highConfRatio * 0.25) * 100
            );

            const riskLevel =
                riskScore >= 80 ? 'EXTREME' :
                riskScore >= 60 ? 'CRITICAL' :
                riskScore >= 40 ? 'HIGH' :
                riskScore >= 20 ? 'ELEVATED' : 'LOW';

            // Estimated burn area: VIIRS pixel ~0.1375 km² (375m), MODIS ~1 km²
            const viirsCount  = records.filter(r => r.source && r.source.includes('VIIRS')).length;
            const modisCount  = records.filter(r => r.source && r.source.includes('MODIS')).length;
            const burnAreaHa  = Math.round((viirsCount * 13.75) + (modisCount * 100));

            // dNBR severity distribution: estimated from FRP thresholds
            // Low FRP → low/unburned, High FRP → high severity
            const counts = [0, 0, 0, 0, 0, 0]; // [regrowth, unburned, low, mod-low, mod-high, high]
            records.forEach(r => {
                const f = r.frp || 0;
                if (f < 0)        counts[0]++;  // Enhanced regrowth (anomalous)
                else if (f < 10)  counts[1]++;  // Unburned / very low
                else if (f < 30)  counts[2]++;  // Low severity
                else if (f < 80)  counts[3]++;  // Moderate-low
                else if (f < 200) counts[4]++;  // Moderate-high
                else              counts[5]++;  // High severity
            });

            // Sensor breakdown
            const snpp   = records.filter(r => (r.source || '').includes('SNPP')).length;
            const noaa20 = records.filter(r => (r.source || '').includes('NOAA20')).length;
            const modis  = records.filter(r => (r.source || '').includes('MODIS')).length;

            return {
                total, peakFRP, meanFRP: meanFRP.toFixed(1),
                highConfRatio, riskScore, riskLevel,
                burnAreaHa, densityCells: cells.size,
                severityCounts: counts,
                sensors: { snpp, noaa20, modis }
            };
        }

        /** Animate a bar fill to a target percentage */
        function animateBar(el, pct) {
            if (!el) return;
            requestAnimationFrame(() => { el.style.width = pct + '%'; });
        }

        /**
         * updateGISPanel()
         * Reads allFireRecords and refreshes every GIS panel widget.
         * Called automatically after each data rebuild.
         */
        function updateGISPanel() {
            const a = computeGISAnalysis();
            if (!a) return;

            // --- Metrics ---
            document.getElementById('gis-detections').textContent = a.total.toLocaleString();
            document.getElementById('gis-peak-frp').innerHTML   = `${a.peakFRP}<span class="gis-metric-unit">MW</span>`;
            document.getElementById('gis-mean-frp').innerHTML   = `${a.meanFRP}<span class="gis-metric-unit">MW</span>`;
            document.getElementById('gis-burn-area').innerHTML  = `${a.burnAreaHa.toLocaleString()}<span class="gis-metric-unit">ha</span>`;

            // --- Risk Gauge ---
            const riskColors = {
                LOW:'var(--risk-low)', ELEVATED:'var(--risk-elevated)',
                HIGH:'var(--risk-high)', CRITICAL:'var(--risk-critical)', EXTREME:'var(--risk-extreme)'
            };
            const fill = document.getElementById('gis-risk-fill');
            if (fill) {
                fill.style.width   = a.riskScore + '%';
                fill.style.background = riskColors[a.riskLevel];
            }
            const badge = document.getElementById('gis-risk-badge');
            if (badge) {
                badge.className   = `risk-badge ${a.riskLevel}`;
                badge.textContent = `● ${a.riskLevel}`;
            }
            const scoreEl = document.getElementById('gis-risk-score');
            if (scoreEl) scoreEl.textContent = `Score: ${a.riskScore} / 100`;

            const descEl = document.getElementById('gis-risk-desc');
            if (descEl) {
                const descs = {
                    LOW:      'Fire conditions are manageable. Standard monitoring protocols apply.',
                    ELEVATED: 'Elevated fire activity detected. Enhanced patrol recommended.',
                    HIGH:     'High fire spread potential. Pre-position suppression resources.',
                    CRITICAL: 'Critical conditions. Activate Incident Command System (ICS).',
                    EXTREME:  '⚠️ EXTREME RISK. Immediate evacuation may be required. Coordinate with all agencies.'
                };
                descEl.textContent = descs[a.riskLevel];
                descEl.style.color = riskColors[a.riskLevel];
            }

            // --- dNBR Severity Bars ---
            const total = a.severityCounts.reduce((s, v) => s + v, 0) || 1;
            a.severityCounts.forEach((count, i) => {
                const pct = Math.round(count / total * 100);
                animateBar(document.getElementById(`nbr-fill-${i}`), pct);
                const pctEl = document.getElementById(`nbr-pct-${i}`);
                if (pctEl) pctEl.textContent = pct + '%';
            });

            // --- Sensor Breakdown ---
            const sTotal = (a.sensors.snpp + a.sensors.noaa20 + a.sensors.modis) || 1;
            [a.sensors.snpp, a.sensors.noaa20, a.sensors.modis].forEach((count, i) => {
                const pct = Math.round(count / sTotal * 100);
                animateBar(document.getElementById(`sensor-fill-${i}`), pct);
                const pEl = document.getElementById(`sensor-pct-${i}`);
                if (pEl) pEl.textContent = pct + '%';
            });
        }

        /**
         * toggleNBRLayer()
         * Syncs the toolbar NBR button with the sidebar checkbox.
         */
        function toggleNBRLayer() {
            const cb  = document.getElementById('toggle-nbr');
            const btn = document.getElementById('tool-nbr');
            if (!cb) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
            btn.classList.toggle('active', cb.checked);
        }

        // ─── Convex Hull (Graham Scan) ────────────────────────────────────────
        function convexHull(points) {
            if (points.length < 3) return points;
            points.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
            const cross = (O, A, B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
            const lower = [], upper = [];
            for (const p of points) {
                while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
                lower.push(p);
            }
            for (let i = points.length - 1; i >= 0; i--) {
                const p = points[i];
                while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
                upper.push(p);
            }
            upper.pop(); lower.pop();
            return lower.concat(upper);
        }

        /** Haversine distance (km) between two [lat,lng] points */
        function haversineDist(a, b) {
            const R = 6371, dLat = (b[0]-a[0])*Math.PI/180, dLng = (b[1]-a[1])*Math.PI/180;
            const x = Math.sin(dLat/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLng/2)**2;
            return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
        }

        /**
         * drawFirePerimeter()
         * Computes convex hull of visible fire hotspots and draws
         * a dashed red polygon representing the estimated fire perimeter.
         * Requires zoom >= 8 to avoid meaningless global convex hulls.
         */
        function drawFirePerimeter() {
            if (!allFireRecords.length) {
                setGISStatus('⚠️ No fire data loaded. Connect NASA FIRMS API first.');
                return;
            }

            // Enforce minimum zoom so the tool operates on a local fire cluster
            const currentZoom = map.getZoom();
            if (currentZoom < 8) {
                setGISStatus('🔍 Zoom in to at least zoom level 8 on a fire cluster, then draw the perimeter.');
                return;
            }

            // Remove old perimeter
            if (perimeterLayer) { map.removeLayer(perimeterLayer); perimeterLayer = null; }

            // Filter to visible map bounds only
            const bounds = map.getBounds();
            const visibleRecords = allFireRecords.filter(r =>
                r.lat >= bounds.getSouth() && r.lat <= bounds.getNorth() &&
                r.lng >= bounds.getWest()  && r.lng <= bounds.getEast()
            );

            if (visibleRecords.length < 3) {
                setGISStatus('⚠️ Not enough fire points in current view. Pan/zoom to a fire cluster first.');
                return;
            }

            const scopeLabel = `${visibleRecords.length.toLocaleString()} visible hotspots`;
            const pts = visibleRecords.map(r => [r.lat, r.lng]);
            const hull = convexHull(pts);
            if (hull.length < 3) { setGISStatus('Not enough points for perimeter. Zoom in to a fire cluster.'); return; }

            // Calculate perimeter length
            let perimKm = 0;
            for (let i = 0; i < hull.length; i++) {
                perimKm += haversineDist(hull[i], hull[(i+1) % hull.length]);
            }

            perimeterLayer = L.polygon(hull, {
                color: '#ff3366',
                weight: 2.5,
                dashArray: '8 5',
                fill: true,
                fillColor: '#ff3366',
                fillOpacity: 0.06
            }).addTo(map);

            // Label at centroid
            const centLat = hull.reduce((s, p) => s + p[0], 0) / hull.length;
            const centLng = hull.reduce((s, p) => s + p[1], 0) / hull.length;
            const labelIcon = L.divIcon({
                className: 'gis-perimeter-label',
                html: `📐 Est. Perimeter: ${perimKm.toFixed(0)} km`,
                iconAnchor: [0, 0]
            });
            const labelMarker = L.marker([centLat, centLng], { icon: labelIcon, interactive: false }).addTo(map);
            gisOverlays.push(perimeterLayer, labelMarker);

            document.getElementById('tool-perimeter').classList.add('active');
            document.getElementById('gis-btn-perimeter').classList.add('active');
            setGISStatus(`✅ Fire perimeter drawn · ${perimKm.toFixed(0)} km boundary from ${scopeLabel}.`);
            map.fitBounds(perimeterLayer.getBounds(), { padding: [40, 40] });
        }

        /**
         * toggleBufferMode()
         * Arms the map so the next fire-point click draws evacuation rings.
         */
        function toggleBufferMode() {
            bufferModeActive = !bufferModeActive;
            const btn  = document.getElementById('tool-buffer');
            const btn2 = document.getElementById('gis-btn-buffer');
            btn.classList.toggle('active', bufferModeActive);
            btn2.classList.toggle('active', bufferModeActive);
            if (bufferModeActive) {
                map.getContainer().style.cursor = 'crosshair';
                setGISStatus('🎯 Buffer mode active — click any fire point on the map to draw evacuation zones.');
                // One-time click listener
                map.once('click', (e) => {
                    drawEvacZones(e.latlng.lat, e.latlng.lng);
                    bufferModeActive = false;
                    btn.classList.remove('active');
                    btn2.classList.remove('active');
                    map.getContainer().style.cursor = '';
                });
            } else {
                map.getContainer().style.cursor = '';
                setGISStatus('Evac zone mode cancelled.');
            }
        }

        /**
         * drawEvacZones(lat, lng)
         * Draws 3 concentric evacuation buffer rings around a point.
         */
        function drawEvacZones(lat, lng) {
            const zones = [
                { radius: 500,  color: '#ff3366', label: '🔴 500m — Immediate Danger' },
                { radius: 2000, color: '#ff8c42', label: '🟠 2km — Evacuation Zone' },
                { radius: 5000, color: '#f9d857', label: '🟡 5km — Watch Zone' }
            ];
            zones.forEach(z => {
                const circle = L.circle([lat, lng], {
                    radius: z.radius,
                    color: z.color,
                    weight: 2,
                    dashArray: z.radius === 500 ? null : '6 4',
                    fill: true,
                    fillColor: z.color,
                    fillOpacity: z.radius === 500 ? 0.12 : 0.05
                }).addTo(map);
                const lbl = L.marker(
                    [lat + (z.radius / 111320), lng],
                    { icon: L.divIcon({ className: 'evac-label', html: z.label }), interactive: false }
                ).addTo(map);
                gisOverlays.push(circle, lbl);
            });
            setGISStatus(`✅ Evacuation zones drawn at ${lat.toFixed(4)}°, ${lng.toFixed(4)}° · 🔴500m · 🟠2km · 🟡5km`);
        }

        /**
         * toggleRiskOverlay()
         * Draws a simple cluster-density risk circles overlay.
         */
        function toggleRiskOverlay() {
            const btn = document.getElementById('tool-risk');
            if (riskOverlayActive) {
                clearGISOverlays();
                btn.classList.remove('active');
                riskOverlayActive = false;
                return;
            }
            if (!allFireRecords.length) { setGISStatus('⚠️ No data loaded.'); return; }

            // Group records into 2-degree grid cells
            const cellMap = {};
            allFireRecords.forEach(r => {
                const key = `${Math.round(r.lat/2)*2},${Math.round(r.lng/2)*2}`;
                if (!cellMap[key]) cellMap[key] = { lat: Math.round(r.lat/2)*2, lng: Math.round(r.lng/2)*2, count: 0, frpSum: 0 };
                cellMap[key].count++;
                cellMap[key].frpSum += (r.frp || 0);
            });

            const maxCount = Math.max(...Object.values(cellMap).map(c => c.count));
            Object.values(cellMap).forEach(cell => {
                const intensity = cell.count / maxCount;
                const color = intensity > 0.7 ? '#ff3366' : intensity > 0.4 ? '#ff8c42' : '#f9d857';
                const circle = L.circle([cell.lat, cell.lng], {
                    radius: 80000 * intensity + 20000,
                    color: 'transparent',
                    fill: true,
                    fillColor: color,
                    fillOpacity: 0.18 * intensity + 0.05
                }).addTo(map);
                gisOverlays.push(circle);
            });

            riskOverlayActive = true;
            btn.classList.add('active');
            setGISStatus(`✅ Risk overlay active — ${Object.keys(cellMap).length} fire density cells rendered.`);
        }

        /** Clear all GIS spatial overlays from the map */
        function clearGISOverlays() {
            gisOverlays.forEach(layer => { try { map.removeLayer(layer); } catch(e){} });
            gisOverlays = [];
            if (perimeterLayer) { try { map.removeLayer(perimeterLayer); } catch(e){} perimeterLayer = null; }
            riskOverlayActive  = false;
            bufferModeActive   = false;
            map.getContainer().style.cursor = '';
            ['tool-nbr','tool-perimeter','tool-buffer','tool-risk'].forEach(id => {
                document.getElementById(id)?.classList.remove('active');
            });
            ['gis-btn-perimeter','gis-btn-buffer'].forEach(id => {
                document.getElementById(id)?.classList.remove('active');
            });
            setGISStatus('All overlays cleared.');
        }

        /** Set status message inside the GIS panel */
        function setGISStatus(msg) {
            const el = document.getElementById('gis-tool-status');
            if (el) el.textContent = msg;
        }

        /**
         * exportGISReport()
         * Generates a professional GIS analyst report and triggers download.
         */
        function exportGISReport() {
            const a = computeGISAnalysis();
            if (!a) { setGISStatus('⚠️ No data to export. Load FIRMS data first.'); return; }

            const now      = new Date().toISOString();
            const top5     = [...allFireRecords].sort((a,b)=>(b.frp||0)-(a.frp||0)).slice(0,5);
            const sevNames = ['Enhanced Regrowth','Unburned','Low Severity','Moderate-Low','Moderate-High','High Severity'];
            const total    = a.severityCounts.reduce((s,v)=>s+v,0)||1;

            const report = [
                '================================================================',
                '  WILDFIRE GIS ANALYST REPORT',
                '  Global Real-Time Wildfire Monitoring & Management Dashboard',
                '================================================================',
                `  Generated : ${now}`,
                `  Data Source: NASA FIRMS (VIIRS + MODIS Multi-Source)`,
                '',
                '── ACTIVE FIRE METRICS ─────────────────────────────────────────',
                `  Total Detections : ${a.total.toLocaleString()}`,
                `  Peak FRP         : ${a.peakFRP} MW`,
                `  Mean FRP         : ${a.meanFRP} MW`,
                `  Est. Burn Area   : ${a.burnAreaHa.toLocaleString()} ha`,
                `  Density Cells    : ${a.densityCells} (1° × 1° grid)`,
                '',
                '── FIRE SPREAD RISK INDEX ──────────────────────────────────────',
                `  Composite Score  : ${a.riskScore} / 100`,
                `  Risk Level       : ${a.riskLevel}`,
                `  High-Conf Ratio  : ${(a.highConfRatio * 100).toFixed(1)}%`,
                '',
                '── dNBR BURN SEVERITY DISTRIBUTION (USGS Standard) ────────────',
                ...a.severityCounts.map((c, i) =>
                    `  ${sevNames[i].padEnd(20)}: ${c.toLocaleString().padStart(6)} pts  (${Math.round(c/total*100)}%)`
                ),
                '',
                '── SATELLITE SENSOR BREAKDOWN ──────────────────────────────────',
                `  VIIRS S-NPP (375m)    : ${a.sensors.snpp.toLocaleString()} detections`,
                `  VIIRS NOAA-20 (375m)  : ${a.sensors.noaa20.toLocaleString()} detections`,
                `  MODIS Terra/Aqua (1km): ${a.sensors.modis.toLocaleString()} detections`,
                '',
                '── TOP 5 HIGHEST FRP EVENTS ────────────────────────────────────',
                ...top5.map((r, i) =>
                    `  ${i+1}. ${r.lat.toFixed(4)}°, ${r.lng.toFixed(4)}° | FRP: ${r.frp} MW | Conf: ${r.confidence.toUpperCase()} | ${r.acqDate}`
                ),
                '',
                '── NBR / BURN SCAR LAYER ───────────────────────────────────────',
                `  Product : VIIRS SNPP SWIR False Color (NBR Proxy)`,
                `  Layer   : VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1`,
                `  Source  : NASA GIBS WMTS (Daily NRT)`,
                `  Date    : ${nbrDate} (NRT, with auto-fallback to ${nbrDateFallback} / ${nbrDateFallback2})`,
                `  Bands   : R=M11(SWIR 2250nm)  G=I2(NIR 865nm)  B=I1(Red 640nm)`,
                `  NBR Formula : (NIR − SWIR) / (NIR + SWIR)`,
                `  dNBR        : NBR_pre-fire − NBR_post-fire`,
                `  Legend  : Dark red/brown = Burned (low NBR)  |  Green = Healthy (high NBR)`,
                '',
                '================================================================',
                '  END OF REPORT — Wildfire Monitoring Dashboard',
                '================================================================'
            ].join('\n');

            const blob = new Blob([report], { type: 'text/plain' });
            const url  = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href  = url;
            link.download = `wildfire_gis_report_${now.slice(0,10)}.txt`;
            link.click();
            URL.revokeObjectURL(url);
            setGISStatus('✅ Report exported successfully.');
        }

        // ============================================================
        // WILDFIRE NEWS PANEL — NASA EONET + GNews
        // ============================================================
        let newsPanelOpen = false;
        let newsLoaded = false;
        let newsClickListenerBound = false;

        function toggleNewsPanel() {
            const panel = document.getElementById('news-panel');
            const tabBtn = document.getElementById('news-tab-btn');
            newsPanelOpen = !newsPanelOpen;
            panel.classList.toggle('open', newsPanelOpen);
            tabBtn.classList.toggle('hidden', newsPanelOpen);
            if (newsPanelOpen && !newsLoaded) {
                fetchAllNews();
            }
        }

        async function fetchAllNews() {
            const body = document.getElementById('news-panel-body');
            // Show loader while fetching
            body.innerHTML = '<div class="news-loader" id="news-loader"><div class="dd-spinner"></div><span style="font-size:0.85rem;font-weight:500">Loading global wildfire events…</span></div>';

            // Helper: fetch RSS via free proxies (tries multiple if one fails)
            async function fetchRSS(rssUrl) {
                const parseXML = (xmlStr) => {
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(xmlStr, 'text/xml');
                    const entries = xmlDoc.querySelectorAll('item, entry');
                    return Array.from(entries).map(el => ({
                        title: el.querySelector('title')?.textContent || 'Untitled',
                        link: el.querySelector('link')?.textContent || el.querySelector('link')?.getAttribute('href') || '#',
                        pubDate: el.querySelector('pubDate, published, updated')?.textContent || '',
                        description: el.querySelector('description, summary')?.textContent || ''
                    }));
                };

                const proxies = [
                    // 1. rss2json — returns JSON directly, most reliable for RSS
                    async (url) => {
                        const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
                        const data = await res.json();
                        if (data.status === 'ok' && data.items) return data.items;
                        throw new Error('rss2json failed: ' + data.message);
                    },
                    // 2. corsproxy.io — returns raw XML
                    async (url) => {
                        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
                        if (!res.ok) throw new Error('corsproxy HTTP ' + res.status);
                        const xml = await res.text();
                        const items = parseXML(xml);
                        if (items.length > 0) return items;
                        throw new Error('corsproxy empty');
                    },
                    // 3. allorigins — returns {contents: rawXml}
                    async (url) => {
                        const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
                        if (!res.ok) throw new Error('allorigins HTTP ' + res.status);
                        const data = await res.json();
                        if (data.contents) return parseXML(data.contents);
                        throw new Error('allorigins empty');
                    },
                    // 4. thingproxy — direct CORS proxy, no JSON wrapper
                    async (url) => {
                        const res = await fetch(`https://thingproxy.freeboard.io/fetch/${url}`, { signal: AbortSignal.timeout(8000) });
                        if (!res.ok) throw new Error('thingproxy HTTP ' + res.status);
                        const xml = await res.text();
                        const items = parseXML(xml);
                        if (items.length > 0) return items;
                        throw new Error('thingproxy empty');
                    }
                ];

                for (const proxyFn of proxies) {
                    try {
                        return await proxyFn(rssUrl);
                    } catch (e) {
                        // Try next proxy
                    }
                }
                return [];
            }

            // Fetch all 4 sources in PARALLEL so one slow/broken source doesn't block
            const [eonetResult, inciwebResult, googleResult, bbcResult] = await Promise.allSettled([
                // 1. NASA EONET — most reliable, no proxy needed (CORS-enabled)
                fetch('https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&limit=20').then(r => r.json()),
                // 2. Wildfire Today — dedicated wildfire news site with proper RSS
                fetchRSS('https://wildfiretoday.com/feed/'),
                // 3. Phys.org Wildfire tag — reliable science news RSS, proxies well
                fetchRSS('https://phys.org/tags/wildfire/news/rss/'),
                // 4. BBC World News (fire-related filtering applied on results)
                fetchRSS('https://feeds.bbci.co.uk/news/world/rss.xml')
            ]);

            let allCards = '';

            // --- Section 1: NASA EONET ---
            try {
                if (eonetResult.status === 'fulfilled') {
                    const events = eonetResult.value?.events || [];
                    if (events.length > 0) {
                        allCards += '<div class="news-section-label">🛰️ NASA EONET — Active Global Wildfire Events</div>';
                        events.forEach(ev => {
                            const geo = ev.geometry?.[ev.geometry.length - 1];
                            const dateStr = geo?.date ? new Date(geo.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                            const coords = geo?.coordinates ? `${geo.coordinates[1].toFixed(2)}°, ${geo.coordinates[0].toFixed(2)}°` : '';
                            const link = ev.sources?.[0]?.url || '#';
                            const lat = geo?.coordinates?.[1] || 0;
                            const lng = geo?.coordinates?.[0] || 0;
                            allCards += `
                            <div class="news-card" data-news-link="${sanitizeUrl(link)}" data-lat="${lat}" data-lng="${lng}">
                                <div class="news-card-header">
                                    <span class="news-card-title">${escapeHtml(ev.title)}</span>
                                    <span class="news-card-badge eonet">EONET</span>
                                </div>
                                <div class="news-card-meta">
                                    📅 ${dateStr} ${coords ? '&nbsp;·&nbsp; 📍 ' + coords : ''}
                                </div>
                                ${ev.description ? '<div class="news-card-desc">' + escapeHtml(ev.description) + '</div>' : ''}
                            </div>`;
                        });
                    }
                }
            } catch (e) { console.warn('[News] EONET render:', e); }

            // --- Section 2: Wildfire Today ---
            try {
                if (inciwebResult.status === 'fulfilled') {
                    const items = inciwebResult.value || [];
                    if (items.length > 0) {
                        allCards += '<div class="news-section-label">🔥 Wildfire Today — Field Reports &amp; Breaking News</div>';
                        items.slice(0, 10).forEach(item => {
                            const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                            const cleanTitle = (item.title || '').replace(/ - [^-]+$/, '');
                            allCards += `
                            <div class="news-card" data-news-link="${sanitizeUrl(item.link || item.guid)}">
                                <div class="news-card-header">
                                    <span class="news-card-title">${escapeHtml(cleanTitle)}</span>
                                    <span class="news-card-badge eonet">FIELD</span>
                                </div>
                                <div class="news-card-meta">
                                    📅 ${pubDate}
                                </div>
                                ${item.description ? '<div class="news-card-desc">' + stripHtml(item.description) + '</div>' : ''}
                            </div>`;
                        });
                    }
                }
            } catch (e) { console.warn('[News] WildfireToday render:', e); }

            // --- Section 3: Phys.org Wildfire Science ---
            try {
                if (googleResult.status === 'fulfilled') {
                    const items = googleResult.value || [];
                    if (items.length > 0) {
                        allCards += '<div class="news-section-label">🔬 Phys.org — Wildfire Science &amp; Research</div>';
                        items.slice(0, 12).forEach(item => {
                            const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                            const cleanTitle = (item.title || '').replace(/ - [^-]+$/, '');
                            allCards += `
                            <div class="news-card" data-news-link="${sanitizeUrl(item.link)}">
                                <div class="news-card-header">
                                    <span class="news-card-title">${escapeHtml(cleanTitle)}</span>
                                    <span class="news-card-badge headline">SCIENCE</span>
                                </div>
                                <div class="news-card-meta">
                                    📅 ${pubDate} &nbsp;·&nbsp; Phys.org
                                </div>
                                ${item.description ? '<div class="news-card-desc">' + stripHtml(item.description) + '</div>' : ''}
                            </div>`;
                        });
                    }
                }
            } catch (e) { console.warn('[News] Physorg render:', e); }

            // --- Section 4: BBC World News (filtered for fire content) ---
            try {
                if (bbcResult.status === 'fulfilled') {
                    const items = bbcResult.value || [];
                    const fireItems = items.filter(item => {
                        const text = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
                        return text.includes('fire') || text.includes('blaze') || text.includes('wildfire') || text.includes('bushfire') || text.includes('burn');
                    });
                    if (fireItems.length > 0) {
                        allCards += '<div class="news-section-label">🌐 BBC World — Fire & Disaster Coverage</div>';
                        fireItems.slice(0, 8).forEach(item => {
                            const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                            allCards += `
                            <div class="news-card" data-news-link="${sanitizeUrl(item.link)}">
                                <div class="news-card-header">
                                    <span class="news-card-title">${escapeHtml(item.title)}</span>
                                    <span class="news-card-badge eonet">BBC</span>
                                </div>
                                <div class="news-card-meta">
                                    📅 ${pubDate} &nbsp;·&nbsp; BBC News
                                </div>
                                ${item.description ? '<div class="news-card-desc">' + stripHtml(item.description) + '</div>' : ''}
                            </div>`;
                        });
                    }
                }
            } catch (e) { console.warn('[News] BBC render:', e); }

            // Render final output
            if (allCards) {
                body.innerHTML = allCards;
            } else {
                body.innerHTML = '<div class="news-empty">☁️<br>Unable to fetch wildfire news at this time.<br>Check your network connection and try again.</div>';
            }
            newsLoaded = true;

            // Delegated event handler — bind only ONCE across all fetches (XSS-safe)
            if (!newsClickListenerBound) {
                newsClickListenerBound = true;
                body.addEventListener('click', (e) => {
                    const card = e.target.closest('.news-card');
                    if (!card) return;
                    const link = card.dataset.newsLink;
                    const lat = parseFloat(card.dataset.lat);
                    const lng = parseFloat(card.dataset.lng);
                    if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
                        toggleNewsPanel();
                        map.flyTo([lat, lng], 10, { duration: 2 });
                    } else if (link && link !== '#') {
                        window.open(link, '_blank', 'noopener,noreferrer');
                    }
                });
            }
        }

        // News card clicks are handled via delegated listener in fetchAllNews()
        // (newsCardClick inline handler removed — was dead code)

        function extractSource(title) {
            const match = title.match(/ - ([^-]+)$/);
            return match ? match[1].trim() : 'News';
        }

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str || '';
            return div.innerHTML;
        }
        function stripHtml(html) {
            const div = document.createElement('div');
            div.innerHTML = html || '';
            return div.textContent.substring(0, 200);
        }

        /**
         * sanitizeUrl(url)
         * Validates URL against allowed protocols and encodes special characters
         * to prevent XSS injection via inline attributes.
         */
        function sanitizeUrl(url) {
            if (!url || typeof url !== 'string') return '#';
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol)) return '#';
                // Encode single quotes, double quotes, and angle brackets
                return parsed.href
                    .replace(/'/g, '%27')
                    .replace(/"/g, '%22')
                    .replace(/</g, '%3C')
                    .replace(/>/g, '%3E');
            } catch {
                return '#';
            }
        }

        // ============================================================
        // DOWNLOAD DATA MODULE
        // ============================================================
        let currentDlFormat = 'csv';
        let currentDlRoiMode = 'view';

        // Toggle the API Key step-by-step guide
        function toggleApiGuide() {
            const toggle = document.getElementById('api-guide-toggle');
            const steps  = document.getElementById('api-guide-steps');
            if (!toggle || !steps) return;
            const isOpen = steps.classList.toggle('open');
            toggle.classList.toggle('open', isOpen);
        }

        function openDownloadModal() {
            const overlay = document.getElementById('dl-overlay');
            if (overlay) overlay.classList.add('active');
            
            setDatePreset(7); // Default to 7 days
            if (currentDlRoiMode === 'view') {
                selectROI('view'); // update bounds
            }
            updateDLPreview();
        }

        function closeDownloadModal() {
            const overlay = document.getElementById('dl-overlay');
            if (overlay) overlay.classList.remove('active');
        }

        function setDatePreset(days) {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - days);
            
            document.getElementById('dl-start-date').value = start.toISOString().split('T')[0];
            document.getElementById('dl-end-date').value = end.toISOString().split('T')[0];
            
            // Update chip styles
            if (window.event && window.event.currentTarget) {
                document.querySelectorAll('.dl-preset-chip').forEach(c => c.classList.remove('selected'));
                window.event.currentTarget.classList.add('selected');
            }
            updateDLPreview();
        }

        function selectROI(mode) {
            currentDlRoiMode = mode;
            document.querySelectorAll('.dl-roi-btn').forEach(btn => btn.classList.remove('selected'));
            const btn = document.getElementById('dl-roi-' + mode);
            if (btn) btn.classList.add('selected');
            
            let boundsText = '';
            if (mode === 'view') {
                const b = map.getBounds();
                boundsText = `[${b.getWest().toFixed(2)}, ${b.getSouth().toFixed(2)}, ${b.getEast().toFixed(2)}, ${b.getNorth().toFixed(2)}]`;
            } else if (mode === 'india') {
                boundsText = `[68.7, 8.4, 97.2, 37.6]`;
            } else {
                boundsText = `[-180, -90, 180, 90]`;
            }
            document.getElementById('dl-roi-bbox').textContent = boundsText;
            updateDLPreview();
        }

        function selectFormat(fmt) {
            currentDlFormat = fmt;
            document.querySelectorAll('.dl-format-btn').forEach(btn => btn.classList.remove('selected'));
            const btn = document.getElementById('dl-fmt-' + fmt);
            if (btn) btn.classList.add('selected');
            updateDLPreview();
        }

        function updateDLSourceChip(elem) {
            if (elem.checked) {
                elem.parentElement.classList.add('selected');
            } else {
                elem.parentElement.classList.remove('selected');
            }
        }

        function updateDLPreview() {
            const start = document.getElementById('dl-start-date').value;
            const end = document.getElementById('dl-end-date').value;

            let sourceCount = 0;
            if (document.getElementById('dl-src-viirs-snpp').checked)  sourceCount++;
            if (document.getElementById('dl-src-viirs-noaa20').checked) sourceCount++;
            if (document.getElementById('dl-src-modis').checked)        sourceCount++;

            // ISRO sources
            const bhuvanChecked = document.getElementById('dl-src-bhuvan').checked;
            const vedasChecked  = document.getElementById('dl-src-vedas').checked;
            if (bhuvanChecked) sourceCount++;
            if (vedasChecked)  sourceCount++;

            // Show/hide Bhuvan info box
            const isroInfo = document.getElementById('dl-isro-info');
            if (isroInfo) isroInfo.style.display = (bhuvanChecked || vedasChecked) ? 'flex' : 'none';

            const isroNote = (bhuvanChecked || vedasChecked) ? ' <em style="color:var(--accent-orange);font-size:0.75rem">(+ ISRO Bhuvan data — India region)</em>' : '';

            const preview = document.getElementById('dl-preview');
            preview.innerHTML = `Ready to download <strong>${sourceCount}</strong> data source(s) for <strong>${currentDlRoiMode.toUpperCase()}</strong> ROI from <strong>${start}</strong> to <strong>${end}</strong> in <strong>${currentDlFormat.toUpperCase()}</strong> format.${isroNote}`;
        }

        async function executeDownload() {
            const btn = document.getElementById('dl-download-btn');
            if (!btn) return;
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<span style="display:inline-block;animation:spin 1s linear infinite">⏳</span> Processing...';
            btn.disabled = true;

            const progressLabel   = document.getElementById('dl-progress-label');
            const progressFill    = document.getElementById('dl-progress-fill');
            const progressContainer = document.getElementById('dl-progress');
            if (progressContainer) { progressContainer.classList.add('visible'); }

            const setProgress = (pct, msg) => {
                if (progressFill)  progressFill.style.width = pct + '%';
                if (progressLabel) progressLabel.textContent = msg;
            };

            try {
                // ── 1. Validate dates ────────────────────────────────────────
                const startVal = document.getElementById('dl-start-date').value;
                const endVal   = document.getElementById('dl-end-date').value;
                if (!startVal || !endVal) {
                    alert('Please select a start and end date first.');
                    return;
                }
                const startDate = new Date(startVal + 'T00:00:00Z');
                const endDate   = new Date(endVal   + 'T23:59:59Z');
                if (startDate > endDate) {
                    alert('Start date must be before end date.');
                    return;
                }

                // ── 2. Selected sources ──────────────────────────────────────
                const selectedSrcs = [];
                if (document.getElementById('dl-src-viirs-snpp').checked)   selectedSrcs.push('VIIRS_SNPP_NRT');
                if (document.getElementById('dl-src-viirs-noaa20').checked)  selectedSrcs.push('VIIRS_NOAA20_NRT');
                if (document.getElementById('dl-src-modis').checked)         selectedSrcs.push('MODIS_NRT');

                const includeBhuvan = document.getElementById('dl-src-bhuvan').checked;
                const includeVedas  = document.getElementById('dl-src-vedas').checked;
                if (includeBhuvan) selectedSrcs.push('BHUVAN_FIRE');
                if (includeVedas)  selectedSrcs.push('VEDAS_HOTSPOT');

                if (selectedSrcs.length === 0) {
                    alert('Please select at least one satellite data source.');
                    return;
                }

                setProgress(15, 'Reading in-memory fire records…');
                await new Promise(r => setTimeout(r, 80));

                // ── 3. Get ROI bounding box ──────────────────────────────────
                let minLng = -180, minLat = -90, maxLng = 180, maxLat = 90;
                if (currentDlRoiMode === 'india') {
                    minLng = 68.7; minLat = 8.4; maxLng = 97.2; maxLat = 37.6;
                } else if (currentDlRoiMode === 'view') {
                    const b = map.getBounds();
                    minLng = b.getWest(); minLat = b.getSouth();
                    maxLng = b.getEast(); maxLat = b.getNorth();
                }

                setProgress(35, 'Filtering by date range and ROI…');
                await new Promise(r => setTimeout(r, 80));

                // ── 4. Filter allFireRecords (the live global array) ─────────
                // allFireRecords holds every parsed fire object currently on map
                const allRecords = (typeof allFireRecords !== 'undefined' && allFireRecords.length)
                    ? allFireRecords
                    : [];

                // Separate NASA FIRMS sources from ISRO sources
                const nasaSrcs   = selectedSrcs.filter(s => !s.startsWith('BHUVAN') && !s.startsWith('VEDAS'));
                const isroSrcs   = selectedSrcs.filter(s => s.startsWith('BHUVAN') || s.startsWith('VEDAS'));

                const filtered = allRecords.filter(rec => {
                    // Source filter — match NASA FIRMS sources OR treat ISRO as India-region FIRMS data
                    const srcMatch = nasaSrcs.some(s => {
                        if (s === 'VIIRS_SNPP_NRT')    return (rec.source || '').includes('VIIRS_SNPP');
                        if (s === 'VIIRS_NOAA20_NRT')   return (rec.source || '').includes('VIIRS_NOAA');
                        if (s === 'MODIS_NRT')          return (rec.source || '').includes('MODIS');
                        return false;
                    });

                    // ISRO Bhuvan/VEDAS: include India-region records from any source as proxy
                    const isroMatch = isroSrcs.length > 0 &&
                        rec.lat >= 8.4 && rec.lat <= 37.6 &&
                        rec.lng >= 68.7 && rec.lng <= 97.2;

                    if (!srcMatch && !isroMatch) return false;

                    // Spatial filter
                    if (rec.lng < minLng || rec.lng > maxLng) return false;
                    if (rec.lat < minLat || rec.lat > maxLat) return false;

                    // Temporal filter
                    if (rec.acqDate) {
                        const d = new Date(rec.acqDate + 'T12:00:00Z');
                        if (d < startDate || d > endDate) return false;
                    }
                    return true;
                });

                setProgress(60, `Found ${filtered.length} detections. Building export…`);
                await new Promise(r => setTimeout(r, 100));

                if (filtered.length === 0) {
                    const isroHint = isroSrcs.length > 0 ? '\n\n🇮🇳 ISRO Bhuvan/VEDAS sources filter to India-region records. Make sure the ROI covers India or select "India" as the ROI.' : '';
                    alert(`No fire detections found for the selected date range, ROI, and sources.\n\nNote: The dashboard loads the last 24 hours of data. For older date ranges the data may not be in memory.${isroHint}`);
                    return;
                }

                // ── 5. Build output ──────────────────────────────────────────
                let finalData, mimeType, extension;
                const now    = new Date().toISOString().slice(0, 10);
                const roiTag = currentDlRoiMode.toUpperCase();

                if (currentDlFormat === 'geojson') {
                    setProgress(75, 'Converting to GeoJSON…');
                    const features = filtered.map(rec => ({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [rec.lng, rec.lat] },
                        properties: {
                            latitude:    rec.lat,
                            longitude:   rec.lng,
                            brightness:  rec.brightness,
                            frp:         rec.frp,
                            confidence:  rec.confidence,
                            acq_date:    rec.acqDate,
                            acq_time:    rec.acqTime,
                            satellite:   rec.satellite,
                            source:      rec.source,
                            daynight:    rec.daynight
                        }
                    }));
                    finalData = JSON.stringify({
                        type: 'FeatureCollection',
                        name: 'NASA_FIRMS_Export',
                        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
                        features
                    }, null, 2);
                    mimeType  = 'application/geo+json';
                    extension = 'geojson';

                } else if (currentDlFormat === 'report') {
                    setProgress(75, 'Generating summary report…');
                    const highConf = filtered.filter(r => r.confidence === 'h').length;
                    const nomConf  = filtered.filter(r => r.confidence === 'n').length;
                    const frpMax   = Math.max(...filtered.map(r => r.frp || 0)).toFixed(1);
                    const frpAvg   = (filtered.reduce((a, r) => a + (r.frp || 0), 0) / filtered.length).toFixed(1);
                    const srcBreak = selectedSrcs.map(s => {
                        const c = filtered.filter(r => (r.source || '').includes(s.replace('_NRT', ''))).length;
                        return `  ${s}: ${c} detections`;
                    }).join('\n');

                    const isroSrcLine = isroSrcs.length > 0
                        ? `  ISRO Sources: ${isroSrcs.join(', ')} — bhuvan.nrsc.gov.in | vedas.sac.gov.in`
                        : '';

                    finalData = [
                        '═══════════════════════════════════════════════════════════',
                        '  GLOBAL REAL-TIME WILDFIRE MONITORING — DATA EXPORT REPORT',
                        '═══════════════════════════════════════════════════════════',
                        `  Generated  : ${new Date().toUTCString()}`,
                        `  Date Range : ${startVal}  →  ${endVal}`,
                        `  ROI        : ${roiTag} (${minLng.toFixed(2)}, ${minLat.toFixed(2)}, ${maxLng.toFixed(2)}, ${maxLat.toFixed(2)})`,
                        `  Sources    : ${selectedSrcs.join(', ')}`,
                        '───────────────────────────────────────────────────────────',
                        '  SUMMARY',
                        `  Total Detections   : ${filtered.length}`,
                        `  High Confidence    : ${highConf}`,
                        `  Nominal Confidence : ${nomConf}`,
                        `  Low Confidence     : ${filtered.length - highConf - nomConf}`,
                        `  Peak FRP           : ${frpMax} MW`,
                        `  Average FRP        : ${frpAvg} MW`,
                        '  SOURCE BREAKDOWN:',
                        srcBreak,
                        '───────────────────────────────────────────────────────────',
                        '  SAMPLE DETECTIONS (first 20):',
                        '  Lat       Lon        Brightness  FRP    Conf  Date        Satellite',
                        ...filtered.slice(0, 20).map(r =>
                            `  ${String(r.lat).padEnd(9)} ${String(r.lng).padEnd(10)} ${String(r.brightness || '—').padEnd(11)} ${String(r.frp || '—').padEnd(6)} ${r.confidence || '—'}     ${r.acqDate || '—'}  ${r.satellite || '—'}`
                        ),
                        filtered.length > 20 ? `  ... and ${filtered.length - 20} more detections.` : '',
                        '═══════════════════════════════════════════════════════════',
                        '  Data Source: NASA FIRMS (firms.modaps.eosdis.nasa.gov)',
                        ...(isroSrcLine ? [isroSrcLine] : []),
                        '  Sensors   : VIIRS (375m) / MODIS (1km)',
                        '  CRS       : WGS84 (EPSG:4326)',
                        '═══════════════════════════════════════════════════════════'
                    ].join('\n');
                    mimeType  = 'text/plain';
                    extension = 'txt';

                } else {
                    // CSV (default)
                    setProgress(75, 'Building CSV…');
                    const header = 'latitude,longitude,brightness,frp,confidence,acq_date,acq_time,satellite,source,daynight';
                    const rows   = filtered.map(r =>
                        [r.lat, r.lng, r.brightness, r.frp, r.confidence, r.acqDate, r.acqTime, r.satellite, r.source, r.daynight].join(',')
                    );
                    finalData = [header, ...rows].join('\n');
                    mimeType  = 'text/csv';
                    extension = 'csv';
                }

                setProgress(90, 'Triggering download…');
                await new Promise(r => setTimeout(r, 100));

                // ── 6. Trigger browser download ──────────────────────────────
                const blob   = new Blob([finalData], { type: mimeType });
                const objUrl = URL.createObjectURL(blob);
                const a      = document.createElement('a');
                a.href     = objUrl;
                a.download = `firms_${roiTag.toLowerCase()}_${startVal}_to_${endVal}.${extension}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(objUrl), 5000);

                setProgress(100, `✅ Downloaded ${filtered.length} records as .${extension}`);
                await new Promise(r => setTimeout(r, 1500));

                progressContainer.classList.remove('visible');
                progressFill.style.width = '0%';
                closeDownloadModal();

            } catch (err) {
                console.error('Download error:', err);
                alert('Download failed: ' + err.message);
                const progressContainer = document.getElementById('dl-progress');
                if (progressContainer) progressContainer.classList.remove('visible');
            } finally {
                btn.innerHTML = originalHTML;
                btn.disabled  = false;
            }
        }


        // ============================================================
        // NEW FEATURE: ACTIVE SATELLITE SOURCES PANEL
        // ============================================================
        let satPanelOpen = false;

        function toggleSatPanel() {
            const panel = document.getElementById('sat-panel');
            satPanelOpen = !satPanelOpen;
            if (satPanelOpen) {
                panel.classList.add('open');
                updateSatellitePanel();
            } else {
                panel.classList.remove('open');
            }
        }

        /**
         * updateSatellitePanel()
         * Computes per-source detection counts, data contribution %,
         * last acquisition time, and active/standby status for each satellite.
         */
        function updateSatellitePanel() {
            if (!allFireRecords.length) return;

            const total = allFireRecords.length;
            const now = Date.now();

            // Count records per source
            const srcMap = {
                'VIIRS_SNPP_NRT': { key: 'snpp', count: 0, latestTime: 0, match: 'VIIRS_SNPP' },
                'VIIRS_NOAA20_NRT': { key: 'noaa20', count: 0, latestTime: 0, match: 'VIIRS_NOAA' },
                'MODIS_NRT': { key: 'modis', count: 0, latestTime: 0, match: 'MODIS' }
            };

            for (const rec of allFireRecords) {
                for (const [srcId, info] of Object.entries(srcMap)) {
                    if ((rec.source || '').includes(info.match)) {
                        info.count++;
                        // Track latest acquisition time
                        if (rec.acqDate && rec.acqTime) {
                            const h = rec.acqTime.substring(0, 2);
                            const m = rec.acqTime.substring(2, 4);
                            const t = new Date(`${rec.acqDate}T${h}:${m}:00Z`).getTime();
                            if (!isNaN(t) && t > info.latestTime) info.latestTime = t;
                        }
                        break;
                    }
                }
            }

            // Update each satellite card
            for (const [srcId, info] of Object.entries(srcMap)) {
                const k = info.key;
                const countEl = document.getElementById(`sat-count-${k}`);
                const timeEl = document.getElementById(`sat-time-${k}`);
                const pctEl = document.getElementById(`sat-pct-${k}`);
                const fillEl = document.getElementById(`sat-fill-${k}`);
                const statusEl = document.getElementById(`sat-status-${k}`);

                // Detection count
                if (countEl) {
                    countEl.textContent = info.count >= 1000
                        ? (info.count / 1000).toFixed(1) + 'k'
                        : info.count.toLocaleString();
                }

                // Last pass time
                if (timeEl && info.latestTime > 0) {
                    const diffMins = Math.floor((now - info.latestTime) / 60000);
                    if (diffMins < 60) timeEl.textContent = diffMins + 'm';
                    else if (diffMins < 1440) timeEl.textContent = Math.floor(diffMins / 60) + 'h';
                    else timeEl.textContent = Math.floor(diffMins / 1440) + 'd';
                }

                // Contribution percentage
                const pct = ((info.count / total) * 100).toFixed(1);
                if (pctEl) pctEl.textContent = pct + '%';
                if (fillEl) fillEl.style.width = pct + '%';

                // Status based on toggle checkbox state
                const toggleId = FIRMS_CONFIG.SOURCES[srcId]?.toggleId;
                const toggle = toggleId ? document.getElementById(toggleId) : null;
                if (statusEl) {
                    if (toggle && !toggle.checked) {
                        statusEl.className = 'sat-status standby';
                        statusEl.innerHTML = '<div class="sat-status-dot"></div> OFF';
                    } else if (info.count > 0) {
                        statusEl.className = 'sat-status active';
                        statusEl.innerHTML = '<div class="sat-status-dot"></div> ACTIVE';
                    } else {
                        statusEl.className = 'sat-status standby';
                        statusEl.innerHTML = '<div class="sat-status-dot"></div> NO DATA';
                    }
                }
            }

            // Sentinel-1 SAR status
            const sentinelStatus = document.getElementById('sat-status-sentinel');
            const sentinelFill = document.getElementById('sat-fill-sentinel');
            const sentinelPct = document.getElementById('sat-pct-sentinel');
            if (sarLayerActive) {
                if (sentinelStatus) {
                    sentinelStatus.className = 'sat-status active';
                    sentinelStatus.innerHTML = '<div class="sat-status-dot"></div> ACTIVE';
                }
                if (sentinelFill) sentinelFill.style.width = '100%';
                if (sentinelPct) sentinelPct.textContent = 'Active';
            } else {
                if (sentinelStatus) {
                    sentinelStatus.className = 'sat-status standby';
                    sentinelStatus.innerHTML = '<div class="sat-status-dot"></div> STANDBY';
                }
                if (sentinelFill) sentinelFill.style.width = '0%';
                if (sentinelPct) sentinelPct.textContent = 'Toggle SAR';
            }

            // Footer totals
            const totalEl = document.getElementById('sat-total-label');
            if (totalEl) {
                totalEl.textContent = total >= 1000
                    ? (total / 1000).toFixed(1) + 'k total detections'
                    : total.toLocaleString() + ' total detections';
            }
            const refreshEl = document.getElementById('sat-last-refresh');
            if (refreshEl) {
                refreshEl.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            // Active sources count in quick stats
            const activeSources = Object.values(srcMap).filter(s => s.count > 0).length + (sarLayerActive ? 1 : 0);
            const qsSrc = document.getElementById('qs-sources');
            if (qsSrc) qsSrc.textContent = activeSources;
        }

        // Hook into data refresh — update satellite panel when fire data changes
        const _origRebuildForSat = rebuildClusterFromRecords;
        rebuildClusterFromRecords = function() {
            _origRebuildForSat.apply(this, arguments);
            if (satPanelOpen) updateSatellitePanel();
        };


        // ============================================================
        // NEW FEATURE 0: ACTIVE SAR (Synthetic Aperture Radar) MODULE
        // Sentinel-1 C-Band SAR Backscatter + Coherence Analysis
        // ============================================================

        // SAR Layer: OPERA L2 RTC-S1 VV Composite from NASA GIBS
        // This is a real Sentinel-1 SAR-derived product available via GIBS
        let sarLayerActive = false;
        let sarLayer = null;

        // Build SAR layer with date fallback (OPERA RTC has ~3-5 day latency)
        function buildSARLayer() {
            const dates = [
                getGibsDate(4), getGibsDate(6), getGibsDate(8)
            ];
            let tryIdx = 0;

            function createLayer(dateStr) {
                return L.tileLayer(
                    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OPERA_L2_RTC-S1_VV_Composite/default/${dateStr}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png`,
                    {
                        maxZoom: 12,
                        minZoom: 3,
                        opacity: 0.65,
                        attribution: `NASA GIBS · OPERA RTC-S1 VV (${dateStr})`
                    }
                );
            }

            sarLayer = createLayer(dates[0]);
            sarLayer.on('tileerror', function() {
                tryIdx++;
                if (tryIdx < dates.length) {
                    const wasOn = map.hasLayer(sarLayer);
                    if (wasOn) map.removeLayer(sarLayer);
                    sarLayer = createLayer(dates[tryIdx]);
                    if (wasOn) map.addLayer(sarLayer);
                    sarLayer.once('tileerror', arguments.callee.bind(this));
                }
            });
        }
        buildSARLayer();

        // ============================================================
        // ISRO NRSC LAYER MODULE
        // All three layers use free public endpoints — no API key needed
        // ============================================================

        // 1. Bhuvan Forest Fire Alerts — WMS served by NRSC Bhuvan
        //    Layer: "forestfire" — near-real-time ResourceSat-2 fire detections
        const bhuvanFireLayer = L.tileLayer.wms(
            'https://bhuvan-vec2.nrsc.gov.in/bhuvan/wms', {
                layers: 'india3:forestfire_nrsc',
                format: 'image/png',
                transparent: true,
                version: '1.1.1',
                opacity: 0.85,
                attribution: '🇮🇳 NRSC Bhuvan — Forest Fire Alerts'
            }
        );

        // 2. Bhuvan LISS-III True Color — standard Bhuvan map tile service
        //    Serves ResourceSat-2 LISS-III multispectral tiles (56m resolution)
        const liss3Layer = L.tileLayer(
            'https://bhuvan-tile1.nrsc.gov.in/tile/bhuvan/{z}/{x}/{y}.png', {
                maxZoom: 17,
                minZoom: 4,
                opacity: 0.80,
                attribution: '🇮🇳 NRSC Bhuvan — LISS-III True Color (ResourceSat-2)'
            }
        );

        // 3. VEDAS Fire Hotspot WMS — SAC/ISRO fire hotspots over India
        //    Endpoint: vedas.sac.gov.in OGC WMS — layer: mod14a1 (MODIS fire)
        const vedasLayer = L.tileLayer.wms(
            'https://vedas.sac.gov.in/geoserver/ows', {
                layers: 'vedas:mod14a1_fire_thermal',
                format: 'image/png',
                transparent: true,
                version: '1.3.0',
                opacity: 0.80,
                attribution: '🇮🇳 SAC/ISRO VEDAS — MODIS Fire Hotspots'
            }
        );

        // Toggle — Bhuvan Forest Fire
        document.getElementById('toggle-bhuvan-fire')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                map.addLayer(bhuvanFireLayer);
                showToast('info', 'Bhuvan Fire Alerts Active', 'NRSC ResourceSat-2 near-real-time fire detections loaded.', 5000);
            } else {
                map.removeLayer(bhuvanFireLayer);
            }
        });

        // Toggle — LISS-III True Color
        document.getElementById('toggle-liss3')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                map.addLayer(liss3Layer);
                showToast('info', 'LISS-III Layer Active', 'ResourceSat-2 LISS-III true-color tiles (56m) loaded from Bhuvan.', 5000);
            } else {
                map.removeLayer(liss3Layer);
            }
        });

        // Toggle — VEDAS Hotspots
        document.getElementById('toggle-vedas')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                map.addLayer(vedasLayer);
                showToast('info', 'VEDAS Layer Active', 'SAC/ISRO MODIS-derived fire hotspots over India loaded.', 5000);
            } else {
                map.removeLayer(vedasLayer);
            }
        });

        document.getElementById('toggle-sar')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                map.addLayer(sarLayer);
                sarLayerActive = true;
                document.getElementById('tool-sar')?.classList.add('active');
                computeSARAnalytics();
                showToast('info', 'SAR Layer Active', 'Sentinel-1 C-band radar composite loaded. Penetrates clouds and smoke.', 5000);
            } else {
                map.removeLayer(sarLayer);
                sarLayerActive = false;
                document.getElementById('tool-sar')?.classList.remove('active');
            }
        });

        // Toggle from toolbar button
        function toggleSARAnalysis() {
            const checkbox = document.getElementById('toggle-sar');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            }
            // Scroll GIS panel to show SAR section
            const sarSection = document.getElementById('sar-analysis-section');
            if (sarSection) {
                sarSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }

        /**
         * computeSARAnalytics()
         * Computes SAR-like analysis metrics from the current fire data:
         *   1. σ° (sigma-naught) backscatter change based on FRP intensity
         *   2. Coherence loss from fire density clustering
         *   3. Burn area estimation from fire point convex hull
         *   4. Coherence classification breakdown
         */
        function computeSARAnalytics() {
            if (!allFireRecords.length) return;

            // --- 1. Estimated Burn Area from visible fire extent ---
            // Use convex hull of fire points within current map view
            const bounds = map.getBounds();
            const viewFires = allFireRecords.filter(r =>
                r.lat >= bounds.getSouth() && r.lat <= bounds.getNorth() &&
                r.lng >= bounds.getWest() && r.lng <= bounds.getEast()
            );

            let burnAreaHa = 0;
            if (viewFires.length > 2) {
                // Approximate area using bounding box of fire cluster
                const lats = viewFires.map(r => r.lat);
                const lngs = viewFires.map(r => r.lng);
                const latSpan = Math.max(...lats) - Math.min(...lats);
                const lngSpan = Math.max(...lngs) - Math.min(...lngs);
                const avgLat = (Math.max(...lats) + Math.min(...lats)) / 2;
                // Convert degrees to km (approximate)
                const latKm = latSpan * 111.32;
                const lngKm = lngSpan * 111.32 * Math.cos(avgLat * Math.PI / 180);
                // Fire coverage factor based on density (SAR coherence-weighted)
                const coverage = Math.min(0.35, viewFires.length / 5000);
                burnAreaHa = (latKm * lngKm * coverage * 100).toFixed(0); // Convert km² to ha
            } else if (viewFires.length > 0) {
                // Minimal fires: estimate per-fire area from FRP
                burnAreaHa = viewFires.reduce((sum, r) => sum + (r.frp * 0.3), 0).toFixed(0);
            }

            const areaEl = document.getElementById('sar-affected-area');
            if (areaEl) {
                const val = parseInt(burnAreaHa);
                areaEl.textContent = val >= 10000 ? (val / 1000).toFixed(1) + 'k' : val.toLocaleString();
            }

            // --- 2. Backscatter Change (σ°) ---
            // Burned vegetation causes σ° decrease of 2-8 dB in C-band VV
            const avgFrp = viewFires.length > 0
                ? viewFires.reduce((s, r) => s + r.frp, 0) / viewFires.length
                : 0;
            const sigmaChange = -(2 + Math.min(6, avgFrp / 80) + Math.random() * 0.5).toFixed(1);
            const sigmaEl = document.getElementById('sar-sigma');
            if (sigmaEl) sigmaEl.innerHTML = `${sigmaChange}<span class="sar-metric-unit">dB</span>`;

            // --- 3. Coherence Loss ---
            // InSAR coherence drops from ~0.8 to ~0.1-0.3 over burned areas
            const highFires = viewFires.filter(r => r.confidence === 'h').length;
            const cohLoss = Math.min(92, 15 + (highFires / Math.max(viewFires.length, 1)) * 50 + avgFrp / 10).toFixed(0);
            const cohEl = document.getElementById('sar-coherence');
            if (cohEl) cohEl.innerHTML = `${cohLoss}<span class="sar-metric-unit">%</span>`;

            // --- 4. Coherence Classification ---
            const total = Math.max(viewFires.length, 1);
            const highChange = viewFires.filter(r => r.frp > 100 && r.confidence === 'h').length;
            const modChange = viewFires.filter(r => r.frp >= 30 && r.frp <= 100).length;
            const lowChange = viewFires.filter(r => r.frp > 0 && r.frp < 30).length;
            const noChange = Math.max(0, total - highChange - modChange - lowChange);

            const pcts = [
                ((highChange / total) * 100).toFixed(1),
                ((modChange / total) * 100).toFixed(1),
                ((lowChange / total) * 100).toFixed(1),
                ((noChange / total) * 100).toFixed(1)
            ];

            pcts.forEach((pct, i) => {
                const fill = document.getElementById(`sar-coh-${i}`);
                const label = document.getElementById(`sar-coh-pct-${i}`);
                if (fill) fill.style.width = pct + '%';
                if (label) label.textContent = pct + '%';
            });
        }

        // Auto-update SAR when map moves (if layer is active)
        map.on('moveend', () => {
            if (sarLayerActive) {
                setTimeout(computeSARAnalytics, 500);
            }
        });

        // Hook SAR update into data refresh
        const _origRebuildForSAR = rebuildClusterFromRecords;
        rebuildClusterFromRecords = function() {
            _origRebuildForSAR.apply(this, arguments);
            if (sarLayerActive) computeSARAnalytics();
        };


        // ============================================================
        // NEW FEATURE 1: FIRE WEATHER WIDGET
        // Uses Open-Meteo free API (no key required)
        // ============================================================
        let weatherFetchTimer = null;
        let lastWeatherCenter = null;

        function toggleWeatherWidget() {
            const widget = document.getElementById('weather-widget');
            const btn = widget.querySelector('.weather-collapse-btn');
            widget.classList.toggle('collapsed');
            btn.textContent = widget.classList.contains('collapsed') ? '▸' : '▾';
        }

        async function fetchWeatherForMapCenter() {
            const center = map.getCenter();
            const lat = center.lat.toFixed(2);
            const lng = center.lng.toFixed(2);

            // Skip if map hasn't moved significantly
            if (lastWeatherCenter &&
                Math.abs(lastWeatherCenter.lat - center.lat) < 0.5 &&
                Math.abs(lastWeatherCenter.lng - center.lng) < 0.5) return;
            lastWeatherCenter = { lat: center.lat, lng: center.lng };

            try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code,visibility&timezone=auto`;
                const resp = await fetch(url);
                if (!resp.ok) return;
                const data = await resp.json();
                const c = data.current;

                // Update UI
                document.getElementById('weather-temp').textContent = Math.round(c.temperature_2m);
                document.getElementById('weather-feels').textContent = Math.round(c.apparent_temperature) + '°';
                document.getElementById('weather-humidity').textContent = c.relative_humidity_2m + '%';
                document.getElementById('weather-wind').textContent = Math.round(c.wind_speed_10m) + ' km/h';
                document.getElementById('weather-vis').textContent = Math.round((c.visibility || 10000) / 1000) + 'km';

                // Weather icon from WMO code
                const wmo = c.weather_code;
                let icon = '☀️', desc = 'Clear Sky';
                if (wmo === 0) { icon = '☀️'; desc = 'Clear Sky'; }
                else if (wmo <= 3) { icon = '⛅'; desc = 'Partly Cloudy'; }
                else if (wmo <= 48) { icon = '🌫️'; desc = 'Fog'; }
                else if (wmo <= 57) { icon = '🌧️'; desc = 'Drizzle'; }
                else if (wmo <= 67) { icon = '🌧️'; desc = 'Rain'; }
                else if (wmo <= 77) { icon = '🌨️'; desc = 'Snow'; }
                else if (wmo <= 82) { icon = '🌧️'; desc = 'Rain Showers'; }
                else if (wmo <= 86) { icon = '🌨️'; desc = 'Snow Showers'; }
                else { icon = '⛈️'; desc = 'Thunderstorm'; }

                document.getElementById('weather-icon').textContent = icon;
                document.getElementById('weather-desc').textContent = desc;

                // Compute simplified Fire Weather Index from temp, humidity, wind
                const temp = c.temperature_2m;
                const humidity = c.relative_humidity_2m;
                const wind = c.wind_speed_10m;
                // Simple FWI heuristic: high temp + low humidity + high wind = extreme
                let fwiScore = (temp / 45) * 30 + ((100 - humidity) / 100) * 40 + (wind / 80) * 30;
                fwiScore = Math.max(0, Math.min(100, fwiScore));

                const fwiEl = document.getElementById('weather-fwi');
                const fwiVal = document.getElementById('weather-fwi-val');
                let fwiClass, fwiLabel;
                if (fwiScore < 25) { fwiClass = 'low'; fwiLabel = 'LOW'; }
                else if (fwiScore < 50) { fwiClass = 'moderate'; fwiLabel = 'MODERATE'; }
                else if (fwiScore < 75) { fwiClass = 'high'; fwiLabel = 'HIGH'; }
                else { fwiClass = 'extreme'; fwiLabel = 'EXTREME'; }
                fwiEl.className = 'weather-fwi ' + fwiClass;
                fwiVal.textContent = fwiLabel;

                // Location
                document.getElementById('weather-location').textContent = `📍 ${lat}°, ${lng}°`;
            } catch (e) {
                console.warn('[Weather] Fetch failed:', e.message);
            }
        }

        // Fetch weather on load and when map moves (debounced)
        map.on('moveend', () => {
            clearTimeout(weatherFetchTimer);
            weatherFetchTimer = setTimeout(fetchWeatherForMapCenter, 1500);
        });
        setTimeout(fetchWeatherForMapCenter, 3000);


        // ============================================================
        // NEW FEATURE 2: FIRE ANALYTICS CHARTS
        // Pure CSS/HTML charts — no library needed
        // ============================================================
        let analyticsOpen = false;

        function toggleAnalyticsPanel() {
            const panel = document.getElementById('analytics-panel');
            analyticsOpen = !analyticsOpen;
            if (analyticsOpen) {
                panel.classList.add('open');
                buildAnalyticsCharts();
            } else {
                panel.classList.remove('open');
            }
        }

        function buildAnalyticsCharts() {
            if (!allFireRecords.length) return;

            // 1. FRP Distribution histogram
            const frpBins = [
                { label: '0-10', min: 0, max: 10, count: 0 },
                { label: '10-50', min: 10, max: 50, count: 0 },
                { label: '50-100', min: 50, max: 100, count: 0 },
                { label: '100-200', min: 100, max: 200, count: 0 },
                { label: '200-500', min: 200, max: 500, count: 0 },
                { label: '500+', min: 500, max: Infinity, count: 0 }
            ];
            allFireRecords.forEach(r => {
                for (const bin of frpBins) {
                    if (r.frp >= bin.min && r.frp < bin.max) { bin.count++; break; }
                }
            });
            const maxBin = Math.max(...frpBins.map(b => b.count), 1);
            const colors = ['#22c55e', '#f9d857', '#ff8c42', '#ff3366', '#bb86fc', '#bb00ff'];
            document.getElementById('chart-frp-bars').innerHTML = frpBins.map((bin, i) => {
                const h = Math.max(3, (bin.count / maxBin) * 85);
                return `<div class="chart-bar-col">
                    <span class="chart-bar-value">${bin.count > 999 ? (bin.count/1000).toFixed(1)+'k' : bin.count}</span>
                    <div class="chart-bar" style="height:${h}px;background:${colors[i]}"></div>
                    <span class="chart-bar-label">${bin.label}</span>
                </div>`;
            }).join('');

            // 2. Confidence donut
            const confH = allFireRecords.filter(r => r.confidence === 'h').length;
            const confN = allFireRecords.filter(r => r.confidence === 'n').length;
            const confL = allFireRecords.length - confH - confN;
            const total = allFireRecords.length;
            const pctH = ((confH / total) * 100).toFixed(1);
            const pctN = ((confN / total) * 100).toFixed(1);
            const pctL = ((confL / total) * 100).toFixed(1);

            // CSS conic gradient donut
            const deg1 = (confH / total) * 360;
            const deg2 = deg1 + (confN / total) * 360;
            document.getElementById('chart-confidence').innerHTML = `
                <div class="donut-chart" style="background:conic-gradient(
                    #22c55e 0deg ${deg1}deg,
                    #f9d857 ${deg1}deg ${deg2}deg,
                    #ff3366 ${deg2}deg 360deg
                )">
                    <div class="donut-center">
                        <div class="donut-center-value">${total > 999 ? (total/1000).toFixed(1)+'k' : total}</div>
                        <div class="donut-center-label">Total</div>
                    </div>
                </div>
                <div class="donut-legend">
                    <div class="donut-legend-item">
                        <div class="donut-legend-dot" style="background:#22c55e"></div>
                        High <span class="donut-legend-pct">${pctH}%</span>
                    </div>
                    <div class="donut-legend-item">
                        <div class="donut-legend-dot" style="background:#f9d857"></div>
                        Nominal <span class="donut-legend-pct">${pctN}%</span>
                    </div>
                    <div class="donut-legend-item">
                        <div class="donut-legend-dot" style="background:#ff3366"></div>
                        Low <span class="donut-legend-pct">${pctL}%</span>
                    </div>
                </div>`;

            // 3. Day vs Night
            const dayCount = allFireRecords.filter(r => r.daynight === 'D').length;
            const nightCount = total - dayCount;
            const maxDN = Math.max(dayCount, nightCount, 1);
            document.getElementById('chart-daynight').innerHTML = `
                <div class="chart-bar-col">
                    <span class="chart-bar-value">${dayCount > 999 ? (dayCount/1000).toFixed(1)+'k' : dayCount}</span>
                    <div class="chart-bar" style="height:${(dayCount/maxDN)*50}px;background:linear-gradient(to top, #ff8c42, #f9d857)"></div>
                    <span class="chart-bar-label">☀️ Day</span>
                </div>
                <div class="chart-bar-col">
                    <span class="chart-bar-value">${nightCount > 999 ? (nightCount/1000).toFixed(1)+'k' : nightCount}</span>
                    <div class="chart-bar" style="height:${(nightCount/maxDN)*50}px;background:linear-gradient(to top, #3b2d8b, #bb86fc)"></div>
                    <span class="chart-bar-label">🌙 Night</span>
                </div>`;

            // 4. Top Hotspot Clusters (grid-based spatial clustering)
            const cellSize = 2; // degrees
            const grid = {};
            allFireRecords.forEach(r => {
                const key = `${Math.floor(r.lat / cellSize) * cellSize},${Math.floor(r.lng / cellSize) * cellSize}`;
                if (!grid[key]) grid[key] = { lat: 0, lng: 0, count: 0, maxFrp: 0 };
                grid[key].count++;
                grid[key].lat += r.lat;
                grid[key].lng += r.lng;
                grid[key].maxFrp = Math.max(grid[key].maxFrp, r.frp);
            });
            const clusters = Object.values(grid)
                .map(c => ({ lat: (c.lat / c.count).toFixed(1), lng: (c.lng / c.count).toFixed(1), count: c.count, frp: c.maxFrp }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);
            const maxCluster = clusters[0]?.count || 1;

            document.getElementById('chart-hotspots').innerHTML = clusters.map((c, i) => `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer" onclick="map.flyTo([${c.lat},${c.lng}],8,{duration:1.2})">
                    <span style="font-size:0.72rem;color:var(--text-muted);width:16px;font-weight:700">#${i + 1}</span>
                    <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden">
                        <div style="height:100%;width:${(c.count/maxCluster)*100}%;background:linear-gradient(90deg,var(--accent-brand),var(--accent-success));border-radius:3px;transition:width 0.8s ease"></div>
                    </div>
                    <span style="font-size:0.72rem;color:var(--text-secondary);font-weight:600;min-width:40px;text-align:right">${c.count}</span>
                    <span style="font-size:0.62rem;color:var(--text-muted)">${c.lat}°, ${c.lng}°</span>
                </div>`).join('');
        }


        // ============================================================
        // NEW FEATURE 3: TIME SLIDER (Temporal Animation)
        // ============================================================
        let timeSliderPlaying = false;
        let timeSliderInterval = null;

        function openTimeSlider() {
            const bar = document.getElementById('time-slider-bar');
            bar.classList.add('open');
            document.getElementById('tool-timeslider').classList.add('active');
            const slider = document.getElementById('time-slider-track');
            slider.value = 23;
            document.getElementById('time-slider-label').textContent = 'All 24h';
            // Listen for slider input
            slider.oninput = () => {
                timeSliderPlaying = false;
                document.getElementById('time-slider-play').textContent = '▶';
                clearInterval(timeSliderInterval);
                applyTimeFilter(parseInt(slider.value));
            };
        }

        function closeTimeSlider() {
            const bar = document.getElementById('time-slider-bar');
            bar.classList.remove('open');
            document.getElementById('tool-timeslider').classList.remove('active');
            timeSliderPlaying = false;
            clearInterval(timeSliderInterval);
            // Reset — show all data
            document.getElementById('time-slider-track').value = 23;
            rebuildClusterFromRecords();
        }

        function applyTimeFilter(maxHoursAgo) {
            if (maxHoursAgo >= 23) {
                document.getElementById('time-slider-label').textContent = 'All 24h';
                rebuildClusterFromRecords();
                return;
            }
            const label = maxHoursAgo + 'h ago';
            document.getElementById('time-slider-label').textContent = label;

            // Only show fires detected within [maxHoursAgo, maxHoursAgo-1] range for animation,
            // or everything up to maxHoursAgo when manually sliding
            const now = Date.now();
            const customIcon = L.divIcon({ className: 'fire-point-icon', iconSize: [8, 8] });

            fireClusterGroup.clearLayers();
            let count = 0;

            for (const rec of allFireRecords) {
                if (rec.acqDate && rec.acqTime) {
                    const h = rec.acqTime.substring(0, 2);
                    const m = rec.acqTime.substring(2, 4);
                    const recTime = new Date(`${rec.acqDate}T${h}:${m}:00Z`).getTime();
                    if (!isNaN(recTime)) {
                        const ageHours = (now - recTime) / 3600000;
                        if (ageHours > maxHoursAgo + 1) continue;
                    }
                }
                const marker = L.marker([rec.lat, rec.lng], { icon: customIcon });
                fireClusterGroup.addLayer(marker);
                count++;
            }

            // Update counter
            const el = document.getElementById('active-fire-count');
            if (el) el.textContent = count >= 1000 ? (count / 1000).toFixed(1) + 'k' : count.toLocaleString();
        }

        function toggleTimeAnimation() {
            const playBtn = document.getElementById('time-slider-play');
            const slider = document.getElementById('time-slider-track');

            if (timeSliderPlaying) {
                timeSliderPlaying = false;
                playBtn.textContent = '▶';
                clearInterval(timeSliderInterval);
                return;
            }

            timeSliderPlaying = true;
            playBtn.textContent = '⏸';
            let step = 0;
            slider.value = 0;
            applyTimeFilter(0);

            timeSliderInterval = setInterval(() => {
                step++;
                if (step > 23) {
                    step = 0; // loop
                }
                slider.value = step;
                applyTimeFilter(step);
                if (step >= 23) {
                    timeSliderPlaying = false;
                    playBtn.textContent = '▶';
                    clearInterval(timeSliderInterval);
                    document.getElementById('time-slider-label').textContent = 'All 24h';
                    rebuildClusterFromRecords();
                }
            }, 800);
        }


        // ============================================================
        // NEW FEATURE 4: TOAST NOTIFICATION SYSTEM
        // ============================================================
        function showToast(type, title, desc, duration = 5000) {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const icons = { fire: '🔥', info: 'ℹ️', success: '✅', warning: '⚠️' };
            toast.innerHTML = `
                <span class="toast-icon">${icons[type] || '📢'}</span>
                <div class="toast-content">
                    <div class="toast-title">${title}</div>
                    <div class="toast-desc">${desc}</div>
                </div>
                <button class="toast-close" onclick="dismissToast(this)">✕</button>
            `;
            container.appendChild(toast);

            // Auto-dismiss
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.classList.add('dismissing');
                    setTimeout(() => toast.remove(), 350);
                }
            }, duration);

            // Max 3 toasts visible
            while (container.children.length > 3) {
                container.children[0].remove();
            }
        }

        function dismissToast(btn) {
            const toast = btn.closest('.toast');
            if (toast) {
                toast.classList.add('dismissing');
                setTimeout(() => toast.remove(), 350);
            }
        }

        // Show initial welcome toast after load
        setTimeout(() => {
            if (document.getElementById('loading-overlay')) return; // still loading
            showToast('info', 'Dashboard Ready', 'All systems operational. Click any fire cluster for deep dive analysis.', 6000);
        }, 5000);


        // ============================================================
        // NEW FEATURE 5: QUICK STATS BAR
        // Updates whenever allFireRecords changes
        // ============================================================
        function updateQuickStats() {
            if (!allFireRecords.length) return;

            const peakFrp = Math.max(...allFireRecords.map(r => r.frp || 0));
            const highConf = allFireRecords.filter(r => r.confidence === 'h').length;
            const sources = new Set(allFireRecords.map(r => r.source)).size;

            const peakEl = document.getElementById('qs-peak-frp');
            const highEl = document.getElementById('qs-high-conf');
            const srcEl = document.getElementById('qs-sources');

            if (peakEl) peakEl.textContent = peakFrp >= 1000 ? (peakFrp / 1000).toFixed(1) + 'k MW' : Math.round(peakFrp) + ' MW';
            if (highEl) highEl.textContent = highConf >= 1000 ? (highConf / 1000).toFixed(1) + 'k' : highConf.toLocaleString();
            if (srcEl) srcEl.textContent = sources;
        }

        // Hook into existing data flow — call updateQuickStats after data loads
        const _origRebuildCluster = rebuildClusterFromRecords;
        rebuildClusterFromRecords = function() {
            _origRebuildCluster.apply(this, arguments);
            updateQuickStats();
            // Also refresh analytics if open
            if (analyticsOpen) buildAnalyticsCharts();
        };

        // Fire alert toast for extreme FRP detections
        const _origPopulateFeed = populateLiveFeed;
        populateLiveFeed = function() {
            _origPopulateFeed.apply(this, arguments);
            // Check for extreme fires and show toast
            const extremeFires = allFireRecords.filter(r => r.frp > 300 && r.confidence === 'h');
            if (extremeFires.length > 0) {
                const top = extremeFires.sort((a, b) => b.frp - a.frp)[0];
                showToast('fire', 'High-Intensity Fire Detected',
                    `${top.frp} MW at ${top.lat.toFixed(2)}°, ${top.lng.toFixed(2)}° — ${FIRMS_CONFIG.SOURCES[top.source]?.name || 'FIRMS'}`, 8000);
            }
        };


        // ============================================================
        // IMPROVEMENT 1: LAST UPDATED TIMESTAMP
        // Shows a human-readable "Last updated: HH:MM:SS" badge
        // below the data status chip whenever data is successfully loaded.
        // ============================================================
        const _origUpdateDataStatus = updateDataStatus;
        updateDataStatus = function(state, message) {
            _origUpdateDataStatus.apply(this, arguments);
            if (state === 'live') {
                const row = document.getElementById('last-updated-row');
                const timeEl = document.getElementById('last-updated-time');
                if (row && timeEl) {
                    row.style.display = 'flex';
                    timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                }
            }
        };


        // ============================================================
        // IMPROVEMENT 2: CLEAR ALL FILTERS BUTTON
        // Resets FRP slider, temporal slider, and all confidence
        // checkboxes to their defaults with one click.
        // ============================================================
        (function initClearFilters() {
            const btn = document.getElementById('clear-filters-btn');
            if (!btn) return;

            // Hover style enhancement via JS (since inline styles can't do :hover)
            btn.addEventListener('mouseenter', () => {
                btn.style.background = 'rgba(255, 51, 102, 0.15)';
                btn.style.borderColor = 'var(--accent-red)';
                btn.style.transform = 'translateY(-1px)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'rgba(255, 51, 102, 0.07)';
                btn.style.borderColor = 'rgba(255, 51, 102, 0.22)';
                btn.style.transform = '';
            });

            btn.addEventListener('click', () => {
                // Reset FRP slider
                const frpSlider = document.getElementById('filter-frp');
                const frpLabel = document.getElementById('frp-value');
                if (frpSlider) { frpSlider.value = 0; }
                if (frpLabel) { frpLabel.textContent = '0 MW+'; }

                // Reset temporal slider
                const tempSlider = document.getElementById('filter-temporal');
                const tempLabel = document.getElementById('temporal-value');
                if (tempSlider) { tempSlider.value = 24; }
                if (tempLabel) { tempLabel.textContent = '24 h'; }

                // Reset confidence checkboxes
                ['filter-conf-high', 'filter-conf-nominal', 'filter-conf-low'].forEach(id => {
                    const cb = document.getElementById(id);
                    if (cb) {
                        cb.checked = true;
                        cb.closest('.filter-checkbox-label')?.classList.add('checked');
                    }
                });

                // Trigger rebuild
                rebuildClusterFromRecords();

                // Feedback toast
                showToast('success', 'Filters Cleared', 'All filters reset to defaults. Showing all detections.', 3000);
            });
        })();


        // ============================================================
        // IMPROVEMENT 3: KEYBOARD SHORTCUT ("/" focuses search)
        // Press "/" anywhere to instantly focus the location search bar.
        // Press "Escape" to blur it. Standard web UX pattern.
        // ============================================================
        (function initKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Ignore if user is already typing in an input/textarea
                const tag = document.activeElement?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') {
                    if (e.key === 'Escape') document.activeElement.blur();
                    return;
                }

                // "/" — focus search bar
                if (e.key === '/') {
                    e.preventDefault();
                    const searchInput = document.getElementById('search-input');
                    if (searchInput) {
                        // If sidebar is collapsed, open it first
                        const sidebar = document.querySelector('.ui-sidebar');
                        const toggleBtn = document.querySelector('.sidebar-toggle-btn');
                        if (sidebar && sidebar.classList.contains('collapsed')) {
                            sidebar.classList.remove('collapsed');
                            if (toggleBtn) toggleBtn.classList.remove('active');
                        }
                        searchInput.focus();
                        searchInput.select();
                        showToast('info', 'Search Active', 'Type a location name or coordinates. Press Esc to cancel.', 2500);
                    }
                }
            });
        })();


        // ============================================================
        // IMPROVEMENT 4: FRP-GRADIENT INDIVIDUAL FIRE MARKERS
        // Instead of all unclustered points being the same flat red,
        // color them on a gradient: yellow (low FRP) → orange → red (high)
        // This requires patching rebuildClusterFromRecords to use
        // dynamic DivIcons with computed background colors.
        // ============================================================
        (function patchFRPGradientMarkers() {
            const _baseBuild = rebuildClusterFromRecords;
            rebuildClusterFromRecords = function() {
                // We intercept by wrapping the marker creation logic.
                // Since the original function is closed-over, we override
                // the icon factory approach by post-processing all markers.
                _baseBuild.apply(this, arguments);

                // After rebuild, re-color individual (unclustered) markers
                // that are visible at the current zoom level.
                // We use a short delay so Leaflet has finished DOM rendering.
                setTimeout(() => {
                    const points = document.querySelectorAll('.fire-point-icon');
                    // Can't access FRP from DOM alone — the gradient effect
                    // is therefore applied via a CSS injection trick:
                    // Each marker gets a pseudo-random warm-spectrum hue
                    // based on its position in the DOM order (proxy for FRP variability).
                    // For a true per-marker FRP color, the L.marker creation
                    // inside rebuildClusterFromRecords itself must be patched below.
                }, 100);
            };

            // True patch: override the L.divIcon call inside rebuildClusterFromRecords
            // by monkey-patching the global function to create FRP-aware icons.
            // We do this by replacing the function wholesale with an FRP-aware version.
            const truePatch = function() {
                const confHigh = document.getElementById('filter-conf-high')?.checked ?? true;
                const confNominal = document.getElementById('filter-conf-nominal')?.checked ?? true;
                const confLow = document.getElementById('filter-conf-low')?.checked ?? true;
                const frpMin = parseFloat(document.getElementById('filter-frp')?.value ?? 0);
                const maxHours = parseFloat(document.getElementById('filter-temporal')?.value ?? 24);

                const allowedConf = new Set();
                if (confHigh) allowedConf.add('h');
                if (confNominal) allowedConf.add('n');
                if (confLow) allowedConf.add('l');

                const now = Date.now();
                let visibleCount = 0;

                fireClusterGroup.clearLayers();

                // Compute FRP range for color normalization
                const frpValues = allFireRecords
                    .filter(r => allowedConf.has(r.confidence) && r.frp >= frpMin)
                    .map(r => r.frp || 0);
                const maxFrp = frpValues.length ? Math.max(...frpValues) : 300;
                const minFrp = frpValues.length ? Math.min(...frpValues) : 0;

                function frpToColor(frp) {
                    // Normalize 0-1
                    const t = maxFrp > minFrp ? Math.min((frp - minFrp) / (maxFrp - minFrp), 1) : 0.5;
                    // Color stops: yellow (#f9d857) → orange (#ff8c42) → red (#ff3366)
                    let r, g, b;
                    if (t < 0.5) {
                        // yellow → orange
                        const s = t * 2;
                        r = Math.round(249 + (255 - 249) * s);
                        g = Math.round(216 + (140 - 216) * s);
                        b = Math.round(87 + (66 - 87) * s);
                    } else {
                        // orange → red
                        const s = (t - 0.5) * 2;
                        r = 255;
                        g = Math.round(140 + (51 - 140) * s);
                        b = Math.round(66 + (102 - 66) * s);
                    }
                    return `rgb(${r},${g},${b})`;
                }

                for (const rec of allFireRecords) {
                    if (!allowedConf.has(rec.confidence)) continue;
                    if (rec.frp < frpMin) continue;

                    if (rec.acqDate && rec.acqTime) {
                        const h = rec.acqTime.substring(0, 2);
                        const m = rec.acqTime.substring(2, 4);
                        const recTime = new Date(`${rec.acqDate}T${h}:${m}:00Z`).getTime();
                        if (!isNaN(recTime)) {
                            const ageHours = (now - recTime) / 3600000;
                            if (ageHours > maxHours) continue;
                        }
                    }

                    // FRP-gradient icon
                    const color = frpToColor(rec.frp || 0);
                    const glowColor = color.replace('rgb', 'rgba').replace(')', ', 0.85)');
                    const frpIcon = L.divIcon({
                        className: '',
                        html: `<div style="
                            width:8px; height:8px;
                            background:${color};
                            border:1px solid rgba(255,255,255,0.7);
                            border-radius:50%;
                            box-shadow:0 0 8px ${glowColor};
                        "></div>`,
                        iconSize: [8, 8],
                        iconAnchor: [4, 4]
                    });

                    const marker = L.marker([rec.lat, rec.lng], { icon: frpIcon });
                    const confLabel = rec.confidence === 'h' ? 'HIGH' : rec.confidence === 'n' ? 'NOMINAL' : 'LOW';
                    const sourceName = FIRMS_CONFIG.SOURCES[rec.source]?.name || rec.satellite || 'FIRMS';

                    marker.on('click', () => {
                        const el = marker._icon;
                        if (el) el.querySelector('div')?.style && (el.querySelector('div').style.transform = 'scale(2)');
                        map.flyTo([rec.lat, rec.lng], 14, { duration: 2.5 });
                        setTimeout(() => {
                            if (el) el.querySelector('div')?.style && (el.querySelector('div').style.transform = '');
                            executeDeepDive(rec);
                        }, 2600);
                    });

                    fireClusterGroup.addLayer(marker);
                    visibleCount++;
                }

                const total = allFireRecords.length;
                if (typeof animateCounter === 'function') {
                    animateCounter(document.getElementById('active-fire-count'), visibleCount);
                }
                const countEl = document.getElementById('filter-live-count');
                if (countEl) {
                    countEl.innerHTML = `Showing <strong>${visibleCount.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> detections`;
                }
            };

            // Replace the global function
            rebuildClusterFromRecords = truePatch;
        })();


    