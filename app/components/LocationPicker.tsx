import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckLocation } from "~/lib/types";
import "leaflet/dist/leaflet.css";

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

  const set = useCallback(
    (next: DeckLocation) => {
      onChange({ radiusKm: showRadius ? (loc?.radiusKm ?? 10) : undefined, ...next });
    },
    [onChange, loc?.radiusKm, showRadius],
  );

  // Debounced geocode as the user types.
  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearchError(null);
      try {
        setResults(await geocode(query.trim()));
        setOpen(true);
      } catch {
        setSearchError("Place search is unavailable right now — you can still pick on the map or enter coordinates.");
      }
    }, 600);
    return () => clearTimeout(t);
  }, [query]);

  // Leaflet map: lazily initialized once the container mounts.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;
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
        onChange({ name: loc?.name, lat: pos.lat, lng: pos.lng, radiusKm: loc?.radiusKm });
      });
      map.on("click", (e) => {
        marker.setLatLng(e.latlng).addTo(map);
        onChange({ name: loc?.name, lat: e.latlng.lat, lng: e.latlng.lng, radiusKm: loc?.radiusKm });
      });
      mapRef.current = { map, marker };
      if (cancelled) map.remove();
    })();
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

  const setResult = (r: GeoResult) => {
    setOpen(false);
    setQuery("");
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
            value={loc?.radiusKm ?? "10"}
            inputMode="decimal"
            onChange={(e) => onChange({ ...loc, radiusKm: Number(e.target.value) || 10 })}
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
              value={loc.lat}
              aria-label="Latitude"
              onChange={(e) => onChange({ ...loc, lat: Number(e.target.value) })}
            />
            <input
              className="field !py-1 text-xs font-mono"
              value={loc.lng}
              aria-label="Longitude"
              onChange={(e) => onChange({ ...loc, lng: Number(e.target.value) })}
            />
          </div>
        </details>
      )}
    </div>
  );
}

// Leaflet types (import type only keeps the bundle out of the main chunk).
type L = typeof import("leaflet");