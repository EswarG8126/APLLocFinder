/* ═══════════════════════════════════════════════════════════
   script.js  –  Austin Public Library Finder
   ─────────────────────────────────────────────────────────
   Responsibilities:
     1. Load & parse libraries.json (Socrata export format)
     2. Initialise Google Maps and place markers
     3. Handle address + radius search:
          • Geocode the address via Google Geocoding API
          • Draw a radius circle on the map
          • Filter libraries with the Haversine formula
          • Highlight in-radius markers (bounce + colour change)
          • Populate the sidebar list
     4. Sidebar: toggle collapse, clickable cards
═══════════════════════════════════════════════════════════ */

'use strict';

/* ── Constants ──────────────────────────────────────────── */
const AUSTIN_CENTER   = { lat: 30.2672, lng: -97.7431 };
const DEFAULT_ZOOM    = 12;
const EARTH_RADIUS_MI = 3958.8;   // mean Earth radius in miles
const TOLERANCE_MI    = 0.50;     // extra buffer added to search radius

/* Icon URLs (Google Charts – works without extra API quota) */
const ICON_DEFAULT    = 'https://maps.google.com/mapfiles/ms/icons/red-dot.png';
const ICON_HIGHLIGHT  = 'https://maps.google.com/mapfiles/ms/icons/orange-dot.png';

/* ── Module-level state ─────────────────────────────────── */
let map;                  // google.maps.Map instance
let geocoder;             // google.maps.Geocoder instance
let infoWindow;           // shared InfoWindow (one at a time)
let allMarkers    = [];   // { marker, library } for every library
let searchCircle  = null; // current google.maps.Circle
let libraries     = [];   // parsed library objects

/* ── DOM references ─────────────────────────────────────── */
const mapLoader          = document.getElementById('mapLoader');
const searchForm         = document.getElementById('searchForm');
const addressInput       = document.getElementById('addressInput');
const radiusInput        = document.getElementById('radiusInput');
const searchBtn          = document.getElementById('searchBtn');
const clearBtn           = document.getElementById('clearBtn');
const searchMessage      = document.getElementById('searchMessage');
const libraryList        = document.getElementById('libraryList');
const listSummary        = document.getElementById('listSummary');
const sidebar            = document.getElementById('sidebar');
const sidebarToggle      = document.getElementById('sidebarToggle');
const sidebarToggleLabel = document.getElementById('sidebarToggleLabel');
const toleranceToggle    = document.getElementById('toleranceToggle');


/* ══════════════════════════════════════════════════════════
   1.  GOOGLE MAPS CALLBACK  (called by Maps API script tag)
══════════════════════════════════════════════════════════ */
function initMap() {
  /* Create the map centred on downtown Austin */
  map = new google.maps.Map(document.getElementById('map'), {
    center:            AUSTIN_CENTER,
    zoom:              DEFAULT_ZOOM,
    mapTypeControl:    false,
    streetViewControl: false,
    fullscreenControl: true,
    zoomControlOptions: {
      position: google.maps.ControlPosition.RIGHT_CENTER,
    },
    styles: [
      /* Subtle style: de-emphasise POIs so library markers stand out */
      { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', stylers: [{ visibility: 'simplified' }] },
    ],
  });

  geocoder  = new google.maps.Geocoder();
  infoWindow = new google.maps.InfoWindow();

  /* Hide the loading overlay once the map tiles are ready */
  google.maps.event.addListenerOnce(map, 'tilesloaded', () => {
    mapLoader.classList.add('hidden');
  });

  /* Load the library data then place markers */
  loadLibraries();
}

/* ══════════════════════════════════════════════════════════
   2.  DATA LOADING & PARSING
══════════════════════════════════════════════════════════ */

/**
 * Fetch libraries.json asynchronously, parse the Socrata export
 * format, then trigger marker placement.
 *
 * Socrata row layout (after the 8 hidden meta columns):
 *   [8]  term_id  – [website_url, description]
 *   [9]  name     – string
 *   [10] address  – [addressJSON, lat, lng, null, bool]
 *   [11] lat/lng  – "(lat, lng)" string (backup)
 *   [12] phone    – string
 *   [13] district – number
 *   [14] wifi     – "Yes" | "No"
 *   [15] computers – number
 */
async function loadLibraries() {
  try {
    const response = await fetch('libraries.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = await response.json();
    libraries  = parseLibraries(json);

    addMarkersToMap();
    renderLibraryList(libraries, null);  // show all libraries initially
    updateListSummary(libraries.length, null);

  } catch (err) {
    console.error('Failed to load libraries.json:', err);
    showMessage(`Could not load library data: ${err.message}`, 'error');
  }
}

/**
 * Parse a Socrata JSON export into a clean array of library objects.
 * @param  {Object} json  – parsed JSON from libraries.json
 * @returns {Array}       – array of library objects
 */
function parseLibraries(json) {
  const rows = json.data || [];

  return rows.map((row, idx) => {
    /* ── Website (term_id, index 8) ── */
    const termId  = Array.isArray(row[8]) ? row[8] : [];
    const website = termId[0] || null;

    /* ── Name (index 9) ── */
    const name = row[9] || `Library ${idx + 1}`;

    /* ── Address & coordinates (index 10) ── */
    let street = '', city = 'Austin', state = 'TX', zip = '';
    let lat = null, lng = null;

    if (Array.isArray(row[10])) {
      /* Address JSON string */
      if (row[10][0]) {
        try {
          const addr = JSON.parse(row[10][0]);
          street = addr.address || '';
          city   = addr.city   || 'Austin';
          state  = addr.state  || 'TX';
          zip    = addr.zip    || '';
        } catch (_) { /* ignore malformed JSON */ }
      }
      /* Latitude / longitude */
      lat = parseFloat(row[10][1]);
      lng = parseFloat(row[10][2]);
    }

    /* Fallback: parse the "(lat, lng)" text field (index 11) */
    if ((isNaN(lat) || isNaN(lng)) && typeof row[11] === 'string') {
      const match = row[11].match(/\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        lat = parseFloat(match[1]);
        lng = parseFloat(match[2]);
      }
    }

    /* ── Phone (index 12) ── */
    const phone = row[12] || '';

    /* ── Amenities (indices 13–15) ── */
    const district  = row[13] || '';
    const wifi      = row[14] || '';
    const computers = row[15] != null ? row[15] : '';

    /* Build full address string */
    const addressFull = [street, city, state, zip].filter(Boolean).join(', ');

    return { name, street, city, state, zip, addressFull, lat, lng,
             phone, website, district, wifi, computers };
  }).filter(lib => !isNaN(lib.lat) && !isNaN(lib.lng));  // drop rows with no coords
}

/* ══════════════════════════════════════════════════════════
   3.  MARKERS
══════════════════════════════════════════════════════════ */

/**
 * Place a marker on the map for every library.
 * Markers are stored in `allMarkers` so they can be
 * highlighted / reset later.
 */
function addMarkersToMap() {
  allMarkers.forEach(({ marker }) => marker.setMap(null));  // clear old
  allMarkers = [];

  libraries.forEach((lib, idx) => {
    const marker = new google.maps.Marker({
      position: { lat: lib.lat, lng: lib.lng },
      map,
      title: lib.name,
      icon:  ICON_DEFAULT,
      animation: null,
    });

    /* Open InfoWindow when marker is clicked */
    marker.addListener('click', () => {
      openInfoWindow(marker, lib);
      highlightCard(idx);
    });

    allMarkers.push({ marker, library: lib, index: idx });
  });
}

/**
 * Build and open the InfoWindow for a library marker.
 */
function openInfoWindow(marker, lib) {
  const websiteHtml = lib.website
    ? `<a href="${escapeHtml(lib.website)}" target="_blank" rel="noopener" class="iw-link">Visit website →</a>`
    : 'N/A';

  const content = `
    <div class="iw-body">
      <div class="iw-title">${escapeHtml(lib.name)}</div>
      <div class="iw-row">
        <span class="iw-label">Address:</span>
        <span>${escapeHtml(lib.addressFull)}</span>
      </div>
      <div class="iw-row">
        <span class="iw-label">Phone:</span>
        <span>${escapeHtml(lib.phone || 'N/A')}</span>
      </div>
      <div class="iw-row">
        <span class="iw-label">Wi-Fi:</span>
        <span>${escapeHtml(lib.wifi || 'N/A')}</span>
      </div>
      <div class="iw-row">
        <span class="iw-label">Computers:</span>
        <span>${lib.computers !== '' ? lib.computers : 'N/A'}</span>
      </div>
      <div class="iw-row" style="margin-top:8px">
        ${websiteHtml}
      </div>
    </div>`;

  infoWindow.setContent(content);
  infoWindow.open(map, marker);
}

/**
 * Reset ALL markers to the default red icon and stop animations.
 */
function resetAllMarkers() {
  allMarkers.forEach(({ marker }) => {
    marker.setIcon(ICON_DEFAULT);
    marker.setAnimation(null);
  });
}

/**
 * Highlight markers whose library index is in `highlightedIndices`.
 * @param {Set<number>} highlightedIndices
 */
function highlightMarkers(highlightedIndices) {
  allMarkers.forEach(({ marker, index }) => {
    if (highlightedIndices.has(index)) {
      marker.setIcon(ICON_HIGHLIGHT);
      marker.setAnimation(google.maps.Animation.BOUNCE);
      /* Stop bouncing after 1.5 s so it doesn't become annoying */
      setTimeout(() => marker.setAnimation(null), 1500);
    } else {
      marker.setIcon(ICON_DEFAULT);
      marker.setAnimation(null);
    }
  });
}

/* ══════════════════════════════════════════════════════════
   4.  SEARCH  –  geocode → filter → circle → highlight
══════════════════════════════════════════════════════════ */

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const address    = addressInput.value.trim();
  const radiusMiles = parseFloat(radiusInput.value);

  /* ── Basic validation ── */
  if (!address) {
    showMessage('Please enter an address to search.', 'error');
    addressInput.focus();
    return;
  }
  if (isNaN(radiusMiles) || radiusMiles <= 0) {
    showMessage('Please enter a valid radius (e.g. 2).', 'error');
    radiusInput.focus();
    return;
  }

  /* ── Show loading state ── */
  setSearchLoading(true);
  showMessage('Geocoding address…', 'info');

  try {
    /* ── Step 1: Geocode the typed address ── */
    const geoResult = await geocodeAddress(address);

    /* ── Step 2: Draw (or update) the circle ── */
    const radiusMeters = milesToMeters(radiusMiles);
    drawCircle(geoResult.location, radiusMeters);

    /* ── Step 3: Filter libraries using Haversine ── */
    const effectiveRadius = radiusMiles + (toleranceToggle.checked ? TOLERANCE_MI : 0);
    const results = filterLibrariesInRadius(
      geoResult.location.lat(),
      geoResult.location.lng(),
      effectiveRadius
    );

    /* ── Step 4: Update markers ── */
    const highlightedIndices = new Set(results.map(r => r.index));
    highlightMarkers(highlightedIndices);

    /* ── Step 5: Pan map to fit circle + markers ── */
    fitMapToCircle(geoResult.location, radiusMeters, results);

    /* ── Step 6: Render the filtered list ── */
    renderLibraryList(results.map(r => r.library), results.map(r => r.distance));
    updateListSummary(results.length, radiusMiles, geoResult.formattedAddress);

    if (results.length === 0) {
      showMessage(
        `No libraries found within ${radiusMiles} mile${radiusMiles !== 1 ? 's' : ''} of that address. Try a larger radius.`,
        'error'
      );
    } else {
      showMessage(
        `Found ${results.length} librar${results.length !== 1 ? 'ies' : 'y'} within ${radiusMiles} mile${radiusMiles !== 1 ? 's' : ''}.`,
        'success'
      );
    }

  } catch (err) {
    /* Geocoding failure or network error */
    showMessage(err.message || 'An unexpected error occurred.', 'error');
    console.error('Search error:', err);
  } finally {
    setSearchLoading(false);
  }
});

/* Clear button: reset everything to initial state */
clearBtn.addEventListener('click', () => {
  clearSearch();
});

/**
 * Geocode an address string using the Google Geocoding API.
 * Returns a promise resolving to { location: LatLng, formattedAddress }.
 * Rejects with a human-friendly Error on failure.
 */
function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    geocoder.geocode(
      { address, bounds: map.getBounds(), region: 'us' },
      (results, status) => {
        if (status === google.maps.GeocoderStatus.OK && results.length > 0) {
          resolve({
            location:         results[0].geometry.location,
            formattedAddress: results[0].formatted_address,
          });
        } else if (status === google.maps.GeocoderStatus.ZERO_RESULTS) {
          reject(new Error('Address not found. Please try a more specific address.'));
        } else if (status === google.maps.GeocoderStatus.OVER_QUERY_LIMIT) {
          reject(new Error('Too many requests. Please wait a moment and try again.'));
        } else {
          reject(new Error(`Geocoding failed (${status}). Check your API key or try again.`));
        }
      }
    );
  });
}

/**
 * Draw (or update) a semi-transparent circle on the map.
 * @param {google.maps.LatLng} center
 * @param {number} radiusMeters
 */
function drawCircle(center, radiusMeters) {
  if (searchCircle) {
    /* Update existing circle */
    searchCircle.setCenter(center);
    searchCircle.setRadius(radiusMeters);
  } else {
    searchCircle = new google.maps.Circle({
      map,
      center,
      radius:        radiusMeters,
      strokeColor:   '#1a4f8a',
      strokeOpacity: 0.8,
      strokeWeight:  2,
      fillColor:     '#1a4f8a',
      fillOpacity:   0.10,
    });
  }
}

/**
 * Remove the search circle from the map.
 */
function clearCircle() {
  if (searchCircle) {
    searchCircle.setMap(null);
    searchCircle = null;
  }
}

/**
 * Filter `libraries` array returning those within `radiusMiles`.
 * Uses the Haversine formula for accurate great-circle distance.
 * @param  {number} originLat
 * @param  {number} originLng
 * @param  {number} radiusMiles  – inclusive upper bound
 * @returns {Array<{library, index, distance}>}  sorted by distance
 */
function filterLibrariesInRadius(originLat, originLng, radiusMiles) {
  const results = [];

  libraries.forEach((lib, index) => {
    const dist = haversineDistance(originLat, originLng, lib.lat, lib.lng);
    if (dist <= radiusMiles) {
      results.push({ library: lib, index, distance: dist });
    }
  });

  /* Sort nearest first */
  results.sort((a, b) => a.distance - b.distance);
  return results;
}

/**
 * Haversine formula: returns the great-circle distance in miles
 * between two lat/lng points.
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.asin(Math.sqrt(a));
}

/** Convert miles to metres (for Google Maps Circle radius). */
function milesToMeters(miles) {
  return miles * 1609.344;
}

/**
 * Pan and zoom the map so the circle and all highlighted markers
 * are visible.
 */
function fitMapToCircle(circleCenter, radiusMeters, results) {
  if (!searchCircle) return;

  const bounds = searchCircle.getBounds();

  /* Extend bounds to include any highlighted markers */
  results.forEach(({ library }) => {
    bounds.extend(new google.maps.LatLng(library.lat, library.lng));
  });

  map.fitBounds(bounds, /* padding px */ 40);
}

/**
 * Reset the page to its initial "show all" state.
 */
function clearSearch() {
  clearCircle();
  resetAllMarkers();
  infoWindow.close();
  renderLibraryList(libraries, null);
  updateListSummary(libraries.length, null);
  clearMessage();
  addressInput.value = '';
  map.setCenter(AUSTIN_CENTER);
  map.setZoom(DEFAULT_ZOOM);
}

/* ══════════════════════════════════════════════════════════
   5.  SIDEBAR  –  list rendering + interactions
══════════════════════════════════════════════════════════ */

/**
 * Render library cards in the sidebar.
 * @param {Array}       libsToShow  – library objects to display
 * @param {Array|null}  distances   – parallel array of distances in miles,
 *                                    or null if no search was performed
 */
function renderLibraryList(libsToShow, distances) {
  libraryList.innerHTML = '';   // clear previous

  if (libsToShow.length === 0) {
    libraryList.innerHTML = `
      <li class="no-results">
        <p>No libraries match your search.<br>Try a larger radius.</p>
      </li>`;
    return;
  }

  libsToShow.forEach((lib, i) => {
    const li          = document.createElement('li');
    const isFiltered  = distances !== null;         // search was performed
    const distText    = distances ? `${distances[i].toFixed(2)} mi away` : '';
    const markerIndex = allMarkers.findIndex(m => m.library === lib);

    li.className = `library-card${isFiltered ? ' highlighted' : ''}`;
    li.setAttribute('role', 'listitem');
    li.setAttribute('tabindex', '0');
    li.dataset.index = markerIndex;

    /* Build card inner HTML */
    li.innerHTML = `
      ${isFiltered ? '<span class="card-badge">In Range</span>' : ''}
      <div class="card-name">${escapeHtml(lib.name)}</div>
      <div class="card-meta">
        <div class="card-meta-row">
          ${iconSvg('map-pin')}
          <span>${escapeHtml(lib.addressFull)}</span>
        </div>
        <div class="card-meta-row">
          ${iconSvg('phone')}
          <span>${escapeHtml(lib.phone || 'N/A')}</span>
        </div>
        <div class="card-meta-row">
          ${iconSvg('wifi')}
          <span>Wi-Fi: ${escapeHtml(lib.wifi || 'N/A')}
            ${lib.computers !== '' ? ` · ${lib.computers} public computers` : ''}
          </span>
        </div>
      </div>
      ${lib.website ? `<a href="${escapeHtml(lib.website)}" target="_blank" rel="noopener" class="card-link" title="Visit ${escapeHtml(lib.name)} website">Visit website →</a>` : ''}
      ${distText ? `<div class="card-distance">📍 ${distText}</div>` : ''}
    `;

    /* Click/Enter: centre map on this library and open its InfoWindow */
    const activate = () => {
      if (markerIndex === -1) return;
      const { marker, library } = allMarkers[markerIndex];
      map.panTo({ lat: library.lat, lng: library.lng });
      map.setZoom(15);
      openInfoWindow(marker, library);
      /* Briefly bounce the corresponding marker */
      marker.setAnimation(google.maps.Animation.BOUNCE);
      setTimeout(() => marker.setAnimation(null), 1200);
    };

    li.addEventListener('click', (e) => {
      /* Don't trigger card click when the website link is clicked */
      if (e.target.closest('.card-link')) return;
      activate();
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });

    libraryList.appendChild(li);
  });
}

/**
 * Scroll the sidebar so the card at `cardIndex` is visible.
 * Called when a map marker is clicked.
 */
function highlightCard(markerIndex) {
  const card = libraryList.querySelector(`[data-index="${markerIndex}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/** Update the "Showing X libraries" summary text. */
function updateListSummary(count, radiusMiles, address) {
  if (radiusMiles && address) {
    listSummary.textContent =
      `${count} librar${count !== 1 ? 'ies' : 'y'} within ${radiusMiles} mi of "${address}"`;
  } else {
    listSummary.textContent = `All ${count} Austin Public Librar${count !== 1 ? 'ies' : 'y'}`;
  }
}

/* ── Sidebar collapse toggle ──────────────────────────── */
sidebarToggle.addEventListener('click', () => {
  const isCollapsed = sidebar.classList.toggle('collapsed');
  sidebarToggle.setAttribute('aria-expanded', String(!isCollapsed));
  sidebarToggleLabel.textContent = isCollapsed ? 'Show list' : 'Hide list';
});

/* ══════════════════════════════════════════════════════════
   6.  UTILITY HELPERS
══════════════════════════════════════════════════════════ */

/**
 * Show a feedback message below the search form.
 * @param {string} text    – message text
 * @param {'info'|'success'|'error'} type
 */
function showMessage(text, type = 'info') {
  searchMessage.textContent = text;
  searchMessage.className   = `search-message ${type}`;
}

function clearMessage() {
  searchMessage.textContent = '';
  searchMessage.className   = 'search-message';
}

/**
 * Enable/disable the search button and show a loading indicator.
 */
function setSearchLoading(isLoading) {
  searchBtn.disabled = isLoading;
  searchBtn.querySelector('span') &&
    (searchBtn.querySelector('span').textContent = isLoading ? 'Searching…' : 'Search');
}

/** Escape HTML special characters to prevent XSS. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Returns a small inline SVG icon by name.
 * Icons: map-pin, phone, wifi
 */
function iconSvg(name) {
  const icons = {
    'map-pin': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>`,
    'phone':   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07
                    A19.5 19.5 0 0 1 4.15 12 19.79 19.79 0 0 1 1.09 3.36a2 2 0 0 1 1.99-2.18h3a2
                    2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0
                    0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21
                    15.92z"/>
                </svg>`,
    'wifi':    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
                  <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                  <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                  <line x1="12" y1="20" x2="12.01" y2="20"/>
                </svg>`,
  };
  return icons[name] || '';
}
