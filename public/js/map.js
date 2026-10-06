// Kartenansicht mit Leaflet: Stopps, Route, Standort, Entwurfs-Pin
import { TILE_URL, TILE_ATTRIBUTION } from './config.js';
import { PIN_SVG } from './icons.js';

const L = window.L;

function pinIcon(n, { visited, selected, draft }) {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${visited ? 'visited' : ''} ${selected ? 'sel' : ''} ${draft ? 'draft' : ''}">${PIN_SVG}<span>${draft ? '＋' : n}</span></div>`,
    iconSize: [34, 44],
    iconAnchor: [17, 42],
  });
}

export class TripMap {
  constructor(el, { onTap, onLongPress, onMarkerTap, onDraftMove } = {}) {
    this.cb = { onTap, onLongPress, onMarkerTap, onDraftMove };
    this.map = L.map(el, { zoomControl: false, attributionControl: false, zoomSnap: 0.5, wheelPxPerZoomLevel: 90, worldCopyJump: true, minZoom: 2, maxZoom: 18 });
    el.style.position = 'absolute'; // Leaflet setzt sonst „relative“, solange das Element noch nicht im Dokument hängt
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(this.map);
    this.map.setView([50.5, 10.2], 5);
    this.markers = new Map();
    this.dark = window.matchMedia('(prefers-color-scheme: dark)');
    this.applyTiles();
    this.dark.addEventListener?.('change', () => { this.applyTiles(); this.styleRoute(); });
    this.map.on('click', (e) => this.cb.onTap?.(e.latlng));
    this.map.on('contextmenu', (e) => this.cb.onLongPress?.(e.latlng));
    this.casing = L.polyline([], { weight: 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(this.map);
    this.line = L.polyline([], { weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(this.map);
    this.styleRoute();
  }

  applyTiles() {
    // OSM-Standardkacheln (ohne API-Key). Im Dunkelmodus per CSS-Filter abgedunkelt.
    if (!this.tiles) this.tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION, crossOrigin: true, keepBuffer: 3, className: 'osm-tiles' }).addTo(this.map);
    this.map.getContainer().classList.toggle('map-dark', this.dark.matches);
  }

  styleRoute() {
    const dark = this.dark.matches;
    this.casing.setStyle({ color: dark ? '#0e1626' : '#ffffff' });
    this.line.setStyle({ color: dark ? '#ff8a4c' : '#e8590c' });
  }

  invalidate() { this.map.invalidateSize({ animate: false }); }

  setStops(stops, { selectedId } = {}) {
    const seen = new Set();
    stops.forEach((s, i) => {
      seen.add(s.id);
      const opts = { visited: !!s.visited_at, selected: s.id === selectedId };
      const sig = `${i + 1}|${opts.visited}|${opts.selected}`;
      let m = this.markers.get(s.id);
      if (!m) {
        m = L.marker([s.lat, s.lon], { icon: pinIcon(i + 1, opts), keyboard: false, title: s.name, riseOnHover: true });
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          // Beim Setzen eines neuen Pins zählt ein Tipp auf einen vorhandenen Marker wie ein Tipp auf die Karte
          if (this.cb.onMarkerTap?.(s.id) === false) this.cb.onTap?.(this.map.mouseEventToLatLng(e.originalEvent));
        });
        m.addTo(this.map);
        this.markers.set(s.id, m);
        m._sig = sig;
      } else {
        const ll = m.getLatLng();
        if (ll.lat !== s.lat || ll.lng !== s.lon) m.setLatLng([s.lat, s.lon]);
        if (m._sig !== sig) { m.setIcon(pinIcon(i + 1, opts)); m._sig = sig; }
      }
      m.setZIndexOffset(opts.selected ? 1000 : i);
    });
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) { m.remove(); this.markers.delete(id); }
    }
  }

  setRoute(latlngs) {
    this.casing.setLatLngs(latlngs);
    this.line.setLatLngs(latlngs);
  }

  // bottomPad: verdeckter Bereich unten (Dock), topPad: Bedienelemente oben
  fit(stops, { bottomPad = 120, topPad = 110, animate = true } = {}) {
    const pts = stops.map((s) => [s.lat, s.lon]);
    if (!pts.length) return;
    if (pts.length === 1) { this.flyTo(pts[0][0], pts[0][1], { zoom: 11, bottomPad, animate }); return; }
    this.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [28, topPad], paddingBottomRight: [28, bottomPad + 20], animate, maxZoom: 13 });
  }

  flyTo(lat, lon, { zoom, bottomPad = 120, animate = true } = {}) {
    const z = zoom ?? Math.max(this.map.getZoom(), 10);
    const size = this.map.getSize();
    // Zielpunkt in den sichtbaren Bereich (oberhalb des Docks) schieben
    const target = this.map.project([lat, lon], z).add([0, bottomPad / 2]);
    const center = this.map.unproject(target, z);
    if (animate) this.map.flyTo(center, z, { duration: 0.7 }); else this.map.setView(center, z, { animate: false });
    void size;
  }

  setDraft(latlng, { draggable = true } = {}) {
    if (!latlng) { this.draft?.remove(); this.draft = null; return; }
    if (!this.draft) {
      this.draft = L.marker(latlng, { icon: pinIcon(0, { draft: true }), draggable, zIndexOffset: 2000, keyboard: false }).addTo(this.map);
      this.draft.on('dragend', () => this.cb.onDraftMove?.(this.draft.getLatLng()));
    } else {
      this.draft.setLatLng(latlng);
    }
  }

  setMe(latlng) {
    if (!latlng) { this.me?.remove(); this.me = null; return; }
    if (!this.me) {
      this.me = L.marker(latlng, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, zIndexOffset: 3000, keyboard: false }).addTo(this.map);
    } else {
      this.me.setLatLng(latlng);
    }
  }

  center() { const c = this.map.getCenter(); return { lat: c.lat, lon: c.lng }; }
  zoom() { return this.map.getZoom(); }
  destroy() { this.map.remove(); this.markers.clear(); }
}
