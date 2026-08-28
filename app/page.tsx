"use client";

import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

type SeedItem = {
  id: number;
  brand: string;
  name: string;
  price: number | null;
  color: string;
  category: string;
  fit: string;
  score: number;
  x: number;
  y: number;
  crop: string;
  image?: string;
  url?: string;
  reason?: string;
  kind?: "shop" | "reference" | "owned";
  source?: string;
  materials?: string[];
  sizes?: string[];
  sizeAvailabilityKnown?: boolean;
  available?: boolean;
};

type ApiProduct = {
  id: string;
  brand: string;
  name: string;
  price: number | null;
  color: string;
  category: string;
  fit: string;
  x: number;
  y: number;
  images: string[];
  url: string;
  kind: "shop" | "reference" | "owned";
  scores: Record<string, number>;
  attributes: Record<string, unknown>;
  source: string;
  materials: string[];
  sizes: string[];
  available: boolean;
};

type VisualJobResponse = {
  id: string;
  status: "planning" | "rendering" | "scoring" | "complete" | "error";
  message: string;
  candidates: number;
  totalBatches: number;
  completedBatches: number;
  inspected: number;
  selected: number;
  maxInspections: number;
  threshold: number;
  products: ApiProduct[];
  error?: string;
};

type PromptImage = {
  id: string;
  name: string;
  dataUrl: string;
};

const seedItems: SeedItem[] = [
  { id: 1, brand: "Selected", name: "Veste worker raccourcie", price: 129, color: "Tabac", category: "Vestes", fit: "Courte", score: 94, x: 6, y: 8, crop: "4% 6%", sizes: ["S", "M", "L"], sizeAvailabilityKnown: true, available: true },
  { id: 2, brand: "Weekday", name: "Pantalon ample à pinces", price: 79, color: "Brun", category: "Pantalons", fit: "Large", score: 91, x: 28, y: 18, crop: "29% 9%", sizes: ["M", "L", "XL"], sizeAvailabilityKnown: true, available: true },
  { id: 3, brand: "Massimo Dutti", name: "Maille texturée", price: 99, color: "Grège", category: "Mailles", fit: "Relax", score: 88, x: 52, y: 6, crop: "47% 8%", sizes: ["XL"], sizeAvailabilityKnown: true, available: true },
  { id: 4, brand: "Carhartt WIP", name: "Surchemise vieillie", price: 149, color: "Olive", category: "Vestes", fit: "Droite", score: 86, x: 73, y: 20, crop: "58% 58%" },
  { id: 5, brand: "ARKET", name: "Pantalon laine ample", price: 139, color: "Anthracite", category: "Pantalons", fit: "Large", score: 84, x: 16, y: 58, crop: "71% 19%" },
  { id: 6, brand: "COS", name: "Cardigan compact", price: 115, color: "Chocolat", category: "Mailles", fit: "Court", score: 82, x: 43, y: 55, crop: "86% 16%" },
  { id: 7, brand: "Levi's", name: "Jean 568 loose", price: 109, color: "Bleu vieilli", category: "Pantalons", fit: "Large", score: 79, x: 67, y: 62, crop: "80% 52%" },
  { id: 8, brand: "Minimum", name: "Pull col rond dense", price: 89, color: "Camel", category: "Mailles", fit: "Relax", score: 77, x: 83, y: 52, crop: "41% 79%" },
  { id: 9, brand: "Référence", name: "Silhouette veste courte", price: 0, color: "Brun", category: "Références", fit: "Courte", score: 97, x: 23, y: 40, crop: "14% 8%", kind: "reference" },
  { id: 10, brand: "Référence", name: "Volume pantalon ample", price: 0, color: "Terre", category: "Références", fit: "Large", score: 96, x: 61, y: 43, crop: "72% 17%", kind: "reference" },
];

const filters = ["Tout", "Vestes", "Pantalons", "Mailles", "Chemises", "T-shirts", "Références"];

const tileShapes = [
  [3, 18], [3, 14], [2, 16], [4, 20], [3, 15],
  [2, 18], [3, 20], [4, 15], [3, 17], [2, 14],
] as const;

function tileStyle(index: number): CSSProperties {
  const [columns, rows] = tileShapes[index % tileShapes.length];
  return {
    "--tile-columns": columns,
    "--tile-rows": rows,
  } as CSSProperties;
}

function apiProductsToItems(items: ApiProduct[]): SeedItem[] {
  return items.map((item, index) => ({
    id: index + 1,
    brand: item.brand,
    name: item.name,
    price: item.price,
    color: item.color,
    category: item.category,
    fit: item.fit,
    score: Math.round(item.scores.visual_match ?? item.scores.style_match ?? 50),
    x: item.x * 100,
    y: item.y * 100,
    crop: "center",
    image: item.images[0],
    url: item.url,
    reason: typeof item.attributes.visual_reason === "string" ? item.attributes.visual_reason : undefined,
    kind: item.kind,
    source: item.source,
    materials: item.materials,
    sizes: item.sizes,
    sizeAvailabilityKnown: item.attributes.sizeAvailabilityKnown === true,
    available: item.available,
  }));
}

const standardSizes = ["XS", "S", "M", "L", "XL", "XXL"];

function normalizedSize(value: string) {
  return value.trim().toLocaleUpperCase().replace(/^TAILLE\s+/i, "");
}

function hasSize(item: SeedItem, requestedSize: string) {
  const wanted = normalizedSize(requestedSize);
  return (item.sizes ?? []).some((size) => normalizedSize(size) === wanted);
}

type AxisField = "pca" | "price" | "score";

function axisValue(item: SeedItem, field: AxisField, fallback: "x" | "y") {
  if (field === "price") return item.price ?? Number.MAX_SAFE_INTEGER;
  if (field === "score") return 100 - item.score;
  return item[fallback];
}

function arrangeItems(items: SeedItem[], xAxis: AxisField, yAxis: AxisField): SeedItem[] {
  return [...items].sort((left, right) =>
    axisValue(left, yAxis, "y") - axisValue(right, yAxis, "y")
    || axisValue(left, xAxis, "x") - axisValue(right, xAxis, "x"));
}

export default function Home() {
  const [activeFilter, setActiveFilter] = useState("Tout");
  const [liked, setLiked] = useState<Set<number>>(() => new Set([1, 2, 4]));
  const [mode, setMode] = useState<"space" | "grid">("space");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiStatus, setAiStatus] = useState("");
  const [catalogItems, setCatalogItems] = useState<SeedItem[]>(seedItems);
  const [aiItems, setAiItems] = useState<SeedItem[] | null>(null);
  const [catalogStatus, setCatalogStatus] = useState("démo locale");
  const [visualBusy, setVisualBusy] = useState(false);
  const [visualMode, setVisualMode] = useState<"sequential" | "sheet">("sequential");
  const [promptImages, setPromptImages] = useState<PromptImage[]>([]);
  const [xAxis, setXAxis] = useState<AxisField>("pca");
  const [yAxis, setYAxis] = useState<AxisField>("pca");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [priceFilter, setPriceFilter] = useState("all");
  const [fitFilter, setFitFilter] = useState("all");
  const [materialFilter, setMaterialFilter] = useState("all");
  const [sizeFilter, setSizeFilter] = useState("all");
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const atlasRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const zoomRef = useRef(1);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomScrollRef = useRef<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; pointerId: number; captured: boolean } | null>(null);
  const suppressProductClickRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("http://localhost:8788/api/products?limit=5000", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("catalog unavailable");
        return response.json() as Promise<ApiProduct[]>;
      })
      .then((items) => {
        if (items.length === 0) return;
        setCatalogItems(apiProductsToItems(items));
        setCatalogStatus("catalogue local");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogStatus("démo · API hors ligne");
      });
    return () => controller.abort();
  }, []);

  const visibleCatalog = aiItems ?? catalogItems;
  const quickFilteredCatalog = useMemo(() => visibleCatalog.filter((item) => {
    if (sourceFilter === "shop" && item.kind === "reference") return false;
    if (sourceFilter === "reference" && item.kind !== "reference") return false;
    if (sourceFilter === "zalando" && item.source !== "zalando-ch") return false;
    if (priceFilter !== "all") {
      if (item.price === null) return false;
      if (priceFilter === "under50" && item.price >= 50) return false;
      if (priceFilter === "50to100" && (item.price < 50 || item.price > 100)) return false;
      if (priceFilter === "100to180" && (item.price < 100 || item.price > 180)) return false;
      if (priceFilter === "over180" && item.price <= 180) return false;
    }
    if (fitFilter !== "all" && item.fit.toLocaleLowerCase() !== fitFilter) return false;
    if (materialFilter !== "all") {
      const haystack = `${item.name} ${(item.materials ?? []).join(" ")}`.toLocaleLowerCase();
      const aliases: Record<string, string[]> = {
        knit: ["maille", "knit", "strick"],
        linen: ["lin", "linen"],
        cotton: ["coton", "cotton"],
        leather: ["cuir", "leather", "leder"],
      };
      if (!aliases[materialFilter]?.some((term) => haystack.includes(term))) return false;
    }
    if (sizeFilter === "known" && !item.sizeAvailabilityKnown) return false;
    if (sizeFilter !== "all" && sizeFilter !== "known" && !hasSize(item, sizeFilter)) return false;
    return true;
  }), [fitFilter, materialFilter, priceFilter, sizeFilter, sourceFilter, visibleCatalog]);
  const sizeOptions = useMemo(() => {
    const discovered = [...new Set(visibleCatalog.flatMap((item) => item.sizes ?? []).map(normalizedSize))];
    return [...new Set([...standardSizes, ...discovered])].sort((left, right) => {
      const leftStandard = standardSizes.indexOf(left);
      const rightStandard = standardSizes.indexOf(right);
      if (leftStandard >= 0 || rightStandard >= 0) {
        if (leftStandard < 0) return 1;
        if (rightStandard < 0) return -1;
        return leftStandard - rightStandard;
      }
      return left.localeCompare(right, undefined, { numeric: true });
    });
  }, [visibleCatalog]);
  const knownSizeCount = useMemo(
    () => visibleCatalog.filter((item) => item.sizeAvailabilityKnown).length,
    [visibleCatalog],
  );
  const sizeCounts = useMemo(() => Object.fromEntries(
    sizeOptions.map((size) => [size, visibleCatalog.filter((item) => hasSize(item, size)).length]),
  ), [sizeOptions, visibleCatalog]);
  const products = useMemo(
    () => arrangeItems(quickFilteredCatalog.filter((item) => activeFilter === "Tout" || item.category === activeFilter), xAxis, yAxis),
    [activeFilter, quickFilteredCatalog, xAxis, yAxis],
  );
  const categoryCounts = useMemo(() => Object.fromEntries(filters.map((filter) => [
    filter,
    filter === "Tout" ? visibleCatalog.length : visibleCatalog.filter((item) => item.category === filter).length,
  ])), [visibleCatalog]);

  function toggleLiked(id: number) {
    setLiked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function changeZoom(nextValue: number, anchor?: { x: number; y: number }) {
    const atlas = atlasRef.current;
    const next = Math.min(2.5, Math.max(.65, Math.round(nextValue * 100) / 100));
    const current = zoomRef.current;
    if (next === current) return;
    zoomRef.current = next;
    if (!atlas) return setZoom(next);
    const point = anchor ?? { x: atlas.clientWidth / 2, y: atlas.clientHeight / 2 };
    const pendingScroll = zoomScrollRef.current ?? { left: atlas.scrollLeft, top: atlas.scrollTop };
    const contentX = (pendingScroll.left + point.x) / current;
    const contentY = (pendingScroll.top + point.y) / current;
    zoomScrollRef.current = {
      left: contentX * next - point.x,
      top: contentY * next - point.y,
    };
    setZoom(next);
    if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    zoomFrameRef.current = requestAnimationFrame(() => {
      const target = zoomScrollRef.current;
      if (target) {
        atlas.scrollLeft = target.left;
        atlas.scrollTop = target.top;
      }
      zoomScrollRef.current = null;
      zoomFrameRef.current = null;
    });
  }

  function resetView() {
    zoomRef.current = 1;
    zoomScrollRef.current = null;
    setZoom(1);
    requestAnimationFrame(() => atlasRef.current?.scrollTo({ left: 0, top: 0 }));
  }

  useEffect(() => {
    const atlas = atlasRef.current;
    if (!atlas || mode !== "space") return;
    const handleNativeWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = atlas.getBoundingClientRect();
      const intensity = event.deltaMode === 1 ? .025 : .0025;
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * intensity), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    };
    atlas.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => atlas.removeEventListener("wheel", handleNativeWheel);
  }, [mode]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (mode !== "space" || (event.target as HTMLElement).closest("button, input")) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
      pointerId: event.pointerId,
      captured: false,
    };
    suppressProductClickRef.current = false;
  }

  function pan(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) {
      suppressProductClickRef.current = true;
      if (!start.captured) {
        event.currentTarget.setPointerCapture(start.pointerId);
        start.captured = true;
        setDragging(true);
      }
    }
    if (!start.captured) return;
    event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
    event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
  }

  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    if (dragRef.current.captured && event.currentTarget.hasPointerCapture(dragRef.current.pointerId)) {
      event.currentTarget.releasePointerCapture(dragRef.current.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }

  function prepareNaturalPreview(event: ReactPointerEvent<HTMLElement>) {
    if (mode !== "space" || dragging) return;
    const card = event.currentTarget;
    const image = card.querySelector("img");
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const baseWidth = card.offsetWidth;
    const baseHeight = card.offsetHeight;
    if (!baseWidth || !baseHeight) return;
    const ratio = image.naturalWidth / image.naturalHeight;
    const currentRatio = baseWidth / baseHeight;
    const targetWidth = ratio >= currentRatio ? baseHeight * ratio : baseWidth;
    const targetHeight = ratio >= currentRatio ? baseHeight : baseWidth / ratio;
    card.style.setProperty("--hover-width", `${targetWidth}px`);
    card.style.setProperty("--hover-height", `${targetHeight}px`);
  }

  async function askCodex() {
    if (!aiPrompt.trim()) return;
    setAiStatus("Codex Luna traduit la demande…");
    try {
      const response = await fetch("http://localhost:8788/api/codex/filter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      if (!response.ok) throw new Error("bridge unavailable");
      const result = await response.json() as { filter?: { name?: string } };
      if (!result.filter) throw new Error("missing filter");
      const queryResponse = await fetch("http://localhost:8788/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result.filter),
      });
      if (!queryResponse.ok) throw new Error("query failed");
      const matches = await queryResponse.json() as ApiProduct[];
      setAiItems(apiProductsToItems(matches));
      setActiveFilter("Tout");
      setAiStatus(`« ${result.filter.name ?? "Codex"} » · ${matches.length} résultats`);
    } catch {
      setAiStatus("Bridge local hors ligne — lance npm run dev");
    }
  }

  async function askCodexVision() {
    if ((!aiPrompt.trim() && promptImages.length === 0) || visualBusy) return;
    setVisualBusy(true);
    setAiItems([]);
    setAiStatus(visualMode === "sheet" ? "Luna prépare sa première planche…" : "Luna prépare la sélection visuelle…");
    try {
      const prompt = aiPrompt.trim() || "Trouve des vêtements visuellement proches du mood board joint.";
      const response = await fetch("http://localhost:8788/api/codex/visual-select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          maxCandidates: 48,
          topN: 24,
          threshold: .5,
          analysisMode: visualMode,
          images: promptImages.map(({ name, dataUrl }) => ({ name, dataUrl })),
        }),
      });
      if (!response.ok) throw new Error("visual job unavailable");
      let job = await response.json() as VisualJobResponse;
      while (job.status !== "complete" && job.status !== "error") {
        setAiItems(apiProductsToItems(job.products));
        setActiveFilter("Tout");
        const progress = ` · ${job.inspected}/${job.maxInspections} vues · ${job.selected} retenus`;
        setAiStatus(`${job.message}${progress}`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const poll = await fetch(`http://localhost:8788/api/codex/visual-jobs/${job.id}`);
        if (!poll.ok) throw new Error("visual job lost");
        job = await poll.json() as VisualJobResponse;
      }
      if (job.status === "error") throw new Error(job.error ?? "visual selection failed");
      setAiItems(apiProductsToItems(job.products));
      setActiveFilter("Tout");
      setAiStatus(`${job.message} · affichage strictement > ${job.threshold.toFixed(2)}`);
    } catch (error) {
      setAiStatus(`Vision indisponible — ${error instanceof Error ? error.message : "erreur locale"}`);
    } finally {
      setVisualBusy(false);
    }
  }

  async function addPromptImages(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, 6 - promptImages.length));
    if (images.length === 0) return;
    try {
      const next = await Promise.all(images.map((file) => new Promise<PromptImage>((resolvePromise, reject) => {
        if (file.size > 12 * 1024 * 1024) return reject(new Error(`${file.name} dépasse 12 MB`));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}`));
        reader.onload = () => resolvePromise({ id: crypto.randomUUID(), name: file.name || "image collée", dataUrl: String(reader.result) });
        reader.readAsDataURL(file);
      })));
      setPromptImages((current) => [...current, ...next].slice(0, 6));
      setAiStatus(`${next.length} image${next.length > 1 ? "s" : ""} ajoutée${next.length > 1 ? "s" : ""} au prochain prompt Vision`);
    } catch (error) {
      setAiStatus(error instanceof Error ? error.message : "Image impossible à ajouter");
    }
  }

  return (
    <main className="appShell">
      <header className="topbar">
        <div className="brandBlock">
          <span className="brandMark">WA</span>
          <div>
            <h1>Wardrobe Atlas</h1>
            <p>Catalogue visuel local</p>
          </div>
        </div>
        <div className="topActions">
          <button className="quietButton">＋ Importer</button>
          <button className="primaryButton">＋ Ajouter</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sideSection">
            <span className="eyebrow">Collection</span>
            <div className="collectionTitle">
              <strong>Automne · brun ténébreux</strong>
              <span>{visibleCatalog.length} pièces</span>
            </div>
          </div>

          <div className="sideSection">
            <span className="eyebrow">Catégories</span>
            <div className="filterStack">
              {filters.map((filter) => (
                <button
                  className={activeFilter === filter ? "filter active" : "filter"}
                  key={filter}
                  onClick={() => setActiveFilter(filter)}
                >
                  <span>{filter}</span>
                  <span>{categoryCounts[filter]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sideSection">
            <span className="eyebrow">Contraintes actives</span>
            <div className="chips">
              <span>coupe large</span>
              <span>sans gros logo</span>
              <span>CHF 40–180</span>
              <span>tons terre</span>
              <span>− sportswear</span>
            </div>
          </div>

          <div className="sideSummary">
            <span><b>{liked.size}</b> favoris</span>
            <span><b>{categoryCounts.Références}</b> références</span>
          </div>
        </aside>

        <section className="boardPanel">
          <div className="boardToolbar">
            <div>
              <span className="eyebrow">Carte de style · PCA compacte</span>
              <h2>Automne · brun ténébreux</h2>
            </div>
            <div className="toolbarRight">
              <div className="axisControls" aria-label="Axes de rangement">
                <label>X<select value={xAxis} onChange={(event) => setXAxis(event.target.value as AxisField)}><option value="pca">PCA</option><option value="price">Prix</option><option value="score">Score</option></select></label>
                <label>Y<select value={yAxis} onChange={(event) => setYAxis(event.target.value as AxisField)}><option value="pca">PCA</option><option value="price">Prix</option><option value="score">Score</option></select></label>
              </div>
              <div className="segmented" aria-label="Mode d’affichage">
                <button className={mode === "space" ? "active" : ""} onClick={() => setMode("space")}>Espace</button>
                <button className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>Grille</button>
              </div>
              <div className="zoomControls" aria-label="Zoom du board">
                <button disabled={mode !== "space" || zoom <= .65} onClick={() => changeZoom(zoomRef.current - .15)} aria-label="Dézoomer">−</button>
                <button disabled={mode !== "space"} onClick={resetView} className="zoomValue">{Math.round(zoom * 100)}%</button>
                <button disabled={mode !== "space" || zoom >= 2.5} onClick={() => changeZoom(zoomRef.current + .15)} aria-label="Zoomer">＋</button>
              </div>
            </div>
          </div>

          <div className="filterBar">
            <label className="quickFilter"><small>Source</small><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">Toutes</option><option value="shop">Tous shops</option><option value="zalando">Zalando</option><option value="reference">Références</option></select></label>
            <label className="quickFilter"><small>Prix</small><select value={priceFilter} onChange={(event) => setPriceFilter(event.target.value)}><option value="all">Tous</option><option value="under50">&lt; 50</option><option value="50to100">50–100</option><option value="100to180">100–180</option><option value="over180">&gt; 180</option></select></label>
            <label className="quickFilter"><small>Coupe</small><select value={fitFilter} onChange={(event) => setFitFilter(event.target.value)}><option value="all">Toutes</option><option value="large">Large</option><option value="courte">Courte</option><option value="droite">Droite</option><option value="unknown">Inconnue</option></select></label>
            <label className="quickFilter"><small>Matière</small><select value={materialFilter} onChange={(event) => setMaterialFilter(event.target.value)}><option value="all">Toutes</option><option value="knit">Maille</option><option value="linen">Lin</option><option value="cotton">Coton</option><option value="leather">Cuir</option></select></label>
            <label className="quickFilter" title={`${knownSizeCount} articles avec disponibilité de taille vérifiée sur ${visibleCatalog.length}`}><small>Taille · {knownSizeCount}/{visibleCatalog.length}</small><select value={sizeFilter} onChange={(event) => setSizeFilter(event.target.value)} aria-label="Filtrer par taille disponible"><option value="all">Toutes</option><option value="known">Disponibilité connue ({knownSizeCount})</option>{sizeOptions.map((size) => <option value={size} key={size}>{size} ({sizeCounts[size]})</option>)}</select></label>
            <div className="aiComposer">
              <label className="aiFilter">
                <span className="pulseDot" />
                <input
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  onPaste={(event) => {
                    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                    if (images.length === 0) return;
                    event.preventDefault();
                    void addPromptImages(images);
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") void askCodex(); }}
                  placeholder="Décris un filtre ou colle un mood board…"
                  aria-label="Demander un filtre à Codex"
                />
                <input
                  ref={imageInputRef}
                  className="hiddenImageInput"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(event) => {
                    void addPromptImages(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <button className="attachButton" type="button" onClick={() => imageInputRef.current?.click()} aria-label="Ajouter des images" title="Ajouter ou coller un mood board">＋ image</button>
                <button type="button" onClick={() => void askCodex()}>Filtrer</button>
                <button type="button" className="visionButton" disabled={visualBusy} onClick={() => void askCodexVision()}>{visualBusy ? "Analyse…" : "Vision"}</button>
              </label>
              <div className="visionOptions">
                <div className="segmented analysisMode" aria-label="Méthode d’analyse visuelle">
                  <button className={visualMode === "sequential" ? "active" : ""} onClick={() => setVisualMode("sequential")} title="Une image à la fois">1 × 1</button>
                  <button className={visualMode === "sheet" ? "active" : ""} onClick={() => setVisualMode("sheet")} title="Comparer une planche puis ouvrir les articles ambigus">Planche + détail</button>
                </div>
                {promptImages.length > 0 && (
                  <div className="promptImages" aria-label="Images jointes au prochain prompt">
                    {promptImages.map((image) => (
                      <span className="promptImage" key={image.id} title={image.name}>
                        <img src={image.dataUrl} alt="" />
                        <button type="button" onClick={() => setPromptImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Retirer ${image.name}`}>×</button>
                      </span>
                    ))}
                    <small>{promptImages.length}/6 · prochain prompt Vision</small>
                  </div>
                )}
              </div>
            </div>
            {aiStatus && (
              <span className="aiStatus">
                {aiStatus}
                {aiItems && <button onClick={() => { setAiItems(null); setAiStatus(""); }}>×</button>}
              </span>
            )}
          </div>

          <div
            ref={atlasRef}
            className={`${mode === "space" ? "atlas spaceMode" : "atlas gridMode"}${dragging ? " dragging" : ""}`}
            onPointerDown={startPan}
            onPointerMove={pan}
            onPointerUp={stopPan}
            onPointerCancel={stopPan}
          >
            <div
              className="atlasCanvas"
              style={mode === "space" ? ({ "--board-scale": zoom, width: `${zoom * 160}%` } as CSSProperties) : undefined}
            >
            {products.map((item, index) => (
              <article
                className={`productCard ${item.kind === "reference" ? "referenceCard" : ""}`}
                key={item.id}
                style={mode === "space" ? tileStyle(index) : undefined}
                title={item.reason}
                onPointerEnter={prepareNaturalPreview}
                onPointerLeave={(event) => {
                  event.currentTarget.style.removeProperty("--hover-width");
                  event.currentTarget.style.removeProperty("--hover-height");
                }}
              >
                <button className={liked.has(item.id) ? "heart liked" : "heart"} onClick={() => toggleLiked(item.id)} aria-label="Ajouter aux favoris">
                  {liked.has(item.id) ? "♥" : "♡"}
                </button>
                {item.url && (
                  <a
                    className="productLinkOverlay"
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Ouvrir ${item.brand} — ${item.name}`}
                    onClick={(event) => {
                      if (!suppressProductClickRef.current) return;
                      event.preventDefault();
                      suppressProductClickRef.current = false;
                    }}
                  />
                )}
                <div
                  className="productImage"
                  style={{
                    backgroundPosition: item.crop,
                  }}
                >
                  {item.image && <img src={item.image} alt="" loading="lazy" decoding="async" />}
                </div>
                <div className="productMeta">
                  <div className="scoreRow"><span>{item.brand}</span><b>{item.score}</b></div>
                  <h3>{item.name}</h3>
                  <p>{item.reason ?? `${item.color} · ${item.fit}`}</p>
                  <strong>
                    {item.kind === "reference" ? "Ancre de style" : item.price == null ? "Prix inconnu" : `CHF ${item.price.toFixed(2)}`}
                    {item.kind !== "reference" && item.sizeAvailabilityKnown && (
                      <em className="sizeSummary"> · {(item.sizes ?? []).length > 0 ? (item.sizes ?? []).slice(0, 5).join(" ") : "épuisé"}</em>
                    )}
                  </strong>
                </div>
              </article>
            ))}
            {products.length === 0 && (
              <div className="emptyBoard">
                <strong>Aucun article confirmé{sizeFilter !== "all" && sizeFilter !== "known" ? ` en ${sizeFilter}` : ""}</strong>
                <span>Les disponibilités inconnues restent exclues pour éviter les faux positifs.</span>
              </div>
            )}
            </div>
          </div>

          <footer className="boardFooter">
            <span><b>{products.length}</b> pièces visibles sur {visibleCatalog.length}</span>
            <span>Proximité PCA · {catalogStatus} · rangement dense sans trous</span>
          </footer>
        </section>
      </section>
    </main>
  );
}
