/* MediPin app logic
 * Data sources (no API key required):
 *  - Nominatim (OpenStreetMap) -> converts PIN code to lat/lon
 *  - Overpass API (OpenStreetMap) -> finds hospitals near that lat/lon
 * Both are free public OSM services. Please respect their usage policies
 * (Nominatim: max ~1 request/sec, must send a valid User-Agent/Referer).
 */

const RESULT_LIMIT = 3;               // how many hospitals to show (matches website)
const SEARCH_RADIUS_STEPS = [8000, 15000, 30000, 60000]; // meters, expands if nothing found
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const els = {
  form: document.getElementById("searchForm"),
  input: document.getElementById("pincodeInput"),
  btn: document.getElementById("searchBtn"),
  status: document.getElementById("statusBox"),
  results: document.getElementById("resultsPanel"),
  favorites: document.getElementById("favoritesPanel"),
  tabs: document.querySelectorAll(".tab"),
  themeToggle: document.getElementById("themeToggle"),
};

/* ---------------- Theme ---------------- */
function initTheme() {
  const saved = localStorage.getItem("medipin_theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  els.themeToggle.textContent = saved === "dark" ? "☀️" : "🌙";
}
els.themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("medipin_theme", next);
  els.themeToggle.textContent = next === "dark" ? "☀️" : "🌙";
});

/* ---------------- Tabs ---------------- */
els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    if (tab.dataset.tab === "results") {
      els.results.classList.remove("hidden");
      els.favorites.classList.add("hidden");
    } else {
      els.favorites.classList.remove("hidden");
      els.results.classList.add("hidden");
      renderFavorites();
    }
  });
});

/* ---------------- Status helper ---------------- */
function setStatus(msg, isError = false) {
  if (!msg) {
    els.status.classList.add("hidden");
    return;
  }
  els.status.textContent = msg;
  els.status.classList.remove("hidden");
  els.status.classList.toggle("error", isError);
}

/* ---------------- Distance (Haversine) ---------------- */
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------------- Geocode PIN code (India only) ---------------- */
async function geocodePincode(pincode) {
  const url = `${NOMINATIM_URL}?postalcode=${pincode}&country=India&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error("geocode_failed");
  const data = await res.json();
  if (!data || data.length === 0) throw new Error("pincode_not_found");
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

/* ---------------- Fetch hospitals from Overpass, expanding radius ---------------- */
async function fetchHospitals(lat, lon) {
  for (const radius of SEARCH_RADIUS_STEPS) {
    const query = `
      [out:json][timeout:25];
      (
        node["amenity"="hospital"](around:${radius},${lat},${lon});
        way["amenity"="hospital"](around:${radius},${lat},${lon});
      );
      out center tags;
    `;
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
    if (!res.ok) continue;
    const data = await res.json();
    const hospitals = (data.elements || [])
      .map((el) => {
        const elLat = el.lat ?? el.center?.lat;
        const elLon = el.lon ?? el.center?.lon;
        if (!elLat || !elLon || !el.tags?.name) return null;
        return {
          id: el.id,
          name: el.tags.name,
          address: buildAddress(el.tags),
          phone: el.tags.phone || el.tags["contact:phone"] || null,
          lat: elLat,
          lon: elLon,
          distance: distanceKm(lat, lon, elLat, elLon),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    if (hospitals.length > 0) return hospitals.slice(0, RESULT_LIMIT);
  }
  return [];
}

function buildAddress(tags) {
  const parts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"] || tags["addr:neighbourhood"],
    tags["addr:city"],
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Address not available";
}

/* ---------------- Cache (offline support) ---------------- */
function cacheResults(pincode, hospitals) {
  localStorage.setItem(
    "medipin_last_search",
    JSON.stringify({ pincode, hospitals, ts: Date.now() })
  );
}
function getCachedResults(pincode) {
  const raw = localStorage.getItem("medipin_last_search");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.pincode === pincode) return parsed.hospitals;
  } catch (e) {}
  return null;
}

/* ---------------- Favorites ---------------- */
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem("medipin_favorites") || "[]");
  } catch (e) {
    return [];
  }
}
function saveFavorites(list) {
  localStorage.setItem("medipin_favorites", JSON.stringify(list));
}
function isFavorite(id) {
  return getFavorites().some((h) => h.id === id);
}
function toggleFavorite(hospital) {
  const list = getFavorites();
  const idx = list.findIndex((h) => h.id === hospital.id);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(hospital);
  }
  saveFavorites(list);
}

/* ---------------- Rendering ---------------- */
function hospitalCard(h) {
  const fav = isFavorite(h.id);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lon}`;
  return `
    <div class="hospital-card" data-id="${h.id}">
      <div class="row-top">
        <div>
          <h3>${escapeHtml(h.name)}</h3>
          <p class="addr">${escapeHtml(h.address)}</p>
        </div>
        <div style="text-align:right;">
          <div class="distance">${h.distance.toFixed(1)} km</div>
          <button class="fav-btn" data-action="fav" title="Save to favorites">${
            fav ? "★" : "☆"
          }</button>
        </div>
      </div>
      <div class="card-actions">
        <a class="primary" href="${mapsUrl}" target="_blank" rel="noopener">🧭 Directions</a>
        ${
          h.phone
            ? `<a href="tel:${h.phone}">📞 Call</a>`
            : `<button disabled>No phone listed</button>`
        }
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderResults(hospitals, fromCache = false) {
  if (!hospitals || hospitals.length === 0) {
    els.results.innerHTML = `<div class="empty-state">No hospitals found for this PIN code. Try a nearby PIN code.</div>`;
    return;
  }
  els.results.innerHTML = hospitals.map(hospitalCard).join("");
  attachCardHandlers(hospitals);
  if (fromCache) setStatus("Showing cached results (offline).");
}

function renderFavorites() {
  const list = getFavorites();
  if (list.length === 0) {
    els.favorites.innerHTML = `<div class="empty-state">No favorites yet. Tap ☆ on a hospital to save it.</div>`;
    return;
  }
  els.favorites.innerHTML = list.map(hospitalCard).join("");
  attachCardHandlers(list);
}

function attachCardHandlers(hospitals) {
  document.querySelectorAll('[data-action="fav"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const card = e.target.closest(".hospital-card");
      const id = Number(card.dataset.id) || card.dataset.id;
      const hospital = hospitals.find((h) => String(h.id) === String(id));
      if (hospital) {
        toggleFavorite(hospital);
        e.target.textContent = isFavorite(hospital.id) ? "★" : "☆";
      }
    });
  });
}

/* ---------------- Search flow ---------------- */
els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pincode = els.input.value.trim();
  if (!/^\d{6}$/.test(pincode)) {
    setStatus("Please enter a valid 6-digit Indian PIN code.", true);
    return;
  }

  els.btn.disabled = true;
  setStatus("Searching for hospitals near " + pincode + "…");
  els.results.innerHTML = "";

  try {
    const { lat, lon } = await geocodePincode(pincode);
    const hospitals = await fetchHospitals(lat, lon);
    cacheResults(pincode, hospitals);
    renderResults(hospitals);
    setStatus("");
  } catch (err) {
    const cached = getCachedResults(pincode);
    if (cached) {
      renderResults(cached, true);
    } else if (err.message === "pincode_not_found") {
      setStatus("This PIN code could not be found. Please check and try again.", true);
    } else {
      setStatus("Network error. Check your internet connection and try again.", true);
    }
  } finally {
    els.btn.disabled = false;
  }
});

/* ---------------- AdMob (native only, via Capacitor plugin) ----------------
 * This block only runs when the app is built with Capacitor and the
 * @capacitor-community/admob plugin is installed — see README.md for setup.
 * In a plain browser/preview it silently does nothing.
 */
async function initAdMob() {
  if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.AdMob) {
    return; // not running inside the native app build
  }
  try {
    const { AdMob } = window.Capacitor.Plugins;
    await AdMob.initialize({
      initializeForTesting: false,
    });
    await AdMob.showBanner({
      adId: "ca-app-pub-6989539634494384/6612985660", // <-- replace with your real AdMob banner unit ID
      adSize: "ADAPTIVE_BANNER",
      position: "BOTTOM_CENTER",
      margin: 0,
    });
  } catch (e) {
    console.warn("AdMob init skipped:", e);
  }
}

/* ---------------- Init ---------------- */
initTheme();
initAdMob();
