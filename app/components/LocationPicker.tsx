import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckLocation } from "~/lib/types";
import "leaflet/dist/leaflet.css";
// Leaflet resolves its default marker icon at runtime by reading a CSS rule
// from the page, which breaks under bundled production builds — the marker
// renders as a broken-image box labeled "marker". Import the assets through
// the bundler instead (Vite inlines them as data URIs, so the icons work
// regardless of host or base path).
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

/**
 * Location picker: geocoded place search (OpenStreetMap/Nominatim), "use my
 * location", a click/drag map, and manual coordinates. Used for the iNat
 * search scope and for the deck's own location metadata.
 */

interface GeoResult {
  name: string;
  lat: number;
  lng: number;
}

export async function geocode(query: string): Promise<GeoResult[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", query);
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const json = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>;
  return json.map((r) => ({
    name: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
  }));
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "json");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", "10");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const json = (await res.json()) as { display_name?: string; name?: string };
  return json.name ?? json.display_name ?? null;
}

export function LocationPicker({
  value,
  onChange,
  showRadius = false,
}: {
  value: DeckLocation | undefined;
  onChange: (loc: DeckLocation | undefined) => void;
  showRadius?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const mapRef = useRef<{ map: L.Map; marker: L.Marker } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const loc = value;

  // The map's drag/click handlers are attached once at mount and would
  // otherwise close over that render's value — dragging after picking a
  // place reverts the picked name/radius. The ref keeps them current.
  const locRef = useRef(loc);
  useEffect(() => { locRef.current = loc; }, [loc]);

  // Coordinate/radius fields are edited as text and committed on blur/Enter:
  // parsing per keystroke made "." untypable ("32." snapped back to "32")
  // and an emptied field wrote 0 into the deck's coordinates.
  const [latDraft, setLatDraft] = useState<string | null>(null);
  const [lngDraft, setLngDraft] = useState<string | null>(null);
  const [radiusDraft, setRadiusDraft] = useState<string | null>(null);

  const set = useCallback(
    (next: DeckLocation) => {
      onChange({ radiusKm: showRadius ? (loc?.radiusKm ?? 10) : undefined, ...next });
    },
    [onChange, loc?.radiusKm, showRadius],
  );

  // Debounced geocode as the user types. The cleanup marks in-flight
  // requests stale: a slow response for an earlier query must not overwrite
  // a newer one's results.
  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearchError(null);
      try {
        const found = await geocode(query.trim());
        if (cancelled) return;
        setResults(found);
        setOpen(true);
      } catch {
        if (cancelled) return;
        setSearchError("Place search is unavailable right now — you can still pick on the map or enter coordinates.");
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  // Leaflet map: lazily initialized once the container mounts.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;
      // Pin the bundled icon assets before any marker exists (see the import
      // comment: Leaflet's runtime path detection fails in production builds).
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: markerIcon2x,
        iconUrl: markerIcon,
        shadowUrl: markerShadow,
      });
      const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView(
        [loc?.lat ?? 32.7157, loc?.lng ?? -117.1611],
        loc?.lat != null ? 10 : 5,
      );
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);
      const marker = L.marker([loc?.lat ?? 32.7157, loc?.lng ?? -117.1611], { draggable: true });
      if (loc?.lat != null) marker.addTo(map);
      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        const current = locRef.current;
        onChange({ name: current?.name, lat: pos.lat, lng: pos.lng, radiusKm: current?.radiusKm });
      });
      map.on("click", (e) => {
        marker.setLatLng(e.latlng).addTo(map);
        const current = locRef.current;
        onChange({ name: current?.name, lat: e.latlng.lat, lng: e.latlng.lng, radiusKm: current?.radiusKm });
      });
      mapRef.current = { map, marker };
      if (cancelled) map.remove();
    })().catch(() => {
      setSearchError("The map couldn't load — you can still search for a place or enter coordinates.");
    });
    return () => {
      cancelled = true;
      mapRef.current?.map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in sync when the value changes externally.
  useEffect(() => {
    if (!mapRef.current || loc?.lat == null || loc?.lng == null) return;
    const { map, marker } = mapRef.current;
    marker.setLatLng([loc.lat, loc.lng]);
    map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 9), { animate: false });
  }, [loc?.lat, loc?.lng]);

  const commitCoord = (raw: string | null, kind: "lat" | "lng") => {
    if (raw === null || !loc) return;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const inRange = kind === "lat" ? Math.abs(n) <= 90 : Math.abs(n) <= 180;
    if (inRange) onChange({ ...loc, [kind]: n });
  };

  const commitRadius = (raw: string | null) => {
    if (raw === null) return;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) return;
    onChange({ ...loc, radiusKm: n });
  };

  const setResult = (r: GeoResult) => {
    setOpen(false);
    setQuery("");
    setLatDraft(null);
    setLngDraft(null);
    set({ name: r.name.split(",")[0], lat: r.lat, lng: r.lng });
  };

  const useMyLocation = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => set({ name: "My location", lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setSearchError("Couldn't get your location — pick on the map instead."),
    );
  };

  const clear = () => {
    onChange(undefined);
    setQuery("");
    setLatDraft(null);
    setLngDraft(null);
    setRadiusDraft(null);
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          className="field text-sm"
          placeholder="Search a place or address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          aria-label="Location search"
          data-testid="location-search"
        />
        {open && results.length > 0 && (
          <ul
            className="absolute z-20 left-0 right-0 mt-1 rounded-md border bg-white shadow-lg divide-y max-h-60 overflow-y-auto"
            style={{ borderColor: "var(--border)" }}
            data-testid="location-results"
          >
            {results.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--accent-soft)]"
                  onClick={() => setResult(r)}
                >
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="btn-secondary !py-1 !px-2" onClick={useMyLocation}>
          📍 Use my location
        </button>
        {loc && (
          <>
            <span data-testid="location-status" style={{ color: "var(--muted)" }}>
              {loc.name ? `“${loc.name}”` : ""}
              {loc.lat != null && loc.lng != null && (
                <> {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}</>
              )}
            </span>
            <button type="button" className="underline" style={{ color: "var(--danger)" }} onClick={clear}>
              clear
            </button>
          </>
        )}
        {!loc && <span style={{ color: "var(--muted)" }}>No location set (searches run worldwide).</span>}
      </div>
      {searchError && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {searchError}
        </p>
      )}
      <div
        ref={containerRef}
        className="rounded-md overflow-hidden border"
        style={{ height: 200, borderColor: "var(--border)", cursor: "crosshair" }}
        data-testid="location-map"
      />
      {showRadius && (
        <label className="text-sm inline-flex items-center gap-2">
          Radius (km)
          <input
            className="field !w-24 !py-1 text-sm"
            value={radiusDraft ?? String(loc?.radiusKm ?? 10)}
            inputMode="decimal"
            onChange={(e) => setRadiusDraft(e.target.value)}
            onBlur={() => { commitRadius(radiusDraft); setRadiusDraft(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { commitRadius(radiusDraft); setRadiusDraft(null); } }}
            data-testid="location-radius"
          />
        </label>
      )}
      {loc?.lat != null && loc?.lng != null && (
        <details className="text-xs" style={{ color: "var(--muted)" }}>
          <summary className="cursor-pointer">Exact coordinates</summary>
          <div className="flex gap-2 mt-1">
            <input
              className="field !py-1 text-xs font-mono"
              value={latDraft ?? String(loc.lat)}
              aria-label="Latitude"
              inputMode="decimal"
              onChange={(e) => setLatDraft(e.target.value)}
              onBlur={() => { commitCoord(latDraft, "lat"); setLatDraft(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { commitCoord(latDraft, "lat"); setLatDraft(null); } }}
            />
            <input
              className="field !py-1 text-xs font-mono"
              value={lngDraft ?? String(loc.lng)}
              aria-label="Longitude"
              inputMode="decimal"
              onChange={(e) => setLngDraft(e.target.value)}
              onBlur={() => { commitCoord(lngDraft, "lng"); setLngDraft(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") { commitCoord(lngDraft, "lng"); setLngDraft(null); } }}
            />
          </div>
        </details>
      )}
    </div>
  );
}

// Leaflet types (import type only keeps the bundle out of the main chunk).
type L = typeof import("leaflet");