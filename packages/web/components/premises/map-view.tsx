"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Map, { Source, Layer, Popup } from "react-map-gl";
import type { MapRef, ViewStateChangeEvent } from "react-map-gl";
import Supercluster from "supercluster";
import "mapbox-gl/dist/mapbox-gl.css";

import { apiClient } from "@/lib/api-client";
import { useTheme } from "@/lib/theme-provider";
import { MapPopup } from "./map-popup";
import { MapLegend } from "./map-legend";
import { MapFilters } from "./map-filters";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const PIN_COLORS: Record<string, string> = {
  RESIDENTIAL: "#3b82f6",
  COMMERCIAL: "#f59e0b",
  INDUSTRIAL: "#a78bfa",
  CONDEMNED: "#fb7185",
};

interface PremiseFeatureProperties {
  id: string;
  premiseType: string;
  status: string;
  commodityIds: string[];
  address: string;
}

interface GeoFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: PremiseFeatureProperties;
}

interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

interface PopupInfo {
  longitude: number;
  latitude: number;
  properties: PremiseFeatureProperties;
}

interface ViewportState {
  longitude: number;
  latitude: number;
  zoom: number;
}

interface MapViewProps {
  onPremiseClick?: (id: string) => void;
}

const ALL_TYPES = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "CONDEMNED"];

export function MapView({ onPremiseClick }: MapViewProps) {
  const { mode } = useTheme();
  const mapRef = useRef<MapRef>(null);

  const [geoData, setGeoData] = useState<GeoFeatureCollection | null>(null);
  const [activeTypes, setActiveTypes] = useState<string[]>(ALL_TYPES);
  const [popupInfo, setPopupInfo] = useState<PopupInfo | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    longitude: -98.5795,
    latitude: 39.8283,
    zoom: 4,
  });
  const [bounds, setBounds] = useState<[number, number, number, number]>([-180, -85, 180, 85]);

  // Derive effective theme (system → actual dark/light)
  const effectiveMode = useMemo(() => {
    if (mode === "system") {
      if (typeof window !== "undefined") {
        return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      return "dark";
    }
    return mode;
  }, [mode]);

  const mapStyle =
    effectiveMode === "light"
      ? "mapbox://styles/mapbox/light-v11"
      : "mapbox://styles/mapbox/dark-v11";

  // Fetch GeoJSON data
  useEffect(() => {
    async function fetchGeo() {
      try {
        const data = await apiClient.get<GeoFeatureCollection>("/api/v1/premises/geo");
        setGeoData(data);
      } catch (err) {
        console.error("Failed to fetch premises GeoJSON", err);
      }
    }
    fetchGeo();
  }, []);

  // Build Supercluster instance when data or active filters change
  const supercluster = useMemo(() => {
    if (!geoData) return null;

    const sc = new Supercluster({ radius: 75, maxZoom: 16 });
    const filtered = geoData.features.filter((f) =>
      activeTypes.includes(f.properties.premiseType)
    );
    sc.load(
      filtered.map((f) => ({
        type: "Feature" as const,
        geometry: f.geometry,
        properties: f.properties,
      }))
    );
    return sc;
  }, [geoData, activeTypes]);

  // Get clusters for current viewport
  const clusters = useMemo(() => {
    if (!supercluster) return [];
    return supercluster.getClusters(bounds, Math.round(viewport.zoom));
  }, [supercluster, bounds, viewport.zoom]);

  // Build GeoJSON for clusters (circles) and points (pins)
  const clusterFeatures = useMemo(
    () => clusters.filter((c) => (c.properties as any).cluster),
    [clusters]
  );
  const pointFeatures = useMemo(
    () => clusters.filter((c) => !(c.properties as any).cluster),
    [clusters]
  );

  const clusterGeoJSON = useMemo(
    () => ({ type: "FeatureCollection" as const, features: clusterFeatures }),
    [clusterFeatures]
  );

  const pointsGeoJSON = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: pointFeatures.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          pinColor: PIN_COLORS[(f.properties as PremiseFeatureProperties).premiseType] ?? "#64748b",
        },
      })),
    };
  }, [pointFeatures]);

  const handleMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewport(evt.viewState);
    const map = mapRef.current?.getMap();
    if (map) {
      const b = map.getBounds();
      if (b) {
        setBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      }
    }
  }, []);

  const handleLayerClick = useCallback(
    (e: any) => {
      if (!e.features || e.features.length === 0) return;
      const feature = e.features[0];
      const props = feature.properties as any;

      if (props.cluster) {
        // Zoom into cluster
        const map = mapRef.current?.getMap();
        if (!map || !supercluster) return;
        const clusterId = props.cluster_id;
        const zoom = supercluster.getClusterExpansionZoom(clusterId);
        const coords = feature.geometry.coordinates as [number, number];
        map.easeTo({ center: coords, zoom, duration: 500 });
        return;
      }

      // Individual pin — show popup
      const coords = feature.geometry.coordinates as [number, number];
      // Parse commodityIds if stored as JSON string
      let commodityIds: string[] = [];
      try {
        commodityIds = typeof props.commodityIds === "string"
          ? JSON.parse(props.commodityIds)
          : props.commodityIds ?? [];
      } catch {
        commodityIds = [];
      }

      setPopupInfo({
        longitude: coords[0],
        latitude: coords[1],
        properties: {
          id: props.id,
          premiseType: props.premiseType,
          status: props.status,
          commodityIds,
          address: props.address,
        },
      });
    },
    [supercluster]
  );

  const handleToggleType = useCallback((type: string) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }, []);

  if (!MAPBOX_TOKEN) {
    return (
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "80px 24px",
          textAlign: "center",
          color: "var(--text-muted)",
          fontSize: "14px",
          flex: 1,
        }}
      >
        <div style={{ fontSize: "32px", marginBottom: "12px" }}>🗺</div>
        Set <code style={{ fontFamily: "monospace" }}>NEXT_PUBLIC_MAPBOX_TOKEN</code> in{" "}
        <code style={{ fontFamily: "monospace" }}>.env.local</code> to enable map view
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: "500px",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={viewport}
        style={{ width: "100%", height: "100%" }}
        mapStyle={mapStyle}
        onMove={handleMove}
        onClick={handleLayerClick}
        interactiveLayerIds={["clusters", "unclustered-point"]}
      >
        {/* Cluster circles */}
        <Source id="clusters-source" type="geojson" data={clusterGeoJSON}>
          <Layer
            id="clusters"
            type="circle"
            paint={{
              "circle-color": "#3b82f6",
              "circle-opacity": 0.7,
              "circle-radius": [
                "step",
                ["get", "point_count"],
                20,
                10,
                28,
                50,
                36,
              ],
            }}
          />
          <Layer
            id="cluster-count"
            type="symbol"
            layout={{
              "text-field": ["get", "point_count_abbreviated"],
              "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
              "text-size": 12,
            }}
            paint={{
              "text-color": "#ffffff",
            }}
          />
        </Source>

        {/* Individual pins */}
        <Source id="points-source" type="geojson" data={pointsGeoJSON}>
          <Layer
            id="unclustered-point"
            type="circle"
            paint={{
              "circle-color": ["get", "pinColor"],
              "circle-radius": 8,
              "circle-stroke-width": 2,
              "circle-stroke-color": "#ffffff",
              "circle-opacity": 0.9,
            }}
          />
        </Source>

        {/* Popup */}
        {popupInfo && (
          <Popup
            longitude={popupInfo.longitude}
            latitude={popupInfo.latitude}
            closeButton={false}
            closeOnClick={false}
            anchor="bottom"
            offset={16}
          >
            <MapPopup
              premiseId={popupInfo.properties.id}
              address={popupInfo.properties.address}
              premiseType={popupInfo.properties.premiseType}
              status={popupInfo.properties.status}
              commodityIds={popupInfo.properties.commodityIds}
              onClose={() => setPopupInfo(null)}
              onViewDetails={() => {
                onPremiseClick?.(popupInfo.properties.id);
              }}
            />
          </Popup>
        )}
      </Map>

      {/* Overlays */}
      <MapFilters activeTypes={activeTypes} onToggle={handleToggleType} />
      <MapLegend />
    </div>
  );
}
