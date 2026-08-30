"use client";

/* Remote shop imagery cannot use the framework image proxy; cards provide their own lazy loading. */
/* eslint-disable @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions */

import {
  type CSSProperties,
  type FormEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  error?: string | null;
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

function applyNaturalPreviewGeometry(card: HTMLElement) {
  const image = card.querySelector<HTMLImageElement>(".productImage img");
  const baseWidth = card.offsetWidth;
  const baseHeight = card.offsetHeight;
  if (!image?.naturalWidth || !image.naturalHeight || !baseWidth || !baseHeight) return false;
  const naturalRatio = image.naturalWidth / image.naturalHeight;
  const baseRatio = baseWidth / baseHeight;
  const targetWidth = naturalRatio > baseRatio ? baseHeight * naturalRatio : baseWidth;
  const targetHeight = naturalRatio > baseRatio ? baseHeight : baseWidth / naturalRatio;
  card.style.setProperty("--hover-width", `${Math.max(baseWidth, targetWidth)}px`);
  card.style.setProperty("--hover-height", `${Math.max(baseHeight, targetHeight)}px`);
  return true;
}

function clearNaturalPreviewGeometry(card: HTMLElement | null) {
  card?.style.removeProperty("--hover-width");
  card?.style.removeProperty("--hover-height");
  card?.style.removeProperty("--hover-scale");
}

export function LegacyHome() {
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
  const legacyHoverCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/products?limit=5000", { signal: controller.signal })
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
    if (sourceFilter === "aboutyou" && item.source !== "aboutyou-ch") return false;
    if (sourceFilter === "aliexpress" && item.source !== "aliexpress") return false;
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
    clearNaturalPreviewGeometry(legacyHoverCardRef.current);
    legacyHoverCardRef.current = null;
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
    if (mode !== "space" || dragging || window.matchMedia("(hover: none)").matches) return;
    legacyHoverCardRef.current = event.currentTarget;
    applyNaturalPreviewGeometry(event.currentTarget);
    event.currentTarget.style.setProperty("--hover-scale", "1.2");
  }

  useEffect(() => {
    clearNaturalPreviewGeometry(legacyHoverCardRef.current);
    legacyHoverCardRef.current = null;
  }, [mode, zoom]);

  async function askCodex() {
    if (!aiPrompt.trim()) return;
    setAiStatus("Codex Luna traduit la demande…");
    try {
      const response = await fetch("/api/codex/filter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      if (!response.ok) throw new Error("bridge unavailable");
      const result = await response.json() as { filter?: { name?: string } };
      if (!result.filter) throw new Error("missing filter");
      const queryResponse = await fetch("/api/query", {
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
      const response = await fetch("/api/codex/visual-select", {
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
        const poll = await fetch(`/api/codex/visual-jobs/${job.id}`);
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
            <label className="quickFilter"><small>Source</small><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">Toutes</option><option value="shop">Tous shops</option><option value="zalando">Zalando</option><option value="aboutyou">About You</option><option value="aliexpress">AliExpress</option><option value="reference">Références</option></select></label>
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
                  clearNaturalPreviewGeometry(event.currentTarget);
                  if (legacyHoverCardRef.current === event.currentTarget) legacyHoverCardRef.current = null;
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
                  {item.image && <img src={item.image} alt="" loading="lazy" decoding="async" onLoad={(event) => {
                    const card = event.currentTarget.closest<HTMLElement>(".productCard");
                    if (mode === "space" && card && legacyHoverCardRef.current === card && card.matches(":hover") && card.style.getPropertyValue("--hover-scale")) applyNaturalPreviewGeometry(card);
                  }} />}
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

type AtlasDecision = "unseen" | "saved" | "rejected" | "owned";
type AtlasKind = "shop" | "reference" | "owned";
type AtlasScope = "catalogue" | "saved" | "owned" | "reference" | "outfits";
type AtlasDrawer = "filters" | "view" | "compare" | "views" | "collections" | "activity" | "studio" | "add" | "outfits" | null;
type AtlasImageMode = "cropped" | "full";

type AtlasItem = {
  id: string;
  brand: string;
  name: string;
  price: number | null;
  originalPrice?: number | null;
  currency: string;
  color: string;
  category: string;
  fit: string;
  score: number;
  x: number;
  y: number;
  crop: string;
  image?: string;
  images: string[];
  url?: string;
  reason?: string;
  kind: AtlasKind;
  decision: AtlasDecision;
  source: string;
  materials: string[];
  sizes: string[];
  tags: string[];
  scores?: Record<string, number>;
  attributes?: Record<string, unknown>;
  sizeAvailabilityKnown: boolean;
  available: boolean;
  stockStatus: string;
  stockCheckedAt?: string | null;
  priceCheckedAt?: string | null;
  sizesCheckedAt?: string | null;
  updatedAt?: string;
  returnsLabel?: string;
  returnsWindowDays?: number;
  imageAspectRatio?: number;
};

type AtlasApiProduct = {
  id: string;
  brand?: string;
  name?: string;
  price?: number | null;
  originalPrice?: number | null;
  currency?: string;
  color?: string;
  category?: string;
  fit?: string;
  x?: number;
  y?: number;
  images?: string[];
  url?: string;
  kind?: AtlasKind;
  decision?: AtlasDecision;
  scores?: Record<string, number>;
  attributes?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  source?: string;
  materials?: string[];
  sizes?: string[];
  tags?: string[];
  available?: boolean;
  stockStatus?: string;
  stockCheckedAt?: string | null;
  priceCheckedAt?: string | null;
  sizesCheckedAt?: string | null;
  updatedAt?: string;
};

type AtlasVisualJob = {
  id: string;
  status: "planning" | "rendering" | "scoring" | "complete" | "error";
  message: string;
  inspected: number;
  selected: number;
  maxInspections: number;
  threshold: number;
  products: AtlasApiProduct[];
  error?: string;
};

type AtlasPromptImage = { id: string; name: string; dataUrl: string };

type AtlasAssistantResponse = {
  action: "filter" | "similar" | "visual" | "discover" | "import_links" | "outfit" | "artifact" | "collection" | "enrich" | "compare" | "summarize" | "clarify";
  plan?: {
    title?: string;
    message?: string;
    sizePolicy?: "default" | "explicit" | "all";
    shopPolicy?: "default" | "explicit" | "all";
    pricePolicy?: "default" | "explicit" | "all";
    effectiveSizes?: string[];
    effectiveShops?: string[];
    effectiveMinPrice?: number;
    effectiveMaxPrice?: number;
  };
  products?: AtlasApiProduct[];
  discoveryPlan?: AtlasDiscoveryPlan;
  jobs?: AtlasDiscoveryJob[];
  boards?: AtlasOutfitBoard[];
  imported?: AtlasApiProduct[];
  artifact?: MosaicArtifact;
  collection?: MosaicCollection;
  acquisitionJob?: AtlasAcquisitionJob;
  job?: AtlasVisualJob | AtlasAcquisitionJob;
  summary?: string | Record<string, unknown>;
  importErrors?: Array<{ url: string; error: string }>;
  message?: string;
};

type AtlasSavedView = {
  id: string;
  name: string;
  scope: AtlasScope;
  activeFilter: string;
  sourceFilter: string;
  priceFilter: string;
  fitFilter: string;
  materialFilter: string;
  sizeFilters: string[];
  sizeFilter?: string;
  stockFilter: string;
  attributeQuery: string;
  minPrice: string;
  maxPrice: string;
  includeRejected: boolean;
  selectedCollectionId?: string | null;
  dynamicFacetSelections?: Record<string, string[]>;
  dynamicNumberFilters?: Record<string, { min: string; max: string }>;
  xAxis: AxisField;
  yAxis: AxisField;
  mode: "space" | "grid";
  imageMode: AtlasImageMode;
};

type AtlasOutfitBoard = {
  id: string;
  name: string;
  productIds: string[];
  notes?: string;
  description?: string;
  metadata?: {
    compatibilityScore?: number;
    noveltyScore?: number;
    missingRoles?: string[];
    anchorProductId?: string;
  };
  createdAt?: string;
};

type AtlasUndoAction = {
  actionId?: string;
  productId: string;
  previousDecision: AtlasDecision;
  nextDecision: AtlasDecision;
};

type AtlasAcquisitionJob = {
  id: string;
  status: string;
  rawStatus?: string;
  terminal?: boolean;
  partial?: boolean;
  canResume?: boolean;
  completed?: number;
  processed?: number;
  total?: number;
  succeeded?: number;
  failed?: number;
  blocked?: number;
  cancelled?: number;
  message?: string;
  error?: string;
  cooldownUntil?: string;
};

type AtlasDiscoveryStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

type AtlasDiscoverySearch = {
  source: string;
  query?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  maxItems: number;
  reason?: string;
};

type AtlasDiscoveryPlan = {
  id: string;
  name: string;
  description: string;
  targetCount: number;
  sizes: string[];
  sizeMode: "any";
  searches: AtlasDiscoverySearch[];
};

type AtlasDiscoveryJob = {
  id: string;
  source: string;
  intent: AtlasDiscoverySearch & { sizes?: string[]; sizeMode?: "any" | "all" };
  status: AtlasDiscoveryStatus;
  total: number;
  completed: number;
  progress: number;
  discovered: number;
  duplicates: number;
  filtered: number;
  invalid: number;
  error?: string;
  results: unknown[];
  createdAt?: string;
};

type MosaicFieldDefinition = {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "enum" | "multi-enum" | "date";
  unit?: string;
  facetable?: boolean;
  sortable?: boolean;
  display?: boolean;
  displayOrder?: number;
  options?: Array<string | { value: string; label?: string }>;
  coverage?: number;
  cardinality?: number;
};

type MosaicFacetOption = { value: string; label?: string; count: number };
type MosaicWorkspaceSchema = {
  workspace?: { id: string; name: string; profile?: string };
  fields: MosaicFieldDefinition[];
  facets: Record<string, MosaicFacetOption[]>;
};
type MosaicCollection = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  kind?: string;
  itemIds: string[];
};
type MosaicRun = {
  id: string;
  type?: string;
  kind?: string;
  status: string;
  label?: string;
  title?: string;
  message?: string;
  progress?: number;
  completed?: number;
  total?: number;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
};
type MosaicEmbeddingJob = {
  status: "idle" | "running" | "succeeded" | "failed";
  processed: number;
  total: number;
  phase?: string;
  message?: string;
  summary?: { embedded: number; metadataOnly: number; cacheHits: number; errors: number };
};
type MosaicWorkspace = { id: string; name: string; profile?: string; description?: string };
type MosaicWorkspaceOperation = { workspaceId: string; epoch: number; signal: AbortSignal };
type MosaicArtifact = {
  id: string;
  name: string;
  status?: string;
  prompt?: string;
  itemIds: string[];
  imageReferences?: string[];
  inputItemIds?: string[];
  inputCollectionIds?: string[];
  localFiles?: string[];
  type?: string;
  generator?: string | null;
  provenance?: Record<string, unknown>;
  createdAt?: string;
  error?: string | null;
};

type AtlasDiscoverySession = { plan: AtlasDiscoveryPlan; jobIds: string[]; workspaceId?: string };

// Vite's development server proxies `/api`; the production vinext server does
// not. Keep the dev single-origin path, while the local production build talks
// directly to the API process started alongside it by `npm start`.
const ATLAS_API = process.env.NODE_ENV === "production" ? "http://127.0.0.1:8788/api" : "/api";
const ATLAS_ORIGIN = ATLAS_API.slice(0, -4);
const ATLAS_PAGE_SIZE = 240;
const ATLAS_DEFAULT_ZOOM = 2;
const ATLAS_MAX_ZOOM = 10;
const ATLAS_ZOOM_SENSITIVITY = .009;
const ATLAS_CULL_INTERVAL_MS = 250;
const ATLAS_MAX_IMAGES = 6;
const ATLAS_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ATLAS_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const ATLAS_DEMO_FRESH_AT = "2026-08-28T12:00:00.000Z";
const ATLAS_TERMINAL_REFRESH_STATUSES = ["complete", "error", "blocked", "cancelled"];
const ATLAS_PREFERENCES_KEY = "wardrobe-atlas:board-preferences:v2";
const ATLAS_DISCOVERY_SESSION_KEY = "wardrobe-atlas:discovery-session:v1";
const MOSAIC_COLLECTIONS_FALLBACK_KEY = "mosaic:collections:fallback:v1";
const MOSAIC_ONBOARDING_KEY = "mosaic:onboarding:dismissed:v1";
const MOSAIC_ACTIVE_WORKSPACE_KEY = "mosaic:workspace:active:v1";
const MOSAIC_ARTIFACTS_FALLBACK_KEY = "mosaic:artifacts:fallback:v1";
const ATLAS_TERMINAL_DISCOVERY_STATUSES = new Set<AtlasDiscoveryStatus>(["succeeded", "failed", "blocked", "cancelled"]);
const ATLAS_DISCOVERY_SOURCE_LABELS: Record<string, string> = { "zalando-ch": "Zalando CH", "aboutyou-ch": "About You CH", aliexpress: "AliExpress" };

function atlasWorkspaceApiUrl(path: string, workspaceId: string) {
  if (!workspaceId) return `${ATLAS_API}${path}`;
  const separator = path.includes("?") ? "&" : "?";
  return `${ATLAS_API}${path}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

const atlasSeedItems: AtlasItem[] = [
  { id: "demo_worker", brand: "Selected", name: "Veste worker raccourcie", price: 129, currency: "CHF", color: "Tabac", category: "Vestes", fit: "Courte", score: 94, x: 6, y: 8, crop: "4% 6%", images: [], kind: "shop", decision: "saved", source: "demo", materials: ["Coton"], sizes: ["S", "M", "L"], tags: [], sizeAvailabilityKnown: true, available: true, stockStatus: "in_stock", sizesCheckedAt: ATLAS_DEMO_FRESH_AT },
  { id: "demo_trouser", brand: "Weekday", name: "Pantalon ample à pinces", price: 79, currency: "CHF", color: "Brun", category: "Pantalons", fit: "Large", score: 91, x: 28, y: 18, crop: "29% 9%", images: [], kind: "shop", decision: "saved", source: "demo", materials: ["Coton"], sizes: ["M", "L", "XL"], tags: [], sizeAvailabilityKnown: true, available: true, stockStatus: "in_stock", sizesCheckedAt: ATLAS_DEMO_FRESH_AT },
  { id: "demo_knit", brand: "Massimo Dutti", name: "Maille texturée", price: 99, currency: "CHF", color: "Grège", category: "Mailles", fit: "Relax", score: 88, x: 52, y: 6, crop: "47% 8%", images: [], kind: "shop", decision: "unseen", source: "demo", materials: ["Laine"], sizes: ["XL"], tags: [], sizeAvailabilityKnown: true, available: true, stockStatus: "in_stock", sizesCheckedAt: ATLAS_DEMO_FRESH_AT },
  { id: "demo_overshirt", brand: "Carhartt WIP", name: "Surchemise vieillie", price: 149, currency: "CHF", color: "Olive", category: "Vestes", fit: "Droite", score: 86, x: 73, y: 20, crop: "58% 58%", images: [], kind: "shop", decision: "unseen", source: "demo", materials: [], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "unknown" },
  { id: "demo_wool", brand: "ARKET", name: "Pantalon laine ample", price: 139, currency: "CHF", color: "Anthracite", category: "Pantalons", fit: "Large", score: 84, x: 16, y: 58, crop: "71% 19%", images: [], kind: "shop", decision: "unseen", source: "demo", materials: ["Laine"], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "unknown" },
  { id: "demo_cardigan", brand: "COS", name: "Cardigan compact", price: 115, currency: "CHF", color: "Chocolat", category: "Mailles", fit: "Court", score: 82, x: 43, y: 55, crop: "86% 16%", images: [], kind: "shop", decision: "unseen", source: "demo", materials: ["Laine"], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "unknown" },
  { id: "demo_jean", brand: "Levi's", name: "Jean 568 loose", price: 109, currency: "CHF", color: "Bleu vieilli", category: "Pantalons", fit: "Large", score: 79, x: 67, y: 62, crop: "80% 52%", images: [], kind: "shop", decision: "unseen", source: "demo", materials: ["Denim"], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "unknown" },
  { id: "demo_sweater", brand: "Minimum", name: "Pull col rond dense", price: 89, currency: "CHF", color: "Camel", category: "Mailles", fit: "Relax", score: 77, x: 83, y: 52, crop: "41% 79%", images: [], kind: "shop", decision: "unseen", source: "demo", materials: [], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "unknown" },
  { id: "demo_ref_jacket", brand: "Référence", name: "Silhouette veste courte", price: null, currency: "CHF", color: "Brun", category: "Références", fit: "Courte", score: 97, x: 23, y: 40, crop: "14% 8%", images: [], kind: "reference", decision: "saved", source: "reference", materials: [], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "not_applicable" },
  { id: "demo_ref_volume", brand: "Référence", name: "Volume pantalon ample", price: null, currency: "CHF", color: "Terre", category: "Références", fit: "Large", score: 96, x: 61, y: 43, crop: "72% 17%", images: [], kind: "reference", decision: "saved", source: "reference", materials: [], sizes: [], tags: [], sizeAvailabilityKnown: false, available: true, stockStatus: "not_applicable" },
];

const atlasCategories = ["Tout", "Vestes", "Pantalons", "Mailles", "Chemises", "T-shirts", "Chaussures", "Accessoires", "Références"];
const atlasSizes = ["XS", "S", "M", "L", "XL", "XXL"];
const atlasScopes: { id: AtlasScope; label: string; icon: string }[] = [
  { id: "catalogue", label: "Catalogue", icon: "▦" },
  { id: "saved", label: "Gardés", icon: "♥" },
  { id: "owned", label: "Dressing", icon: "◆" },
  { id: "reference", label: "Références", icon: "◈" },
  { id: "outfits", label: "Tenues", icon: "⊞" },
];

function atlasNormalizedSize(value: string) {
  return value.trim().toLocaleUpperCase().replace(/^TAILLE\s+/i, "");
}

function atlasBrowserImage(source: string): string {
  const clean = source.trim();
  if (!clean) return "";
  if (clean.startsWith("/api/")) return `${ATLAS_ORIGIN}${clean}`;
  if (clean.startsWith("file://") && clean.includes("/data/media/")) {
    const [, suffix] = clean.split("/data/media/");
    const [itemId, fileName] = suffix?.split("/") ?? [];
    if (itemId && fileName) return `${ATLAS_API}/media/${encodeURIComponent(itemId)}/${encodeURIComponent(fileName)}`;
  }
  // Browsers refuse local file URLs. Until the backend migrates an old record,
  // fail closed and let the card render its neutral image fallback.
  if (clean.startsWith("file://")) return "";
  return clean;
}

function atlasHasSize(item: AtlasItem, requestedSize: string) {
  if (!item.sizeAvailabilityKnown || item.stockStatus !== "in_stock" || atlasIsStale(item.sizesCheckedAt)) return false;
  const wanted = atlasNormalizedSize(requestedSize);
  return item.sizes.some((size) => atlasNormalizedSize(size) === wanted);
}

function atlasApiToItem(item: AtlasApiProduct, index = 0): AtlasItem {
  const attributes = item.attributes ?? {};
  const rawScore = item.scores?.visual_match ?? item.scores?.style_match ?? 50;
  const reason = typeof attributes.visual_reason === "string" ? attributes.visual_reason
    : typeof attributes.selectionReason === "string" ? attributes.selectionReason : undefined;
  const sizes = Array.isArray(item.sizes) ? item.sizes : [];
  const images = (item.images ?? []).map(atlasBrowserImage).filter(Boolean);
  const stockStatus = item.stockStatus === "available" ? "in_stock"
    : item.stockStatus === "sold_out" ? "out_of_stock"
      : item.stockStatus ?? (item.kind === "shop" ? "unknown" : "not_applicable");
  const sizeAvailabilityKnown = attributes.sizeAvailabilityKnown === true || typeof item.sizesCheckedAt === "string"
    || ["in_stock", "out_of_stock"].includes(stockStatus);
  const annotations = item.annotations ?? {};
  const returnsLabel = attributes.returnsLabel ?? annotations.returnsLabel ?? annotations.returnPolicy;
  const returnsWindowDays = attributes.returnsWindowDays ?? annotations.returnsWindowDays ?? annotations.returnWindowDays;
  const x = typeof item.x === "number" ? (item.x <= 1 ? item.x * 100 : item.x) : (index * 17) % 100;
  const y = typeof item.y === "number" ? (item.y <= 1 ? item.y * 100 : item.y) : (index * 29) % 100;
  return {
    id: String(item.id), brand: item.brand ?? "Unknown", name: item.name ?? "Article sans nom",
    price: typeof item.price === "number" ? item.price : null,
    originalPrice: typeof item.originalPrice === "number" ? item.originalPrice : null,
    currency: item.currency ?? "CHF", color: item.color ?? "Inconnue", category: item.category ?? "Autre",
    fit: item.fit ?? "unknown", score: Math.round(rawScore <= 1 ? rawScore * 100 : rawScore), x, y, crop: "center",
    image: images[0], images, url: item.url, reason,
    kind: item.kind ?? "shop", decision: item.decision ?? (item.kind === "owned" ? "owned" : "unseen"),
    source: item.source ?? "local", materials: item.materials ?? [], sizes, tags: item.tags ?? [], scores: item.scores, attributes,
    sizeAvailabilityKnown, available: item.available ?? stockStatus === "in_stock",
    // Do not infer stock from the mere presence of a size list. Exact-size
    // filtering is intentionally gated by the canonical in_stock status.
    stockStatus,
    stockCheckedAt: item.stockCheckedAt, priceCheckedAt: item.priceCheckedAt,
    sizesCheckedAt: item.sizesCheckedAt, updatedAt: item.updatedAt,
    returnsLabel: typeof returnsLabel === "string" ? returnsLabel : undefined,
    returnsWindowDays: typeof returnsWindowDays === "number" ? returnsWindowDays : undefined,
    imageAspectRatio: typeof attributes.imageAspectRatio === "number" ? attributes.imageAspectRatio : undefined,
  };
}

function atlasMergeItems(items: AtlasApiProduct[], existing: AtlasItem[]): AtlasItem[] {
  const known = new Map(existing.map((item) => [item.id, item]));
  return items.map((raw, index) => {
    const incoming = atlasApiToItem(raw, index);
    const previous = known.get(incoming.id);
    if (!previous) return incoming;
    return {
      ...previous, ...incoming, decision: raw.decision ?? previous.decision,
      stockCheckedAt: raw.stockCheckedAt ?? previous.stockCheckedAt,
      priceCheckedAt: raw.priceCheckedAt ?? previous.priceCheckedAt,
      sizesCheckedAt: raw.sizesCheckedAt ?? previous.sizesCheckedAt,
    };
  });
}

function atlasAxisValue(item: AtlasItem, field: AxisField, fallback: "x" | "y") {
  if (field === "price") return item.price ?? Number.MAX_SAFE_INTEGER;
  if (field === "score") return 100 - item.score;
  return item[fallback];
}

function atlasArrange(items: AtlasItem[], xAxis: AxisField, yAxis: AxisField) {
  return [...items].sort((left, right) => atlasAxisValue(left, yAxis, "y") - atlasAxisValue(right, yAxis, "y")
    || atlasAxisValue(left, xAxis, "x") - atlasAxisValue(right, xAxis, "x"));
}

type AtlasSpaceLayout = {
  width: number;
  height: number;
  positions: Map<string, { left: number; top: number; width: number; height: number }>;
};

type AtlasPackingNode = { x: number; y: number; width: number; height: number; hash: number };

/** Returns a deterministic, bounded set of nearby pairs from a center-point spatial hash. */
function atlasPackingPairs(nodes: AtlasPackingNode[], cellSize: number, iteration: number, samplesPerCell = 12) {
  const buckets = new Map<string, number[]>();
  const cell = (value: number) => Math.floor(value / cellSize);
  nodes.forEach((node, index) => {
    const key = `${cell(node.x)}:${cell(node.y)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index); else buckets.set(key, [index]);
  });
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    const column = cell(node.x);
    const row = cell(node.y);
    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        const bucket = buckets.get(`${column + deltaX}:${row + deltaY}`);
        if (!bucket?.length) continue;
        const start = Math.abs(node.hash + iteration * 37 + deltaX * 11 + deltaY * 19) % bucket.length;
        const sampleCount = Math.min(bucket.length, samplesPerCell + 1);
        for (let sample = 0; sample < sampleCount; sample += 1) {
          const neighbour = bucket[(start + sample) % bucket.length];
          if (neighbour === index) continue;
          const left = Math.min(index, neighbour);
          const right = Math.max(index, neighbour);
          const key = `${left}:${right}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push([left, right]);
        }
      }
    }
  });
  return pairs;
}

function atlasAxisPositions(items: AtlasItem[], field: AxisField, fallback: "x" | "y") {
  const values = items.map((item) => atlasAxisValue(item, field, fallback));
  const ranks = new Map<number, number>();
  [...values].sort((left, right) => left - right).forEach((value, index) => {
    if (!ranks.has(value)) ranks.set(value, index);
  });
  const denominator = Math.max(1, values.length - 1);
  const rankPositions = values.map((value) => (ranks.get(value) ?? 0) / denominator);
  if (field === "pca") {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const spread = maximum - minimum || 1;
    // A partial quantile transform compresses giant empty PCA gaps without
    // destroying the continuous order and local visual neighbourhoods.
    return values.map((value, index) => ((value - minimum) / spread) * .05 + rankPositions[index] * .95);
  }
  return rankPositions;
}

/** Packs rectangles continuously around their X/Y anchors without grid slots. */
function atlasSpaceLayout(items: AtlasItem[], xAxis: AxisField, yAxis: AxisField, viewportWidth: number, viewportHeight: number, imageMode: AtlasImageMode): AtlasSpaceLayout {
  if (items.length === 0) return { width: viewportWidth, height: viewportHeight, positions: new Map() };
  const viewportRatio = viewportWidth > 0 && viewportHeight > 0
    ? Math.min(2.1, Math.max(1.35, viewportWidth / viewportHeight))
    : 1.7;
  const xPositions = atlasAxisPositions(items, xAxis, "x");
  const yPositions = atlasAxisPositions(items, yAxis, "y");
  const nominalArea = imageMode === "cropped" ? 7_400 : 10_800;
  const maximumArea = nominalArea * (imageMode === "cropped" ? 2.5 : 3);
  const maximumSide = imageMode === "cropped" ? 220 : 280;
  const gap = imageMode === "cropped" ? .6 : 1.5;
  // The collision boundary itself also accounts for the regular 1.2x hover,
  // so a fully grown edge card retains roughly 16px of visible breathing room.
  const padding = 16 + maximumSide * .1;
  // Keep the first/last PCA anchors away from the physical canvas boundary.
  // Edge cards can then grow in every direction just like central cards, and
  // their 1.2x natural-ratio preview still has room inside the board.
  const edgeGrowthReserve = padding + maximumSide * .6;
  const targetArea = items.length * nominalArea / .9;
  const plotWidth = Math.max(viewportWidth * 1.65, Math.sqrt(targetArea * viewportRatio));
  const plotHeight = Math.max(viewportHeight * 1.65, Math.sqrt(targetArea / viewportRatio));
  const baseWidth = plotWidth + edgeGrowthReserve * 2;
  const baseHeight = plotHeight + edgeGrowthReserve * 2;
  const nodes = items.map((item, index) => {
    const hash = [...item.id].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) | 0, 0);
    const aspect = Math.min(2.6, Math.max(.38, imageMode === "full" ? item.imageAspectRatio ?? (item.source === "aliexpress" ? 1 : .72) : 1));
    const seed = imageMode === "cropped" ? 18 : 20;
    const width = imageMode === "full" ? (aspect >= 1 ? seed * aspect : seed) : seed;
    const height = imageMode === "full" ? (aspect >= 1 ? seed : seed / aspect) : seed;
    const targetX = edgeGrowthReserve + width / 2 + xPositions[index] * Math.max(1, plotWidth - width);
    const targetY = edgeGrowthReserve + height / 2 + yPositions[index] * Math.max(1, plotHeight - height);
    return {
      id: item.id, width, height, aspect, hash, targetX, targetY,
      x: targetX + (((hash & 31) / 31) - .5) * 8,
      y: targetY + ((((hash >>> 5) & 31) / 31) - .5) * 8,
    };
  });

  // Negative magnetism: spread coincident PCA anchors before rectangles grow.
  const minimumCenterDistance = imageMode === "cropped" ? 56 : 68;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    let moved = false;
    for (const [leftIndex, rightIndex] of atlasPackingPairs(nodes, minimumCenterDistance, iteration)) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      let deltaX = right.x - left.x;
      let deltaY = right.y - left.y;
      let distance = Math.hypot(deltaX, deltaY);
      if (distance >= minimumCenterDistance) continue;
      if (distance < .001) {
        const angle = ((left.hash ^ right.hash) >>> 0) / 0xffffffff * Math.PI * 2;
        deltaX = Math.cos(angle); deltaY = Math.sin(angle); distance = 1;
      }
      const push = (minimumCenterDistance - distance) * .51;
      const unitX = deltaX / distance;
      const unitY = deltaY / distance;
      left.x -= unitX * push; left.y -= unitY * push;
      right.x += unitX * push; right.y += unitY * push;
      moved = true;
    }
    nodes.forEach((node) => {
      node.x += (node.targetX - node.x) * .008;
      node.y += (node.targetY - node.y) * .008;
      node.x = Math.min(baseWidth - padding - node.width / 2, Math.max(padding + node.width / 2, node.x));
      node.y = Math.min(baseHeight - padding - node.height / 2, Math.max(padding + node.height / 2, node.y));
    });
    if (!moved) break;
  }

  // Resolve the last seed-rectangle collisions left by elongated natural ratios.
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let moved = false;
    for (const [leftIndex, rightIndex] of atlasPackingPairs(nodes, minimumCenterDistance, iteration + 64, 16)) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const deltaX = right.x - left.x;
      const deltaY = right.y - left.y;
      const overlapX = (left.width + right.width) / 2 + gap - Math.abs(deltaX);
      const overlapY = (left.height + right.height) / 2 + gap - Math.abs(deltaY);
      if (overlapX <= 0 || overlapY <= 0) continue;
      if (overlapX < overlapY) {
        const direction = deltaX === 0 ? ((left.hash ^ right.hash) & 1 ? 1 : -1) : Math.sign(deltaX);
        left.x -= direction * overlapX * .51; right.x += direction * overlapX * .51;
      } else {
        const direction = deltaY === 0 ? ((left.hash ^ right.hash) & 1 ? 1 : -1) : Math.sign(deltaY);
        left.y -= direction * overlapY * .51; right.y += direction * overlapY * .51;
      }
      moved = true;
    }
    nodes.forEach((node) => {
      node.x = Math.min(baseWidth - padding - node.width / 2, Math.max(padding + node.width / 2, node.x));
      node.y = Math.min(baseHeight - padding - node.height / 2, Math.max(padding + node.height / 2, node.y));
    });
    if (!moved) break;
  }

  const bucketSize = 128;
  const buckets = new Map<string, Set<number>>();
  const bucketKeys = (node: (typeof nodes)[number], x = node.x, y = node.y, width = node.width, height = node.height) => {
    const keys: string[] = [];
    const minimumColumn = Math.floor((x - width / 2 - gap) / bucketSize);
    const maximumColumn = Math.floor((x + width / 2 + gap) / bucketSize);
    const minimumRow = Math.floor((y - height / 2 - gap) / bucketSize);
    const maximumRow = Math.floor((y + height / 2 + gap) / bucketSize);
    for (let row = minimumRow; row <= maximumRow; row += 1) {
      for (let column = minimumColumn; column <= maximumColumn; column += 1) keys.push(`${column}:${row}`);
    }
    return keys;
  };
  const addToBuckets = (index: number) => {
    for (const key of bucketKeys(nodes[index])) {
      const bucket = buckets.get(key);
      if (bucket) bucket.add(index); else buckets.set(key, new Set([index]));
    }
  };
  const removeFromBuckets = (index: number) => {
    for (const key of bucketKeys(nodes[index])) {
      const bucket = buckets.get(key);
      bucket?.delete(index);
      if (bucket?.size === 0) buckets.delete(key);
    }
  };
  nodes.forEach((_, index) => addToBuckets(index));
  const fits = (index: number, x: number, y: number, width: number, height: number) => {
    if (x - width / 2 < padding || x + width / 2 > baseWidth - padding
      || y - height / 2 < padding || y + height / 2 > baseHeight - padding) return false;
    const neighbours = new Set<number>();
    for (const key of bucketKeys(nodes[index], x, y, width, height)) {
      for (const neighbour of buckets.get(key) ?? []) if (neighbour !== index) neighbours.add(neighbour);
    }
    for (const neighbour of neighbours) {
      const other = nodes[neighbour];
      if (Math.abs(other.x - x) < (other.width + width) / 2 + gap
        && Math.abs(other.y - y) < (other.height + height) / 2 + gap) return false;
    }
    return true;
  };

  const resize = (index: number, x: number, y: number, width: number, height: number) => {
    if (width * height > maximumArea || width > maximumSide || height > maximumSide) return false;
    if (!fits(index, x, y, width, height)) return false;
    removeFromBuckets(index);
    Object.assign(nodes[index], { x, y, width, height });
    addToBuckets(index);
    return true;
  };
  const order = nodes.map((_, index) => index).sort((left, right) => nodes[left].hash - nodes[right].hash);
  for (const step of [6, 2, .5]) {
    for (let round = 0; round < 180; round += 1) {
      let grew = false;
      if (imageMode === "full") {
        for (let offset = 0; offset < order.length; offset += 1) {
          const index = order[(offset + round * 17) % order.length];
          const node = nodes[index];
          grew = resize(index, node.x, node.y, node.width + step * node.aspect, node.height + step) || grew;
        }
      } else {
        for (let phase = 0; phase < 4; phase += 1) {
          for (let offset = 0; offset < order.length; offset += 1) {
            const index = order[(offset + round * 17 + phase * 31) % order.length];
            const node = nodes[index];
            const direction = (phase + (node.hash & 3)) % 4;
            let x = node.x;
            let y = node.y;
            let width = node.width;
            let height = node.height;
            if (direction === 0) { x -= step / 2; width += step; }
            if (direction === 1) { x += step / 2; width += step; }
            if (direction === 2) { y -= step / 2; height += step; }
            if (direction === 3) { y += step / 2; height += step; }
            const ratio = width / height;
            if (ratio < .32 || ratio > 3.1) continue;
            grew = resize(index, x, y, width, height) || grew;
          }
        }
      }
      if (!grew) break;
    }
  }

  const positions = new Map(nodes.map((node) => [node.id, {
    left: node.x, top: node.y, width: node.width, height: node.height,
  }]));

  return { width: baseWidth, height: baseHeight, positions };
}

function atlasSpaceCardStyle(item: AtlasItem, layout: AtlasSpaceLayout): CSSProperties {
  const position = layout.positions.get(item.id) ?? { left: layout.width / 2, top: layout.height / 2, width: 82, height: 108 };
  return {
    left: position.left,
    top: position.top,
    "--card-width": `${position.width}px`,
    "--card-height": `${position.height}px`,
  } as CSSProperties;
}

function atlasTimestamp(value?: string | null) {
  if (!value) return "jamais vérifié";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date inconnue";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "à l’instant";
  if (seconds < 3600) return `il y a ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.round(seconds / 3600)} h`;
  return `il y a ${Math.round(seconds / 86400)} j`;
}

function mosaicCompactRunError(value?: string | null) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  const sample = compact.slice(0, 600);
  const encodedRatio = sample.length
    ? (sample.match(/[A-Za-z0-9+/=]/g)?.length ?? 0) / sample.length
    : 0;
  if (compact.length > 600 && encodedRatio > .94) return "détails techniques masqués";
  return compact.length > 220 ? `${compact.slice(0, 217)}…` : compact;
}

function atlasCooldownTimestamp(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("fr-CH", {
    timeZone: "Europe/Zurich",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function atlasIsStale(value?: string | null, days = 2) {
  if (!value) return true;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || Date.now() - time > days * 86400000;
}

async function atlasReadImages(files: File[], existingCount = 0, personal = false): Promise<AtlasPromptImage[]> {
  const images = files.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, ATLAS_MAX_IMAGES - existingCount));
  if (images.some((file) => file.size > (personal ? ATLAS_MAX_IMAGE_BYTES : 12 * 1024 * 1024))) {
    throw new Error(personal ? "Chaque image doit faire moins de 8 MB" : "Chaque image doit faire moins de 12 MB");
  }
  if (personal && images.reduce((sum, file) => sum + file.size, 0) > ATLAS_MAX_TOTAL_BYTES) throw new Error("Les images dépassent 24 MB au total");
  return Promise.all(images.map((file) => new Promise<AtlasPromptImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}`));
    reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name || "image collée", dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  })));
}

function atlasNormalizeView(raw: Partial<AtlasSavedView> & { state?: Partial<AtlasSavedView> }): AtlasSavedView {
  const value = { ...raw.state, ...raw };
  const legacySize = typeof value.sizeFilter === "string" && !["all", "known"].includes(value.sizeFilter)
    ? atlasNormalizedSize(value.sizeFilter) : null;
  const sizeFilters = [...new Set((Array.isArray(value.sizeFilters) ? value.sizeFilters : legacySize ? [legacySize] : [])
    .filter((size): size is string => typeof size === "string" && Boolean(size.trim()))
    .map(atlasNormalizedSize))];
  return {
    id: String(value.id ?? crypto.randomUUID()), name: value.name ?? "Vue sans nom", scope: value.scope ?? "catalogue",
    activeFilter: value.activeFilter ?? "Tout", sourceFilter: value.sourceFilter ?? "all", priceFilter: value.priceFilter ?? "all",
    fitFilter: value.fitFilter ?? "all", materialFilter: value.materialFilter ?? "all", sizeFilters,
    sizeFilter: sizeFilters.length === 1 ? sizeFilters[0] : "all",
    stockFilter: value.stockFilter ?? "all", attributeQuery: value.attributeQuery ?? "", minPrice: value.minPrice ?? "",
    maxPrice: value.maxPrice ?? "", includeRejected: value.includeRejected ?? false, xAxis: value.xAxis ?? "pca",
    selectedCollectionId: typeof value.selectedCollectionId === "string" ? value.selectedCollectionId : null,
    dynamicFacetSelections: value.dynamicFacetSelections && typeof value.dynamicFacetSelections === "object" ? value.dynamicFacetSelections : {},
    dynamicNumberFilters: value.dynamicNumberFilters && typeof value.dynamicNumberFilters === "object" ? value.dynamicNumberFilters : {},
    yAxis: value.yAxis ?? "pca", mode: value.mode ?? "space", imageMode: value.imageMode === "full" ? "full" : "cropped",
  };
}

function atlasDecisionLabel(decision: AtlasDecision) {
  return { unseen: "À voir", saved: "Gardé", rejected: "Rejeté", owned: "Possédé" }[decision];
}

function mosaicBrandLabel(item: AtlasItem, clothingProfile: boolean) {
  return !clothingProfile && item.kind === "owned" && item.brand === "Mon dressing" ? "Élément local" : item.brand;
}

function mosaicNormalizeCollection(raw: Partial<MosaicCollection> & { items?: Array<string | { id?: string }> }): MosaicCollection {
  const ids = Array.isArray(raw.itemIds) ? raw.itemIds : (raw.items ?? []).map((item) => typeof item === "string" ? item : item.id).filter(Boolean) as string[];
  return {
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? "Collection sans nom"),
    description: typeof raw.description === "string" ? raw.description : undefined,
    color: typeof raw.color === "string" ? raw.color : undefined,
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    itemIds: [...new Set(ids.map(String))],
  };
}

function mosaicNormalizeArtifact(raw: Partial<MosaicArtifact>): MosaicArtifact {
  const provenanceImages = raw.provenance?.imageReferences;
  const imageReferences = raw.localFiles?.length ? raw.localFiles
    : Array.isArray(raw.imageReferences) ? raw.imageReferences
    : Array.isArray(provenanceImages) ? provenanceImages.map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" && "name" in entry ? String(entry.name) : "Référence visuelle")
      : raw.localFiles ?? [];
  return {
    ...raw,
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? "Brouillon sans nom"),
    itemIds: [...new Set((raw.itemIds ?? raw.inputItemIds ?? []).map(String))],
    imageReferences,
  };
}

function mosaicNormalizeWorkspaceSchema(payload: Partial<MosaicWorkspaceSchema>): MosaicWorkspaceSchema {
  const fields = (Array.isArray(payload.fields) ? payload.fields : []).map((field) => ({
    ...field,
    options: (field.options ?? []).map((option) => typeof option === "object" && option !== null
      ? { value: String(option.value), label: option.label ? String(option.label) : undefined }
      : String(option)),
  })).sort((left, right) => (left.displayOrder ?? 999) - (right.displayOrder ?? 999));
  const facets = Object.fromEntries(Object.entries(payload.facets ?? {}).map(([key, values]) => [key, (Array.isArray(values) ? values : []).map((facet) => ({
    value: String(facet.value), label: facet.label ? String(facet.label) : undefined, count: Number(facet.count) || 0,
  }))]));
  return { workspace: payload.workspace, fields, facets };
}

function mosaicFieldValue(item: AtlasItem, key: string): unknown {
  const topLevel: Record<string, unknown> = {
    id: item.id, brand: item.brand, name: item.name, price: item.price, originalPrice: item.originalPrice,
    currency: item.currency, color: item.color, category: item.category, fit: item.fit, score: item.score,
    source: item.source, materials: item.materials, sizes: item.sizes, tags: item.tags, decision: item.decision,
    kind: item.kind, stockStatus: item.stockStatus, available: item.available, stockCheckedAt: item.stockCheckedAt,
    priceCheckedAt: item.priceCheckedAt, sizesCheckedAt: item.sizesCheckedAt, updatedAt: item.updatedAt,
    returnsLabel: item.returnsLabel, returnsWindowDays: item.returnsWindowDays,
  };
  if (Object.prototype.hasOwnProperty.call(topLevel, key)) return topLevel[key];

  const unsafe = (value?: string) => !value || ["__proto__", "prototype", "constructor"].includes(value);
  const [namespace, field, ...rest] = key.split(".");
  if (field === undefined) return unsafe(namespace) ? undefined : item.attributes?.[key];
  if (rest.length || unsafe(field)) return undefined;
  if (namespace === "attributes") return item.attributes?.[field];
  if (namespace === "scores") return item.scores?.[field];
  return undefined;
}

function mosaicFieldDisplayValue(item: AtlasItem, field: MosaicFieldDefinition) {
  const raw = mosaicFieldValue(item, field.key);
  if (raw === null || raw === undefined || raw === "") return null;
  const values = Array.isArray(raw) ? raw : [raw];
  const formatted = values.map((value) => {
    if (typeof value === "boolean") return value ? "Oui" : "Non";
    if (typeof value === "number") return `${value}${field.unit ? ` ${field.unit}` : ""}`;
    return String(value);
  }).filter(Boolean);
  return formatted.length ? formatted.join(" · ") : null;
}

function mosaicSummaryText(summary: AtlasAssistantResponse["summary"]): string | undefined {
  if (typeof summary === "string") return summary;
  if (!summary || typeof summary !== "object") return undefined;
  const count = typeof summary.count === "number" ? `${summary.count} élément${summary.count > 1 ? "s" : ""}` : "Comparaison prête";
  const price = summary.price && typeof summary.price === "object" ? summary.price as Record<string, unknown> : null;
  const priceText = price && typeof price.min === "number" && typeof price.max === "number"
    ? ` · ${price.min}–${price.max} ${typeof price.currency === "string" ? price.currency : ""}` : "";
  return `${count}${priceText}`.trim();
}

export default function Home() {
  const [scope, setScope] = useState<AtlasScope>("catalogue");
  const [activeFilter, setActiveFilter] = useState("Tout");
  const [mode, setMode] = useState<"space" | "grid">("space");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiStatus, setAiStatus] = useState("");
  const [catalogItems, setCatalogItems] = useState<AtlasItem[]>(atlasSeedItems);
  const [aiItems, setAiItems] = useState<AtlasItem[] | null>(null);
  const [catalogStatus, setCatalogStatus] = useState("démo locale");
  const [visualMode, setVisualMode] = useState<"sequential" | "sheet">("sequential");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium">("low");
  const [promptImages, setPromptImages] = useState<AtlasPromptImage[]>([]);
  const [promptProductIds, setPromptProductIds] = useState<string[]>([]);
  const [promptCollectionIds, setPromptCollectionIds] = useState<string[]>([]);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantDropActive, setAssistantDropActive] = useState(false);
  const [xAxis, setXAxis] = useState<AxisField>("pca");
  const [yAxis, setYAxis] = useState<AxisField>("pca");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [priceFilter, setPriceFilter] = useState("all");
  const [fitFilter, setFitFilter] = useState("all");
  const [materialFilter, setMaterialFilter] = useState("all");
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [imageMode, setImageMode] = useState<AtlasImageMode>("cropped");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [stockFilter, setStockFilter] = useState("all");
  const [attributeQuery, setAttributeQuery] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [includeRejected, setIncludeRejected] = useState(false);
  const [zoom, setZoom] = useState(ATLAS_DEFAULT_ZOOM);
  const [dragging, setDragging] = useState(false);
  const [atlasViewport, setAtlasViewport] = useState({ width: 1000, height: 650 });
  const [atlasView, setAtlasView] = useState({ left: 0, top: 0, width: 1000, height: 650 });
  const [drawer, setDrawer] = useState<AtlasDrawer>(null);
  const [previewItem, setPreviewItem] = useState<AtlasItem | null>(null);
  const [compareIds, setCompareIds] = useState<Set<string>>(() => new Set());
  const [outfitDraftIds, setOutfitDraftIds] = useState<Set<string>>(() => new Set());
  const [savedViews, setSavedViews] = useState<AtlasSavedView[]>([]);
  const [outfitBoards, setOutfitBoards] = useState<AtlasOutfitBoard[]>([]);
  const [selectedOutfitBoardId, setSelectedOutfitBoardId] = useState<string | null>(null);
  const [viewName, setViewName] = useState("");
  const [outfitName, setOutfitName] = useState("");
  const [undoStack, setUndoStack] = useState<AtlasUndoAction[]>([]);
  const [toast, setToast] = useState("");
  const [refreshJob, setRefreshJob] = useState<AtlasAcquisitionJob | null>(null);
  const [refreshRecovered, setRefreshRecovered] = useState(false);
  const [discoveryPlan, setDiscoveryPlan] = useState<AtlasDiscoveryPlan | null>(null);
  const [discoveryJobs, setDiscoveryJobs] = useState<AtlasDiscoveryJob[]>([]);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryRecovered, setDiscoveryRecovered] = useState(false);
  const [renderWindow, setRenderWindow] = useState({ signature: "", limit: ATLAS_PAGE_SIZE });
  const [personalKind, setPersonalKind] = useState<"owned" | "reference" | "shop">("owned");
  const [personalImages, setPersonalImages] = useState<AtlasPromptImage[]>([]);
  const [personalBusy, setPersonalBusy] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [mosaicCollections, setMosaicCollections] = useState<MosaicCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [collectionName, setCollectionName] = useState("");
  const [workspaceSchema, setWorkspaceSchema] = useState<MosaicWorkspaceSchema | null>(null);
  const [dynamicFacetSelections, setDynamicFacetSelections] = useState<Record<string, string[]>>({});
  const [dynamicNumberFilters, setDynamicNumberFilters] = useState<Record<string, { min: string; max: string }>>({});
  const [mosaicRuns, setMosaicRuns] = useState<MosaicRun[]>([]);
  const [embeddingJob, setEmbeddingJob] = useState<MosaicEmbeddingJob | null>(null);
  const [mosaicWorkspaces, setMosaicWorkspaces] = useState<MosaicWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceProfile, setNewWorkspaceProfile] = useState("generic");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [collectionsApiAvailable, setCollectionsApiAvailable] = useState(false);
  const [mosaicArtifacts, setMosaicArtifacts] = useState<MosaicArtifact[]>([]);
  const [artifactName, setArtifactName] = useState("");
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [artifactsApiAvailable, setArtifactsApiAvailable] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(true);
  const [onboardingVisible, setOnboardingVisible] = useState(false);

  const atlasElementRef = useRef<HTMLDivElement>(null);
  const atlasCanvasRef = useRef<HTMLDivElement>(null);
  const atlasSceneRef = useRef<HTMLDivElement>(null);
  const atlasImageInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const personalImageInputRef = useRef<HTMLInputElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const atlasMinimapRef = useRef<HTMLCanvasElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const previewDialogRef = useRef<HTMLElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const atlasZoomRef = useRef(ATLAS_DEFAULT_ZOOM);
  const atlasZoomFrameRef = useRef<number | null>(null);
  const atlasScrollTimerRef = useRef<number | null>(null);
  const atlasLastCullAtRef = useRef(0);
  const atlasPendingZoomCommitRef = useRef(false);
  const atlasViewRef = useRef({ left: 0, top: 0, width: 1000, height: 650 });
  const atlasZoomScrollRef = useRef<{ left: number; top: number } | null>(null);
  const atlasDragRef = useRef<{ x: number; y: number; left: number; top: number; pointerId: number; captured: boolean; lastX: number; lastY: number; lastAt: number; velocityX: number; velocityY: number } | null>(null);
  const atlasInertiaFrameRef = useRef<number | null>(null);
  const atlasSuppressClickRef = useRef(false);
  const atlasDraggingRef = useRef(false);
  const atlasHoverTimerRef = useRef<number | null>(null);
  const atlasHoverCardRef = useRef<HTMLElement | null>(null);
  const atlasLayoutCacheRef = useRef(new Map<string, AtlasSpaceLayout>());
  const discoveryMonitorRef = useRef(0);
  const activeWorkspaceIdRef = useRef("");
  const workspaceEpochRef = useRef(0);
  const workspaceAbortRef = useRef(new AbortController());

  const captureWorkspaceOperation = useCallback((): MosaicWorkspaceOperation => ({
    workspaceId: activeWorkspaceIdRef.current,
    epoch: workspaceEpochRef.current,
    signal: workspaceAbortRef.current.signal,
  }), []);

  const isWorkspaceOperationCurrent = useCallback((operation: MosaicWorkspaceOperation) => (
    !operation.signal.aborted
    && operation.epoch === workspaceEpochRef.current
    && operation.workspaceId === activeWorkspaceIdRef.current
  ), []);

  const resetMosaicWorkspaceState = useCallback((workspaceId: string) => {
    setScope("catalogue"); setDrawer(null); setPreviewItem(null); setCompareIds(new Set()); setOutfitDraftIds(new Set()); setUndoStack([]);
    setAiPrompt(""); setAiStatus(""); setAiItems(null); setCatalogItems([]); setPromptImages([]); setPromptProductIds([]); setPromptCollectionIds([]);
    setAssistantBusy(false); setAssistantDropActive(false); setSavedViews([]); setViewName(""); setOutfitBoards([]); setOutfitName(""); setSelectedOutfitBoardId(null);
    setMosaicCollections([]); setCollectionName(""); setMosaicArtifacts([]); setArtifactName(""); setMosaicRuns([]); setSelectedIds(new Set()); setFocusedIndex(0);
    setRefreshJob(null); setRefreshRecovered(false); setDiscoveryPlan(null); setDiscoveryJobs([]); setDiscoveryRecovered(false); setDiscoveryBusy(false);
    setWorkspaceSchema(null); setCatalogStatus(workspaceId ? "chargement…" : "aucun espace actif"); setSelectedCollectionId(null);
    setActiveFilter("Tout"); setSourceFilter("all"); setPriceFilter("all"); setFitFilter("all"); setMaterialFilter("all"); setSelectedSizes(["M", "L"]);
    setStockFilter("all"); setAttributeQuery(""); setMinPrice(""); setMaxPrice(""); setIncludeRejected(false); setDynamicFacetSelections({}); setDynamicNumberFilters({});
    setPersonalKind("owned"); setPersonalImages([]); setPersonalBusy(false); setArtifactBusy(false); setWorkspaceBusy(false); setCollectionsApiAvailable(false); setArtifactsApiAvailable(false);
    setComposerExpanded(true); setXAxis("pca"); setYAxis("pca"); setRenderWindow({ signature: "", limit: ATLAS_PAGE_SIZE }); setToast("");
    atlasLayoutCacheRef.current.clear();
    previewReturnFocusRef.current = null; drawerReturnFocusRef.current = null;
    const atlas = atlasElementRef.current;
    if (atlas) { atlas.scrollLeft = 0; atlas.scrollTop = 0; }
  }, []);

  function switchMosaicWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceIdRef.current) return;
    workspaceAbortRef.current.abort();
    workspaceEpochRef.current += 1;
    activeWorkspaceIdRef.current = workspaceId;
    discoveryMonitorRef.current += 1;
    resetMosaicWorkspaceState(workspaceId);
    setActiveWorkspaceId(workspaceId);
  }

  async function reloadAtlasCatalog(operation = captureWorkspaceOperation()) {
    const response = await fetch(atlasWorkspaceApiUrl("/products?limit=10000", operation.workspaceId), { signal: operation.signal });
    if (!response.ok) throw new Error("catalog unavailable");
    const items = await response.json() as AtlasApiProduct[];
    if (!isWorkspaceOperationCurrent(operation)) return;
    setCatalogItems(items.map(atlasApiToItem));
    setAiItems(null);
    setCatalogStatus("catalogue local");
  }

  async function retryAtlasCatalog() {
    const operation = captureWorkspaceOperation();
    try { await reloadAtlasCatalog(operation); }
    catch { if (isWorkspaceOperationCurrent(operation)) setToast("L’API locale ne répond pas encore"); }
  }

  async function reloadMosaicArtifactsAndRuns(operation = captureWorkspaceOperation()) {
    if (!isWorkspaceOperationCurrent(operation)) return [] as MosaicArtifact[];
    const [artifactsResult, runsResult] = await Promise.allSettled([
      fetch(atlasWorkspaceApiUrl("/artifacts?limit=50", operation.workspaceId), { signal: operation.signal }).then(async (response) => {
        if (!response.ok) throw new Error("artifacts unavailable");
        const payload = await response.json() as MosaicArtifact[] | { artifacts?: MosaicArtifact[] };
        return (Array.isArray(payload) ? payload : payload.artifacts ?? []).map(mosaicNormalizeArtifact);
      }),
      fetch(atlasWorkspaceApiUrl("/runs?limit=50", operation.workspaceId), { signal: operation.signal }).then(async (response) => {
        if (!response.ok) throw new Error("runs unavailable");
        const payload = await response.json() as MosaicRun[] | { runs?: MosaicRun[] };
        return Array.isArray(payload) ? payload : payload.runs ?? [];
      }),
    ]);
    if (!isWorkspaceOperationCurrent(operation)) return [] as MosaicArtifact[];
    if (runsResult.status === "fulfilled") setMosaicRuns(runsResult.value);
    if (artifactsResult.status === "rejected") throw artifactsResult.reason;
    setMosaicArtifacts(artifactsResult.value);
    setArtifactsApiAvailable(true);
    return artifactsResult.value;
  }

  useEffect(() => {
    if (embeddingJob?.status !== "running") return;
    const operation = captureWorkspaceOperation();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${ATLAS_API}/embeddings/job`, { signal: operation.signal });
        if (!response.ok) return;
        const next = await response.json() as MosaicEmbeddingJob;
        if (!isWorkspaceOperationCurrent(operation)) return;
        setEmbeddingJob(next);
        if (next.status === "succeeded") {
          const catalogResponse = await fetch(atlasWorkspaceApiUrl("/products?limit=10000", operation.workspaceId), { signal: operation.signal });
          if (catalogResponse.ok) {
            const items = await catalogResponse.json() as AtlasApiProduct[];
            if (!isWorkspaceOperationCurrent(operation)) return;
            setCatalogItems(items.map(atlasApiToItem));
            setAiItems(null);
            setCatalogStatus("catalogue local · placement visuel à jour");
          }
        }
      } catch (error) {
        if (isWorkspaceOperationCurrent(operation) && !(error instanceof DOMException && error.name === "AbortError")) setToast("L’index visuel répondra dans Activité");
      }
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [captureWorkspaceOperation, embeddingJob?.processed, embeddingJob?.status, isWorkspaceOperationCurrent]);

  useEffect(() => {
    const controller = new AbortController();
    const readFallbackCollections = () => {
      try {
        const stored = window.localStorage.getItem(MOSAIC_COLLECTIONS_FALLBACK_KEY);
        if (!stored) return [];
        const parsed = JSON.parse(stored) as Array<Partial<MosaicCollection>>;
        return Array.isArray(parsed) ? parsed.map(mosaicNormalizeCollection) : [];
      } catch { return []; }
    };
    try {
      const dismissed = window.localStorage.getItem(MOSAIC_ONBOARDING_KEY) === "1";
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        setOnboardingVisible(!dismissed);
        setComposerExpanded(!dismissed);
        setMosaicCollections(readFallbackCollections());
        try {
          const stored = window.localStorage.getItem(MOSAIC_ARTIFACTS_FALLBACK_KEY);
          if (stored) setMosaicArtifacts((JSON.parse(stored) as MosaicArtifact[]).map(mosaicNormalizeArtifact));
        } catch { /* optional fallback */ }
      });
    } catch { queueMicrotask(() => { if (!controller.signal.aborted) setOnboardingVisible(true); }); }
    Promise.allSettled([
      fetch(`${ATLAS_API}/workspaces`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as MosaicWorkspace[] | { workspaces?: MosaicWorkspace[] };
        const workspaces = Array.isArray(payload) ? payload : payload.workspaces ?? [];
        setMosaicWorkspaces(workspaces);
        let stored = "";
        try { stored = window.localStorage.getItem(MOSAIC_ACTIVE_WORKSPACE_KEY) ?? ""; } catch { /* optional */ }
        const next = workspaces.find((item) => item.id === stored)?.id ?? workspaces[0]?.id ?? "";
        if (next) setActiveWorkspaceId(next);
      }),
      fetch(`${ATLAS_API}/embeddings/job`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        setEmbeddingJob(await response.json() as MosaicEmbeddingJob);
      }),
    ]);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    workspaceAbortRef.current.abort();
    const controller = new AbortController();
    workspaceAbortRef.current = controller;
    const workspaceId = activeWorkspaceId;
    const epoch = workspaceEpochRef.current + 1;
    workspaceEpochRef.current = epoch;
    activeWorkspaceIdRef.current = workspaceId;
    discoveryMonitorRef.current += 1;
    const operation: MosaicWorkspaceOperation = { workspaceId, epoch, signal: controller.signal };
    const current = () => isWorkspaceOperationCurrent(operation);
    queueMicrotask(() => {
      if (!current()) return;
      resetMosaicWorkspaceState(workspaceId);
    });
    if (!workspaceId) return () => controller.abort();
    try { window.localStorage.setItem(MOSAIC_ACTIVE_WORKSPACE_KEY, workspaceId); } catch { /* optional */ }
    const scoped = (path: string) => atlasWorkspaceApiUrl(path, workspaceId);
    void Promise.allSettled([
      fetch(scoped("/products?limit=10000"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("catalog unavailable");
        const items = await response.json() as AtlasApiProduct[];
        if (!current()) return;
        setCatalogItems(items.map(atlasApiToItem));
        setCatalogStatus("catalogue local");
      }).catch((error) => { if (current() && !(error instanceof DOMException && error.name === "AbortError")) setCatalogStatus("API locale indisponible"); }),
      fetch(scoped("/workspaces/current/ui-schema"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as Partial<MosaicWorkspaceSchema>;
        if (!current()) return;
        setWorkspaceSchema(mosaicNormalizeWorkspaceSchema(payload));
      }),
      fetch(scoped("/collections?limit=100"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as MosaicCollection[] | { collections?: MosaicCollection[] };
        if (!current()) return;
        setMosaicCollections((Array.isArray(payload) ? payload : payload.collections ?? []).map(mosaicNormalizeCollection));
        setCollectionsApiAvailable(true);
      }),
      fetch(scoped("/views"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasSavedView[] | { views?: AtlasSavedView[] };
        if (!current()) return;
        setSavedViews((Array.isArray(payload) ? payload : payload.views ?? []).map(atlasNormalizeView));
      }),
      fetch(scoped("/outfit-boards"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasOutfitBoard[] | { boards?: AtlasOutfitBoard[] };
        if (!current()) return;
        setOutfitBoards(Array.isArray(payload) ? payload : payload.boards ?? []);
      }),
      fetch(scoped("/runs?limit=50"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as MosaicRun[] | { runs?: MosaicRun[] };
        if (!current()) return;
        setMosaicRuns(Array.isArray(payload) ? payload : payload.runs ?? []);
      }),
      fetch(scoped("/artifacts?limit=50"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as MosaicArtifact[] | { artifacts?: MosaicArtifact[] };
        if (!current()) return;
        setMosaicArtifacts((Array.isArray(payload) ? payload : payload.artifacts ?? []).map(mosaicNormalizeArtifact));
        setArtifactsApiAvailable(true);
      }),
      fetch(scoped("/acquisition/jobs?limit=20"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasAcquisitionJob[] | { jobs?: AtlasAcquisitionJob[] };
        if (!current()) return;
        const jobs = Array.isArray(payload) ? payload : payload.jobs ?? [];
        const recoverable = jobs.find((job) => job.canResume && ["queued", "running", "error", "blocked"].includes(job.status));
        if (!recoverable) return;
        setRefreshJob(recoverable);
        setRefreshRecovered(true);
      }),
      fetch(scoped("/discovery/jobs?limit=20"), { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasDiscoveryJob[] | { jobs?: AtlasDiscoveryJob[] };
        if (!current()) return;
        const recentJobs = Array.isArray(payload) ? payload : payload.jobs ?? [];
        if (!recentJobs.length) return;
        let session: AtlasDiscoverySession | null = null;
        try {
          const stored = window.localStorage.getItem(ATLAS_DISCOVERY_SESSION_KEY);
          if (stored) {
            const candidate = JSON.parse(stored) as Partial<AtlasDiscoverySession>;
            if (candidate.plan && Array.isArray(candidate.jobIds)
              && (!candidate.workspaceId || candidate.workspaceId === workspaceId)) {
              session = candidate as AtlasDiscoverySession;
            }
          }
        } catch { /* A stale local session must not hide server-side jobs. */ }
        const jobsById = new Map(recentJobs.map((job) => [job.id, job]));
        const sessionJobs = session?.jobIds.map((id) => jobsById.get(id)).filter(Boolean) as AtlasDiscoveryJob[] | undefined;
        const newestCreatedAt = Date.parse(recentJobs[0]?.createdAt ?? "");
        const fallbackJobs = Number.isFinite(newestCreatedAt)
          ? recentJobs.filter((job) => Math.abs(newestCreatedAt - Date.parse(job.createdAt ?? "")) < 5000).slice(0, 8)
          : recentJobs.slice(0, 1);
        const jobs = sessionJobs?.length ? sessionJobs : fallbackJobs;
        if (!jobs.length) return;
        const plan = sessionJobs?.length && session ? session.plan : {
          id: "recovered", name: "Découverte locale retrouvée", description: "Derniers jobs persistés par source.",
          targetCount: jobs.reduce((sum, job) => sum + (job.intent.maxItems ?? 0), 0), sizes: ["M", "L"], sizeMode: "any" as const,
          searches: jobs.map((job) => job.intent),
        };
        if (!current()) return;
        setDiscoveryPlan(plan);
        setDiscoveryJobs(jobs);
        setDiscoveryRecovered(jobs.some((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status) || ["failed", "blocked"].includes(job.status)));
      }),
    ]);
    return () => controller.abort();
  }, [activeWorkspaceId, isWorkspaceOperationCurrent, resetMosaicWorkspaceState]);

  useEffect(() => {
    let cancelled = false;
    let storedSizes: string[] | null = null;
    let storedImageMode: AtlasImageMode | null = null;
    try {
      const stored = window.localStorage.getItem(ATLAS_PREFERENCES_KEY);
      if (stored) {
        const preferences = JSON.parse(stored) as { selectedSizes?: unknown; imageMode?: unknown };
        if (Array.isArray(preferences.selectedSizes)) {
          storedSizes = [...new Set(preferences.selectedSizes
            .filter((size): size is string => typeof size === "string" && Boolean(size.trim()))
            .map(atlasNormalizedSize))].slice(0, 12);
        }
        if (preferences.imageMode === "cropped" || preferences.imageMode === "full") storedImageMode = preferences.imageMode;
      }
    } catch {
      // Preferences are optional; malformed local data must never block the catalog.
    }
    queueMicrotask(() => {
      if (cancelled) return;
      setSelectedSizes(storedSizes ?? ["M", "L"]);
      if (storedImageMode) setImageMode(storedImageMode);
      setPreferencesReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    try { window.localStorage.setItem(ATLAS_PREFERENCES_KEY, JSON.stringify({ selectedSizes, imageMode })); }
    catch { /* Private browsing or a full quota should not affect the board. */ }
  }, [imageMode, preferencesReady, selectedSizes]);

  const visibleCatalog = aiItems ?? catalogItems;
  const activeOutfitIds = useMemo(() => {
    const selected = outfitBoards.find((board) => board.id === selectedOutfitBoardId);
    return new Set((selected ? [selected] : outfitBoards).flatMap((board) => board.productIds));
  }, [outfitBoards, selectedOutfitBoardId]);
  const activeCollectionIds = useMemo(() => new Set(mosaicCollections.find((collection) => collection.id === selectedCollectionId)?.itemIds ?? []), [mosaicCollections, selectedCollectionId]);

  const scopeCatalog = useMemo(() => visibleCatalog.filter((item) => {
    if (selectedCollectionId && !activeCollectionIds.has(item.id)) return false;
    if (scope === "saved") return item.decision === "saved";
    if (scope === "owned") return item.kind === "owned" || item.decision === "owned";
    if (scope === "reference") return item.kind === "reference";
    if (scope === "outfits") return activeOutfitIds.has(item.id);
    return true;
  }), [activeCollectionIds, activeOutfitIds, scope, selectedCollectionId, visibleCatalog]);

  const catalogBeforeSize = useMemo(() => scopeCatalog.filter((item) => {
    if (!includeRejected && item.decision === "rejected") return false;
    if (sourceFilter === "shop" && item.kind !== "shop") return false;
    if (sourceFilter === "reference" && item.kind !== "reference") return false;
    if (sourceFilter === "owned" && item.kind !== "owned") return false;
    if (sourceFilter === "zalando" && (item.kind !== "shop" || item.source !== "zalando-ch")) return false;
    if (sourceFilter === "aboutyou" && (item.kind !== "shop" || item.source !== "aboutyou-ch")) return false;
    if (sourceFilter === "aliexpress" && (item.kind !== "shop" || item.source !== "aliexpress")) return false;
    if (sourceFilter.startsWith("source:") && (item.kind !== "shop" || item.source !== sourceFilter.slice(7))) return false;
    if (priceFilter !== "all") {
      if (item.price === null) return false;
      if (priceFilter === "under50" && item.price >= 50) return false;
      if (priceFilter === "50to100" && (item.price < 50 || item.price > 100)) return false;
      if (priceFilter === "100to180" && (item.price < 100 || item.price > 180)) return false;
      if (priceFilter === "over180" && item.price <= 180) return false;
    }
    if (minPrice && (item.price === null || item.price < Number(minPrice))) return false;
    if (maxPrice && (item.price === null || item.price > Number(maxPrice))) return false;
    if (fitFilter !== "all" && item.fit.toLocaleLowerCase() !== fitFilter) return false;
    if (materialFilter !== "all") {
      const haystack = `${item.name} ${item.materials.join(" ")}`.toLocaleLowerCase();
      const aliases: Record<string, string[]> = {
        knit: ["maille", "knit", "strick", "laine"], linen: ["lin", "linen"], cotton: ["coton", "cotton"],
        leather: ["cuir", "leather", "leder"], denim: ["denim", "jean"],
      };
      if (!aliases[materialFilter]?.some((term) => haystack.includes(term))) return false;
    }
    if (stockFilter === "available" && (!item.available || item.stockStatus !== "in_stock")) return false;
    if (stockFilter === "stale" && !atlasIsStale(item.stockCheckedAt)) return false;
    if (stockFilter === "fresh" && atlasIsStale(item.stockCheckedAt)) return false;
    if (attributeQuery.trim()) {
      const terms = attributeQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const attributeText = Object.entries(item.attributes ?? {}).flatMap(([key, value]) => [
        key,
        ...(Array.isArray(value) ? value : [value]).map((entry) => entry === null || entry === undefined ? "" : String(entry)),
      ]);
      const haystack = [item.brand, item.name, item.color, item.category, item.fit, item.source, item.reason, ...item.materials, ...item.tags, ...attributeText].join(" ").toLocaleLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    for (const [key, selected] of Object.entries(dynamicFacetSelections)) {
      if (!selected.length) continue;
      const raw = mosaicFieldValue(item, key);
      const values = (Array.isArray(raw) ? raw : [raw]).filter((value) => value !== null && value !== undefined).map((value) => String(value).toLocaleLowerCase());
      const fieldType = workspaceSchema?.fields.find((field) => field.key === key)?.type;
      if (fieldType === "text" || fieldType === "date") {
        if (!selected.every((term) => values.some((value) => value.includes(term.toLocaleLowerCase())))) return false;
      } else if (!selected.some((value) => values.includes(value.toLocaleLowerCase()))) return false;
    }
    for (const [key, range] of Object.entries(dynamicNumberFilters)) {
      if (!range.min && !range.max) continue;
      const value = Number(mosaicFieldValue(item, key));
      if (!Number.isFinite(value)) return false;
      if (range.min && value < Number(range.min)) return false;
      if (range.max && value > Number(range.max)) return false;
    }
    return true;
  }), [attributeQuery, dynamicFacetSelections, dynamicNumberFilters, fitFilter, includeRejected, materialFilter, maxPrice, minPrice, priceFilter, scopeCatalog, sourceFilter, stockFilter, workspaceSchema?.fields]);

  const quickFilteredCatalog = useMemo(() => catalogBeforeSize.filter((item) => {
    const activeProfile = mosaicWorkspaces.find((workspace) => workspace.id === activeWorkspaceId)?.profile ?? workspaceSchema?.workspace?.profile;
    if (activeProfile && activeProfile !== "clothing") return true;
    if (!selectedSizes.length || item.kind !== "shop" || item.decision === "owned") return true;
    return selectedSizes.some((size) => atlasHasSize(item, size));
  }), [activeWorkspaceId, catalogBeforeSize, mosaicWorkspaces, selectedSizes, workspaceSchema?.workspace?.profile]);

  const sizeOptions = useMemo(() => {
    const discovered = [...new Set(visibleCatalog.flatMap((item) => item.sizes).map(atlasNormalizedSize))];
    return [...new Set([...atlasSizes, ...discovered])].sort((left, right) => {
      const leftStandard = atlasSizes.indexOf(left);
      const rightStandard = atlasSizes.indexOf(right);
      if (leftStandard >= 0 || rightStandard >= 0) {
        if (leftStandard < 0) return 1;
        if (rightStandard < 0) return -1;
        return leftStandard - rightStandard;
      }
      return left.localeCompare(right, undefined, { numeric: true });
    });
  }, [visibleCatalog]);

  const sizeFacetCatalog = useMemo(() => catalogBeforeSize.filter((item) => activeFilter === "Tout" || item.category === activeFilter), [activeFilter, catalogBeforeSize]);
  const knownSizeCount = useMemo(() => sizeFacetCatalog.filter((item) => item.kind === "shop" && item.decision !== "owned"
    && item.sizeAvailabilityKnown && item.stockStatus === "in_stock" && !atlasIsStale(item.sizesCheckedAt)).length, [sizeFacetCatalog]);
  const uncheckedGarmentItems = useMemo(() => sizeFacetCatalog.filter((item) => item.kind === "shop" && item.source === "zalando-ch" && item.decision !== "owned" && item.decision !== "rejected"
    && ["Vestes", "Pantalons", "Mailles", "Chemises", "T-shirts"].includes(item.category)
    && (!item.sizeAvailabilityKnown || atlasIsStale(item.sizesCheckedAt))), [sizeFacetCatalog]);
  const sizeCounts = useMemo(() => Object.fromEntries(sizeOptions.map((size) => [size, sizeFacetCatalog.filter((item) => atlasHasSize(item, size)).length])), [sizeFacetCatalog, sizeOptions]);
  const selectedSizeMatchCount = useMemo(() => sizeFacetCatalog.filter((item) => {
    if (!selectedSizes.length || item.kind !== "shop" || item.decision === "owned") return true;
    return selectedSizes.some((size) => atlasHasSize(item, size));
  }).length, [selectedSizes, sizeFacetCatalog]);
  const products = useMemo(() => atlasArrange(quickFilteredCatalog.filter((item) => activeFilter === "Tout" || item.category === activeFilter), xAxis, yAxis), [activeFilter, quickFilteredCatalog, xAxis, yAxis]);
  const renderSignature = useMemo(() => JSON.stringify([
    aiItems ? "ai" : "catalogue", scope, selectedOutfitBoardId, activeFilter, sourceFilter, priceFilter, fitFilter,
    materialFilter, selectedSizes, stockFilter, attributeQuery, minPrice, maxPrice, includeRejected, selectedCollectionId,
    dynamicFacetSelections, dynamicNumberFilters, xAxis, yAxis, mode,
    products.length, products[0]?.id ?? "", products.at(-1)?.id ?? "",
  ]), [activeFilter, aiItems, attributeQuery, dynamicFacetSelections, dynamicNumberFilters, fitFilter, includeRejected, materialFilter, maxPrice, minPrice, mode, priceFilter, products, scope, selectedCollectionId, selectedOutfitBoardId, selectedSizes, sourceFilter, stockFilter, xAxis, yAxis]);
  const renderLimit = renderWindow.signature === renderSignature ? renderWindow.limit : ATLAS_PAGE_SIZE;
  const geometrySignature = useMemo(() => products.map((item) => [
    item.id, item.x.toFixed(4), item.y.toFixed(4), item.price ?? "", item.score, item.imageAspectRatio?.toFixed(4) ?? "",
  ].join(":")).join("|"), [products]);
  const baseSpaceLayout = useMemo(() => {
    const key = `${xAxis}:${yAxis}:${Math.round(atlasViewport.width)}:${Math.round(atlasViewport.height)}:${imageMode}:${geometrySignature}`;
    const cached = atlasLayoutCacheRef.current.get(key);
    if (cached) return cached;
    const layout = atlasSpaceLayout(products, xAxis, yAxis, atlasViewport.width, atlasViewport.height, imageMode);
    atlasLayoutCacheRef.current.set(key, layout);
    while (atlasLayoutCacheRef.current.size > 12) {
      const oldest = atlasLayoutCacheRef.current.keys().next().value;
      if (oldest === undefined) break;
      atlasLayoutCacheRef.current.delete(oldest);
    }
    return layout;
  }, [atlasViewport.height, atlasViewport.width, geometrySignature, imageMode, products, xAxis, yAxis]);
  const spaceLayout = baseSpaceLayout;
  const renderedProducts = useMemo(() => {
    if (mode === "grid") return products.slice(0, renderLimit);
    const scale = Math.max(.001, zoom);
    const overscan = 320 / scale;
    const minimumX = atlasView.left / scale - overscan;
    const maximumX = (atlasView.left + atlasView.width) / scale + overscan;
    const minimumY = atlasView.top / scale - overscan;
    const maximumY = (atlasView.top + atlasView.height) / scale + overscan;
    return products.filter((item) => {
      const rectangle = spaceLayout.positions.get(item.id);
      if (!rectangle) return false;
      return rectangle.left + rectangle.width / 2 >= minimumX
        && rectangle.left - rectangle.width / 2 <= maximumX
        && rectangle.top + rectangle.height / 2 >= minimumY
        && rectangle.top - rectangle.height / 2 <= maximumY;
    });
  }, [atlasView.height, atlasView.left, atlasView.top, atlasView.width, mode, products, renderLimit, spaceLayout.positions, zoom]);
  const categoryCounts = useMemo(() => Object.fromEntries(atlasCategories.map((filter) => [filter, filter === "Tout" ? quickFilteredCatalog.length : quickFilteredCatalog.filter((item) => item.category === filter).length])), [quickFilteredCatalog]);
  const compareItems = useMemo(() => [...compareIds].map((id) => catalogItems.find((item) => item.id === id) ?? visibleCatalog.find((item) => item.id === id)).filter(Boolean) as AtlasItem[], [catalogItems, compareIds, visibleCatalog]);
  const selectedItems = useMemo(() => [...selectedIds].map((id) => catalogItems.find((item) => item.id === id) ?? visibleCatalog.find((item) => item.id === id)).filter(Boolean) as AtlasItem[], [catalogItems, selectedIds, visibleCatalog]);
  const promptProducts = useMemo(() => promptProductIds.map((id) => catalogItems.find((item) => item.id === id)).filter(Boolean) as AtlasItem[], [catalogItems, promptProductIds]);
  const extraShopSources = useMemo(() => [...new Set(catalogItems.filter((item) => item.kind === "shop")
    .map((item) => item.source).filter((source) => !["zalando-ch", "aboutyou-ch", "aliexpress"].includes(source)))].sort(), [catalogItems]);
  const outfitDraftItems = useMemo(() => [...outfitDraftIds].map((id) => catalogItems.find((item) => item.id === id)).filter(Boolean) as AtlasItem[], [catalogItems, outfitDraftIds]);
  const ownedItems = useMemo(() => catalogItems.filter((item) => item.kind === "owned" || item.decision === "owned"), [catalogItems]);
  const wardrobeGaps = useMemo(() => ["Vestes", "Pantalons", "Mailles", "Chemises", "Chaussures"].filter((category) => !ownedItems.some((item) => item.category === category)), [ownedItems]);
  const staleCount = useMemo(() => catalogItems.filter((item) => item.kind === "shop" && atlasIsStale(item.stockCheckedAt)).length, [catalogItems]);

  const scheduleAtlasView = useCallback((element: HTMLDivElement, includeZoom = false) => {
    if (includeZoom) atlasPendingZoomCommitRef.current = true;
    if (atlasScrollTimerRef.current !== null) return;
    const elapsed = performance.now() - atlasLastCullAtRef.current;
    atlasScrollTimerRef.current = window.setTimeout(() => {
      atlasScrollTimerRef.current = null;
      atlasLastCullAtRef.current = performance.now();
      if (atlasPendingZoomCommitRef.current) {
        atlasPendingZoomCommitRef.current = false;
        setZoom(atlasZoomRef.current);
      }
      const next = { left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight };
      atlasViewRef.current = next;
      setAtlasView(next);
    }, Math.max(0, ATLAS_CULL_INTERVAL_MS - elapsed));
  }, []);

  useEffect(() => {
    const atlas = atlasElementRef.current;
    if (!atlas) return;
    const update = () => {
      setAtlasViewport({ width: atlas.clientWidth, height: atlas.clientHeight });
      const next = { left: atlas.scrollLeft, top: atlas.scrollTop, width: atlas.clientWidth, height: atlas.clientHeight };
      atlasViewRef.current = next;
      setAtlasView(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(atlas);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    if (mode !== "space") return;
    const frame = requestAnimationFrame(() => {
      const atlas = atlasElementRef.current;
      if (!atlas) return;
      atlas.scrollTo({
        left: Math.max(0, (atlas.scrollWidth - atlas.clientWidth) / 2),
        top: Math.max(0, (atlas.scrollHeight - atlas.clientHeight) / 2),
      });
      const next = { left: atlas.scrollLeft, top: atlas.scrollTop, width: atlas.clientWidth, height: atlas.clientHeight };
      atlasViewRef.current = next;
      setAtlasView(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [imageMode, mode, renderSignature]);

  useEffect(() => {
    const canvas = atlasMinimapRef.current;
    if (!canvas || mode !== "space") return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    const scaledWidth = spaceLayout.width * zoom;
    const scaledHeight = spaceLayout.height * zoom;
    const scaleX = width / Math.max(1, scaledWidth);
    const scaleY = height / Math.max(1, scaledHeight);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(239, 235, 226, .94)";
    context.fillRect(0, 0, width, height);
    for (const item of products) {
      const rectangle = spaceLayout.positions.get(item.id);
      if (!rectangle) continue;
      context.fillStyle = item.decision === "saved" ? "#9a6148" : item.kind === "reference" ? "#66705d" : "#8b8377";
      context.fillRect(
        (rectangle.left - rectangle.width / 2) * zoom * scaleX,
        (rectangle.top - rectangle.height / 2) * zoom * scaleY,
        Math.max(1.5, rectangle.width * zoom * scaleX),
        Math.max(1.5, rectangle.height * zoom * scaleY),
      );
    }
    context.strokeStyle = "#332c24";
    context.lineWidth = 3;
    context.strokeRect(atlasView.left * scaleX, atlasView.top * scaleY, atlasView.width * scaleX, atlasView.height * scaleY);
  }, [atlasView.height, atlasView.left, atlasView.top, atlasView.width, mode, products, spaceLayout, zoom]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || renderLimit >= products.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setRenderWindow((current) => ({
        signature: renderSignature,
        limit: Math.min((current.signature === renderSignature ? current.limit : ATLAS_PAGE_SIZE) + ATLAS_PAGE_SIZE, products.length),
      }));
    }, { root: atlasElementRef.current, rootMargin: "280px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [products.length, renderLimit, renderSignature]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function updateProductLocally(id: string, patch: Partial<AtlasItem>) {
    setCatalogItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setAiItems((current) => current?.map((item) => item.id === id ? { ...item, ...patch } : item) ?? null);
  }

  async function setAtlasDecision(item: AtlasItem, requested: AtlasDecision) {
    const operation = captureWorkspaceOperation();
    const nextDecision = item.decision === requested && requested !== "owned" ? "unseen" : requested;
    const previousDecision = item.decision;
    if (previousDecision === nextDecision) return;
    updateProductLocally(item.id, { decision: nextDecision });
    try {
      const response = await fetch(atlasWorkspaceApiUrl(`/products/${encodeURIComponent(item.id)}`, operation.workspaceId), {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: nextDecision }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("decision unavailable");
      const result = await response.json() as { product?: AtlasApiProduct; actionId?: string };
      if (!isWorkspaceOperationCurrent(operation)) return;
      if (result.product) updateProductLocally(item.id, atlasApiToItem(result.product));
      setUndoStack((current) => [...current.slice(-29), { actionId: result.actionId, productId: item.id, previousDecision, nextDecision }]);
      setToast(`${atlasDecisionLabel(nextDecision)} · ⌘Z pour annuler`);
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      updateProductLocally(item.id, { decision: previousDecision });
      setToast("Impossible d’enregistrer — changement annulé");
    }
  }

  async function undoLastAction() {
    const operation = captureWorkspaceOperation();
    const action = undoStack.at(-1);
    if (!action) return;
    setUndoStack((current) => current.slice(0, -1));
    updateProductLocally(action.productId, { decision: action.previousDecision });
    try {
      const response = action.actionId
        ? await fetch(`${ATLAS_API}/actions/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId: action.actionId, workspaceId: operation.workspaceId || undefined }), signal: operation.signal })
        : await fetch(atlasWorkspaceApiUrl(`/products/${encodeURIComponent(action.productId)}`, operation.workspaceId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: action.previousDecision }), signal: operation.signal });
      if (!response.ok) throw new Error("undo unavailable");
      const result = await response.json() as { product?: AtlasApiProduct };
      if (!isWorkspaceOperationCurrent(operation)) return;
      if (result.product) updateProductLocally(action.productId, atlasApiToItem(result.product));
      setToast("Dernière décision annulée");
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      updateProductLocally(action.productId, { decision: action.nextDecision });
      setUndoStack((current) => [...current, action]);
      setToast("Annulation impossible");
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "z" && !target.closest("input, textarea, select")) {
        event.preventDefault(); void undoLastAction();
      }
      if (event.key === "Escape" && previewItem) setPreviewItem(null);
      else if (event.key === "Escape" && drawer) setDrawer(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!drawer) return;
    const panel = drawerRef.current;
    const closeButton = drawerCloseRef.current;
    if (!panel || !closeButton) return;
    drawerReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = panel.closest("main");
    const background = shell
      ? [...shell.children].filter((element) => !element.classList.contains("drawerBackdrop")) as HTMLElement[]
      : [];
    const previousStates = background.map((element) => ({
      element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden"),
    }));
    background.forEach((element) => { element.inert = true; element.setAttribute("aria-hidden", "true"); });

    const focusFrame = requestAnimationFrame(() => closeButton.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      previousStates.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", ariaHidden);
      });
      const returnTarget = drawerReturnFocusRef.current;
      drawerReturnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [drawer]);

  const previewOpen = previewItem !== null;
  useEffect(() => {
    if (!previewOpen) return;
    const panel = previewDialogRef.current;
    const closeButton = previewCloseRef.current;
    if (!panel || !closeButton) return;
    previewReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = panel.closest("main");
    const background = shell
      ? [...shell.children].filter((element) => !element.classList.contains("productPreviewBackdrop")) as HTMLElement[]
      : [];
    const previousStates = background.map((element) => ({
      element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden"),
    }));
    background.forEach((element) => { element.inert = true; element.setAttribute("aria-hidden", "true"); });

    const focusFrame = requestAnimationFrame(() => closeButton.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      previousStates.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", ariaHidden);
      });
      const returnTarget = previewReturnFocusRef.current;
      previewReturnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [previewOpen]);

  function toggleCompare(id: string) {
    if (!compareIds.has(id) && compareIds.size >= 4) {
      setToast("Comparaison limitée à 4 éléments");
      return;
    }
    setCompareIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleMosaicSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function persistMosaicCollections(collections: MosaicCollection[]) {
    try { window.localStorage.setItem(MOSAIC_COLLECTIONS_FALLBACK_KEY, JSON.stringify(collections)); }
    catch { /* Server state remains authoritative. */ }
  }

  async function createMosaicCollection(event: FormEvent) {
    event.preventDefault();
    const operation = captureWorkspaceOperation();
    const name = collectionName.trim();
    if (!name) return;
    const selected = [...selectedIds];
    try {
      const response = await fetch(`${ATLAS_API}/collections`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, workspaceId: operation.workspaceId || undefined }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("collections unavailable");
      const payload = await response.json() as MosaicCollection | { collection?: MosaicCollection };
      const created = mosaicNormalizeCollection("collection" in payload && payload.collection ? payload.collection : payload as MosaicCollection);
      let next = created;
      if (selected.length) {
        const addResponse = await fetch(`${ATLAS_API}/collections/${encodeURIComponent(created.id)}/items`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemIds: selected, workspaceId: operation.workspaceId || undefined }), signal: operation.signal,
        });
        if (addResponse.ok) {
          const addedPayload = await addResponse.json() as MosaicCollection | { collection?: MosaicCollection };
          next = mosaicNormalizeCollection("collection" in addedPayload && addedPayload.collection ? addedPayload.collection : addedPayload as MosaicCollection);
        } else next = { ...created, itemIds: selected };
      }
      if (!isWorkspaceOperationCurrent(operation)) return;
      setMosaicCollections((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      setCollectionsApiAvailable(true);
      setCollectionName("");
      setSelectedIds(new Set());
      setToast(`Collection « ${name} » créée`);
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      const created: MosaicCollection = { id: `local_${crypto.randomUUID()}`, name, itemIds: selected, kind: "local" };
      setMosaicCollections((current) => { const next = [created, ...current]; persistMosaicCollections(next); return next; });
      setCollectionName(""); setSelectedIds(new Set());
      setToast(`Collection enregistrée localement · synchronisation indisponible`);
    }
  }

  async function addSelectionToMosaicCollection(collection: MosaicCollection) {
    const operation = captureWorkspaceOperation();
    const itemIds = [...selectedIds];
    if (!itemIds.length) { setSelectedCollectionId(collection.id); setScope("catalogue"); setDrawer(null); return; }
    const optimistic = { ...collection, itemIds: [...new Set([...collection.itemIds, ...itemIds])] };
    setMosaicCollections((current) => current.map((item) => item.id === collection.id ? optimistic : item));
    try {
      const response = await fetch(`${ATLAS_API}/collections/${encodeURIComponent(collection.id)}/items`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemIds, workspaceId: operation.workspaceId || undefined }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("collection unavailable");
      const payload = await response.json() as MosaicCollection | { collection?: MosaicCollection };
      if (!isWorkspaceOperationCurrent(operation)) return;
      const saved = mosaicNormalizeCollection("collection" in payload && payload.collection ? payload.collection : payload as MosaicCollection);
      setMosaicCollections((current) => current.map((item) => item.id === collection.id ? saved : item));
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      const current = mosaicCollections.map((item) => item.id === collection.id ? optimistic : item);
      persistMosaicCollections(current);
      if (collectionsApiAvailable) setToast("Ajout conservé localement · serveur indisponible");
    }
    setSelectedIds(new Set());
    setToast(`${itemIds.length} élément${itemIds.length > 1 ? "s" : ""} ajouté${itemIds.length > 1 ? "s" : ""}`);
  }

  async function createMosaicWorkspace(event: FormEvent) {
    event.preventDefault();
    const operation = captureWorkspaceOperation();
    const name = newWorkspaceName.trim();
    if (!name || workspaceBusy) return;
    setWorkspaceBusy(true);
    try {
      const response = await fetch(`${ATLAS_API}/workspaces`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, profile: newWorkspaceProfile }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("workspace unavailable");
      const payload = await response.json() as MosaicWorkspace | { workspace?: MosaicWorkspace };
      if (!isWorkspaceOperationCurrent(operation)) return;
      const workspace = "workspace" in payload && payload.workspace ? payload.workspace : payload as MosaicWorkspace;
      setMosaicWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
      switchMosaicWorkspace(workspace.id);
      setNewWorkspaceName("");
      setToast(`Espace « ${workspace.name} » créé`);
    } catch { if (isWorkspaceOperationCurrent(operation)) setToast("Création d’espace indisponible"); }
    finally { if (isWorkspaceOperationCurrent(operation)) setWorkspaceBusy(false); }
  }

  async function createMosaicArtifact(event: FormEvent) {
    event.preventDefault();
    const operation = captureWorkspaceOperation();
    if (artifactBusy) return;
    const itemIds = [...new Set([...selectedIds, ...promptProductIds])];
    const visualReferences = [
      ...promptImages.map((image) => ({ id: image.id, name: image.name, source: "prompt" })),
      ...personalImages.map((image) => ({ id: image.id, name: image.name, source: "personal-item" })),
    ].slice(0, ATLAS_MAX_IMAGES);
    const imageReferences = visualReferences.map((image) => image.name);
    const draft: MosaicArtifact = {
      id: `draft_${crypto.randomUUID()}`, name: artifactName.trim() || `Planche ${mosaicArtifacts.length + 1}`,
      type: "other", status: "draft", prompt: aiPrompt.trim() || undefined, itemIds, inputItemIds: itemIds,
      inputCollectionIds: promptCollectionIds, imageReferences, provenance: { imageReferences: visualReferences, privacy: "local-first", visualApproximation: true },
      createdAt: new Date().toISOString(),
    };
    setArtifactBusy(true);
    try {
      const response = await fetch(`${ATLAS_API}/artifacts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: operation.workspaceId || undefined, type: "other", name: draft.name, status: "draft", prompt: draft.prompt ?? "",
          inputItemIds: itemIds, inputCollectionIds: promptCollectionIds,
          images: [...promptImages, ...personalImages].slice(0, ATLAS_MAX_IMAGES).map((image) => ({
            name: image.name,
            dataUrl: image.dataUrl,
          })),
          provenance: draft.provenance,
        }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("provider not configured");
      const payload = await response.json() as MosaicArtifact | { artifact?: MosaicArtifact };
      if (!isWorkspaceOperationCurrent(operation)) return;
      const saved = "artifact" in payload && payload.artifact ? payload.artifact : payload as MosaicArtifact;
      const normalized = mosaicNormalizeArtifact(saved);
      setMosaicArtifacts((current) => [normalized, ...current.filter((item) => item.id !== normalized.id)]);
      setArtifactsApiAvailable(true);
      setToast("Brouillon Studio enregistré localement");
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      setMosaicArtifacts((current) => {
        const next = [draft, ...current];
        try { window.localStorage.setItem(MOSAIC_ARTIFACTS_FALLBACK_KEY, JSON.stringify(next)); } catch { /* optional */ }
        return next;
      });
      setToast("Brouillon privé conservé · fournisseur visuel non configuré");
    } finally { if (isWorkspaceOperationCurrent(operation)) { setArtifactName(""); setArtifactBusy(false); } }
  }

  async function startMosaicEmbedding() {
    if (embeddingJob?.status === "running") return;
    const operation = captureWorkspaceOperation();
    setEmbeddingJob({ status: "running", processed: 0, total: catalogItems.length, message: "Préparation du placement visuel local…" });
    try {
      const response = await fetch(`${ATLAS_API}/embeddings/job`, { method: "POST", signal: operation.signal });
      if (!response.ok) throw new Error("visual index unavailable");
      const job = await response.json() as MosaicEmbeddingJob;
      if (!isWorkspaceOperationCurrent(operation)) return;
      setEmbeddingJob(job);
      setToast("Index visuel lancé · progression dans Activité");
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      setEmbeddingJob({ status: "failed", processed: 0, total: catalogItems.length, message: "Index visuel indisponible" });
      setToast("Impossible de lancer l’index visuel local");
    }
  }

  function toggleOutfitDraft(id: string) {
    setOutfitDraftIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAtlasSize(rawSize: string) {
    const size = atlasNormalizedSize(rawSize);
    setSelectedSizes((current) => current.includes(size)
      ? current.filter((item) => item !== size)
      : [...current, size].sort((left, right) => sizeOptions.indexOf(left) - sizeOptions.indexOf(right)));
  }

  function resetAtlasFilters() {
    setActiveFilter("Tout"); setSourceFilter("all"); setPriceFilter("all"); setFitFilter("all"); setMaterialFilter("all");
    setSelectedSizes(["M", "L"]); setStockFilter("all"); setAttributeQuery(""); setMinPrice(""); setMaxPrice(""); setIncludeRejected(false);
    setDynamicFacetSelections({}); setDynamicNumberFilters({}); setSelectedCollectionId(null);
  }

  const changeAtlasZoom = useCallback((nextValue: number, anchor?: { x: number; y: number }) => {
    const atlas = atlasElementRef.current;
    const next = Math.min(ATLAS_MAX_ZOOM, Math.max(.25, Math.round(nextValue * 1000) / 1000));
    const current = atlasZoomRef.current;
    if (next === current) return;
    atlasZoomRef.current = next;
    if (!atlas) return setZoom(next);
    const point = anchor ?? { x: atlas.clientWidth / 2, y: atlas.clientHeight / 2 };
    const pendingScroll = atlasZoomScrollRef.current ?? { left: atlas.scrollLeft, top: atlas.scrollTop };
    const contentX = (pendingScroll.left + point.x) / current;
    const contentY = (pendingScroll.top + point.y) / current;
    atlasZoomScrollRef.current = { left: contentX * next - point.x, top: contentY * next - point.y };
    const canvas = atlasCanvasRef.current;
    const scene = atlasSceneRef.current;
    if (canvas && scene) {
      canvas.style.width = `${spaceLayout.width * next}px`;
      canvas.style.height = `${spaceLayout.height * next}px`;
      scene.style.transform = `scale(${next})`;
    }
    if (atlasZoomFrameRef.current !== null) cancelAnimationFrame(atlasZoomFrameRef.current);
    atlasZoomFrameRef.current = requestAnimationFrame(() => {
      const target = atlasZoomScrollRef.current;
      if (target) {
        atlas.scrollLeft = target.left;
        atlas.scrollTop = target.top;
      }
      scheduleAtlasView(atlas, true);
      atlasZoomScrollRef.current = null; atlasZoomFrameRef.current = null;
    });
  }, [scheduleAtlasView, spaceLayout.height, spaceLayout.width]);

  function resetAtlasView() {
    atlasZoomRef.current = ATLAS_DEFAULT_ZOOM; atlasZoomScrollRef.current = null; setZoom(ATLAS_DEFAULT_ZOOM);
    requestAnimationFrame(() => {
      const atlas = atlasElementRef.current;
      if (!atlas) return;
      atlas.scrollTo({ left: Math.max(0, (atlas.scrollWidth - atlas.clientWidth) / 2), top: Math.max(0, (atlas.scrollHeight - atlas.clientHeight) / 2) });
    });
  }

  useEffect(() => {
    const atlas = atlasElementRef.current;
    if (!atlas || mode !== "space") return;
    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        const bounds = atlas.getBoundingClientRect();
        const intensity = event.deltaMode === 1 ? .09 : ATLAS_ZOOM_SENSITIVITY;
        changeAtlasZoom(atlasZoomRef.current * Math.exp(-event.deltaY * intensity), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
        return;
      }
      atlas.scrollLeft += event.deltaX || (event.shiftKey ? event.deltaY : 0);
      atlas.scrollTop += event.shiftKey ? 0 : event.deltaY;
    };
    atlas.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => atlas.removeEventListener("wheel", handleNativeWheel);
  }, [changeAtlasZoom, mode]);

  function navigateAtlasMinimap(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.type === "pointermove" && event.buttons !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
    const atlas = atlasElementRef.current;
    if (!atlas) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratioX = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const ratioY = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));
    atlas.scrollTo({
      left: ratioX * atlas.scrollWidth - atlas.clientWidth / 2,
      top: ratioY * atlas.scrollHeight - atlas.clientHeight / 2,
    });
    scheduleAtlasView(atlas);
  }

  function startAtlasPan(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (mode !== "space" || event.button !== 0 || target.closest("button, input, select, textarea") || (target.closest("a") && !target.closest(".productLinkOverlay"))) return;
    if (atlasInertiaFrameRef.current !== null) cancelAnimationFrame(atlasInertiaFrameRef.current);
    atlasInertiaFrameRef.current = null;
    atlasDragRef.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop, pointerId: event.pointerId, captured: false, lastX: event.clientX, lastY: event.clientY, lastAt: performance.now(), velocityX: 0, velocityY: 0 };
    atlasSuppressClickRef.current = false;
  }

  function atlasPan(event: ReactPointerEvent<HTMLDivElement>) {
    const start = atlasDragRef.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) {
      atlasSuppressClickRef.current = true;
      if (!start.captured) {
        cancelAtlasPreview();
        event.currentTarget.setPointerCapture(start.pointerId); start.captured = true;
        atlasDraggingRef.current = true; setDragging(true);
      }
    }
    if (!start.captured) return;
    event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
    event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
    const now = performance.now();
    const elapsed = Math.max(8, now - start.lastAt);
    start.velocityX = (start.lastX - event.clientX) / elapsed * 16;
    start.velocityY = (start.lastY - event.clientY) / elapsed * 16;
    start.lastX = event.clientX; start.lastY = event.clientY; start.lastAt = now;
  }

  function stopAtlasPan(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = atlasDragRef.current;
    if (!drag) return;
    if (drag.captured && event.currentTarget.hasPointerCapture(drag.pointerId)) event.currentTarget.releasePointerCapture(drag.pointerId);
    atlasDragRef.current = null; atlasDraggingRef.current = false; setDragging(false);
    // Let the click generated by this pointer-up consume the drag suppression,
    // then clear it for the next genuine card click if the drag ended on empty space.
    if (drag.captured) window.setTimeout(() => { atlasSuppressClickRef.current = false; }, 0);
    if (!drag.captured || Math.hypot(drag.velocityX, drag.velocityY) < .8) return;
    const atlas = event.currentTarget;
    let velocityX = drag.velocityX;
    let velocityY = drag.velocityY;
    const coast = () => {
      atlas.scrollLeft += velocityX;
      atlas.scrollTop += velocityY;
      velocityX *= .92; velocityY *= .92;
      if (Math.hypot(velocityX, velocityY) < .35) { atlasInertiaFrameRef.current = null; return; }
      atlasInertiaFrameRef.current = requestAnimationFrame(coast);
    };
    atlasInertiaFrameRef.current = requestAnimationFrame(coast);
  }

  function cancelAtlasPreview(card?: HTMLElement) {
    if (atlasHoverTimerRef.current !== null) {
      window.clearTimeout(atlasHoverTimerRef.current);
      atlasHoverTimerRef.current = null;
    }
    const activeCard = card ?? atlasHoverCardRef.current;
    clearNaturalPreviewGeometry(activeCard);
    if (!card || atlasHoverCardRef.current === card) atlasHoverCardRef.current = null;
  }

  function prepareAtlasPreview(event: ReactPointerEvent<HTMLElement>) {
    cancelAtlasPreview();
    if (atlasDraggingRef.current || window.matchMedia("(hover: none)").matches) return;
    // Keep the action rail under the pointer. Entering a hidden action directly
    // must not move the card between pointer-down and pointer-up.
    if ((event.target as HTMLElement).closest(".cardActions")) return;
    const card = event.currentTarget;
    atlasHoverCardRef.current = card;
    atlasHoverTimerRef.current = window.setTimeout(() => {
      atlasHoverTimerRef.current = null;
      if (atlasHoverCardRef.current !== card || !card.isConnected || !card.matches(":hover") || atlasDraggingRef.current) return;
      if (mode === "space") applyNaturalPreviewGeometry(card);
      card.style.setProperty("--hover-scale", "1.2");
    }, 140);
  }

  useEffect(() => {
    if (atlasHoverTimerRef.current !== null) window.clearTimeout(atlasHoverTimerRef.current);
    atlasHoverTimerRef.current = null;
    clearNaturalPreviewGeometry(atlasHoverCardRef.current);
    atlasHoverCardRef.current = null;
  }, [imageMode, mode, zoom]);

  useEffect(() => () => {
    if (atlasHoverTimerRef.current !== null) window.clearTimeout(atlasHoverTimerRef.current);
    if (atlasZoomFrameRef.current !== null) cancelAnimationFrame(atlasZoomFrameRef.current);
    if (atlasScrollTimerRef.current !== null) window.clearTimeout(atlasScrollTimerRef.current);
    if (atlasInertiaFrameRef.current !== null) cancelAnimationFrame(atlasInertiaFrameRef.current);
    discoveryMonitorRef.current += 1;
  }, []);

  function focusAtlasCard(index: number) {
    const nextIndex = Math.max(0, Math.min(renderedProducts.length - 1, index));
    setFocusedIndex(nextIndex);
    requestAnimationFrame(() => atlasElementRef.current?.querySelector<HTMLElement>(`[data-card-index="${nextIndex}"]`)?.focus());
  }

  function handleAtlasCardKey(event: ReactKeyboardEvent<HTMLElement>, item: AtlasItem, index: number) {
    const columns = mode === "grid" ? Math.max(1, Math.floor((atlasElementRef.current?.clientWidth ?? 600) / 150)) : 5;
    if (event.key === "ArrowRight") { event.preventDefault(); focusAtlasCard(index + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); focusAtlasCard(index - 1); }
    if (event.key === "ArrowDown") { event.preventDefault(); focusAtlasCard(index + columns); }
    if (event.key === "ArrowUp") { event.preventDefault(); focusAtlasCard(index - columns); }
    if (event.key.toLocaleLowerCase() === "s") { event.preventDefault(); void setAtlasDecision(item, "saved"); }
    if (event.key.toLocaleLowerCase() === "r") { event.preventDefault(); void setAtlasDecision(item, "rejected"); }
    if (event.key.toLocaleLowerCase() === "o") { event.preventDefault(); void setAtlasDecision(item, "owned"); }
    if (event.key.toLocaleLowerCase() === "c") { event.preventDefault(); toggleCompare(item.id); }
    if (event.key === " ") { event.preventDefault(); toggleMosaicSelection(item.id); }
    if (event.key === "Enter" && item.url) window.open(item.url, "_blank", "noopener,noreferrer");
  }

  function addAtlasProductToPrompt(item: AtlasItem) {
    setPromptProductIds((current) => current.includes(item.id) ? current : [...current, item.id].slice(-8));
    setAiStatus(`${item.name} ajouté comme référence au prochain prompt`);
  }

  async function monitorAtlasVisualJob(initialJob: AtlasVisualJob, operation = captureWorkspaceOperation()) {
    let job = initialJob;
    if (!isWorkspaceOperationCurrent(operation)) return;
    setAiItems([]);
    while (job.status !== "complete" && job.status !== "error") {
      if (!isWorkspaceOperationCurrent(operation)) return;
      setAiItems(atlasMergeItems(job.products, catalogItems)); setScope("catalogue"); setActiveFilter("Tout");
      setAiStatus(`${job.message} · ${job.inspected}/${job.maxInspections} vues · ${job.selected} retenus`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!isWorkspaceOperationCurrent(operation)) return;
      const poll = await fetch(atlasWorkspaceApiUrl(`/codex/visual-jobs/${encodeURIComponent(job.id)}`, operation.workspaceId), { signal: operation.signal });
      if (!poll.ok) throw new Error("visual job lost");
      job = await poll.json() as AtlasVisualJob;
    }
    if (!isWorkspaceOperationCurrent(operation)) return;
    if (job.status === "error") throw new Error(job.error ?? "visual selection failed");
    setAiItems(atlasMergeItems(job.products, catalogItems));
    setAiStatus(`${job.message} · score > ${job.threshold.toFixed(2)}`);
  }

  async function askAtlasAssistant() {
    if ((!aiPrompt.trim() && !promptImages.length && !promptProductIds.length && !promptCollectionIds.length) || assistantBusy) return;
    const operation = captureWorkspaceOperation();
    const presetRange = priceFilter === "under50" ? { max: 49.99 }
      : priceFilter === "50to100" ? { min: 50, max: 100 }
        : priceFilter === "100to180" ? { min: 100, max: 180 }
          : priceFilter === "over180" ? { min: 180.01 } : {};
    const requestedMin = minPrice && Number.isFinite(Number(minPrice)) ? Number(minPrice) : undefined;
    const requestedMax = maxPrice && Number.isFinite(Number(maxPrice)) ? Number(maxPrice) : undefined;
    const effectiveMinPrice = requestedMin === undefined ? presetRange.min : Math.max(requestedMin, presetRange.min ?? 0);
    const effectiveMaxPrice = requestedMax === undefined ? presetRange.max : Math.min(requestedMax, presetRange.max ?? Number.MAX_SAFE_INTEGER);
    const shops = sourceFilter === "zalando" ? ["zalando-ch"]
      : sourceFilter === "aboutyou" ? ["aboutyou-ch"]
        : sourceFilter === "aliexpress" ? ["aliexpress"]
          : sourceFilter.startsWith("source:") ? [sourceFilter.slice(7)] : undefined;
    setAssistantBusy(true);
    setAiStatus("Luna choisit le bon outil…");
    try {
      const response = await fetch(`${ATLAS_API}/codex/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: aiPrompt,
          productIds: promptProductIds,
          collectionIds: promptCollectionIds.slice(0, 12),
          workspaceId: operation.workspaceId || undefined,
          images: promptImages.map(({ name, dataUrl }) => ({ name, dataUrl })),
          analysisMode: visualMode,
          reasoningEffort,
          constraints: {
            sizes: showClothingFallback ? selectedSizes : undefined,
            shops,
            categories: showClothingFallback && activeFilter !== "Tout" ? [activeFilter] : undefined,
            minPrice: effectiveMinPrice,
            maxPrice: effectiveMaxPrice,
            includeRejected,
            fields: { facets: dynamicFacetSelections, numbers: dynamicNumberFilters },
          },
        }),
        signal: operation.signal,
      });
      const payload = await response.json() as AtlasAssistantResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? payload.message ?? "assistant unavailable");
      if (!isWorkspaceOperationCurrent(operation)) return;
      if (payload.imported?.length) await reloadAtlasCatalog(operation);
      if (!isWorkspaceOperationCurrent(operation)) return;
      const effectiveSizes = payload.plan?.effectiveSizes;
      if (payload.plan?.sizePolicy === "explicit" && effectiveSizes) setSelectedSizes(effectiveSizes);
      else if (payload.plan?.sizePolicy === "all") setSelectedSizes([]);
      const effectiveShops = payload.plan?.effectiveShops ?? [];
      if (payload.plan?.shopPolicy === "explicit" && effectiveShops.length === 1) {
        const shop = effectiveShops[0]!.toLocaleLowerCase();
        setSourceFilter(shop.includes("zalando") ? "zalando" : shop.includes("about") ? "aboutyou" : shop.includes("aliexpress") ? "aliexpress" : `source:${effectiveShops[0]}`);
      } else if (payload.plan?.shopPolicy === "explicit" && effectiveShops.length > 1) setSourceFilter("shop");
      else if (payload.plan?.shopPolicy === "all") setSourceFilter("all");
      if (payload.plan?.pricePolicy === "explicit") {
        setMinPrice(payload.plan.effectiveMinPrice === undefined ? "" : String(payload.plan.effectiveMinPrice));
        setMaxPrice(payload.plan.effectiveMaxPrice === undefined ? "" : String(payload.plan.effectiveMaxPrice));
      } else if (payload.plan?.pricePolicy === "all") {
        setMinPrice(""); setMaxPrice(""); setPriceFilter("all");
      }

      if (payload.action === "visual" && payload.job && "products" in payload.job) await monitorAtlasVisualJob(payload.job, operation);
      else if (payload.action === "discover" && payload.discoveryPlan && payload.jobs?.length) {
        setDiscoveryPlan(payload.discoveryPlan);
        persistAtlasDiscovery(payload.discoveryPlan, payload.jobs, operation);
        setAiStatus(payload.plan?.message ?? "Recherche locale lancée");
        await monitorAtlasDiscovery(payload.jobs, operation);
      } else if (payload.action === "outfit" && payload.boards) {
        if (showClothingFallback) {
          setOutfitBoards(payload.boards); setScope("outfits"); setDrawer("outfits");
          setAiStatus(`${payload.boards.length} planche${payload.boards.length > 1 ? "s" : ""} créée${payload.boards.length > 1 ? "s" : ""}`);
        } else setAiStatus("Cette action n’est pas disponible dans ce profil");
      } else if (payload.action === "artifact" && payload.artifact) {
        const artifact = mosaicNormalizeArtifact(payload.artifact);
        setMosaicArtifacts((current) => [artifact, ...current.filter((item) => item.id !== artifact.id)]);
        setArtifactsApiAvailable(true); setDrawer("studio");
        if (payload.discoveryPlan && payload.jobs?.length) {
          setDiscoveryPlan(payload.discoveryPlan);
          setDiscoveryJobs(payload.jobs);
          setDiscoveryRecovered(false);
          persistAtlasDiscovery(payload.discoveryPlan, payload.jobs, operation);
          setAiStatus(payload.message ?? `Brouillon « ${artifact.name} » en préparation · suivi dans Activité`);
          void reloadMosaicArtifactsAndRuns(operation).catch(() => {
            // The response artifact keeps Studio useful while the run list reconnects.
          });
          void monitorAtlasDiscovery(payload.jobs, operation)
            .then(() => reloadMosaicArtifactsAndRuns(operation))
            .catch(() => {
              if (isWorkspaceOperationCurrent(operation)) {
                setToast("Le brouillon sera actualisé au prochain rechargement de Studio");
              }
            });
        } else setAiStatus(payload.message ?? `Brouillon « ${artifact.name} » créé`);
      } else if (payload.action === "collection" && payload.collection) {
        const collection = mosaicNormalizeCollection(payload.collection);
        setMosaicCollections((current) => [collection, ...current.filter((item) => item.id !== collection.id)]);
        setCollectionsApiAvailable(true); setDrawer("collections");
        setAiStatus(payload.message ?? `Collection « ${collection.name} » créée`);
      } else if (payload.action === "enrich") {
        const enrichmentJob = payload.acquisitionJob ?? (payload.job && !("products" in payload.job) ? payload.job : undefined);
        if (enrichmentJob) {
          setAiStatus(payload.message ?? "Enrichissement local lancé · suivi dans Activité");
          await monitorAtlasRefresh(enrichmentJob, operation);
        } else setAiStatus(payload.message ?? "Enrichissement préparé · ouvre Activité pour le suivi");
      } else if (payload.products) {
        setAiItems(atlasMergeItems(payload.products, catalogItems)); setScope("catalogue"); setActiveFilter("Tout");
        setAiStatus(mosaicSummaryText(payload.summary) ?? `${payload.plan?.title ?? "Luna"} · ${payload.products.length} résultat${payload.products.length > 1 ? "s" : ""}${payload.importErrors?.length ? ` · ${payload.importErrors.length} lien non lu` : ""}`);
      } else setAiStatus(mosaicSummaryText(payload.summary) ?? payload.message ?? payload.plan?.message ?? "Demande traitée");
    } catch (error) {
      if (isWorkspaceOperationCurrent(operation)) setAiStatus(`Assistant indisponible — ${error instanceof Error ? error.message : "erreur locale"}`);
    } finally { if (isWorkspaceOperationCurrent(operation)) setAssistantBusy(false); }
  }

  function persistAtlasDiscovery(plan: AtlasDiscoveryPlan, jobs: AtlasDiscoveryJob[], operation = captureWorkspaceOperation()) {
    if (!isWorkspaceOperationCurrent(operation)) return;
    try {
      window.localStorage.setItem(ATLAS_DISCOVERY_SESSION_KEY, JSON.stringify({
        plan,
        jobIds: jobs.map((job) => job.id),
        workspaceId: operation.workspaceId || undefined,
      } satisfies AtlasDiscoverySession));
    } catch { /* Server snapshots remain recoverable if browser storage is unavailable. */ }
  }

  async function monitorAtlasDiscovery(initialJobs: AtlasDiscoveryJob[], operation = captureWorkspaceOperation()) {
    if (!isWorkspaceOperationCurrent(operation)) return;
    const monitorId = discoveryMonitorRef.current + 1;
    discoveryMonitorRef.current = monitorId;
    let jobs = initialJobs;
    setDiscoveryJobs(jobs);
    setDiscoveryBusy(true);
    setDiscoveryRecovered(false);
    try {
      while (jobs.some((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status))) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (discoveryMonitorRef.current !== monitorId || !isWorkspaceOperationCurrent(operation)) return;
        const snapshots = await Promise.all(jobs.map(async (job) => {
          if (ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status)) return job;
          const response = await fetch(atlasWorkspaceApiUrl(`/discovery/jobs/${encodeURIComponent(job.id)}`, operation.workspaceId), { signal: operation.signal });
          if (!response.ok) throw new Error(`job ${job.id} unavailable`);
          return response.json() as Promise<AtlasDiscoveryJob>;
        }));
        if (discoveryMonitorRef.current !== monitorId || !isWorkspaceOperationCurrent(operation)) return;
        jobs = snapshots;
        setDiscoveryJobs(jobs);
      }
      if (discoveryMonitorRef.current !== monitorId || !isWorkspaceOperationCurrent(operation)) return;
      const discovered = jobs.reduce((sum, job) => sum + job.discovered, 0);
      if (discovered > 0) {
        try { await reloadAtlasCatalog(operation); }
        catch { if (isWorkspaceOperationCurrent(operation)) setToast(`${discovered} article${discovered > 1 ? "s" : ""} trouvé${discovered > 1 ? "s" : ""}, catalogue à recharger`); return; }
      }
      if (!isWorkspaceOperationCurrent(operation)) return;
      const failed = jobs.filter((job) => ["failed", "blocked"].includes(job.status)).length;
      const cancelled = jobs.filter((job) => job.status === "cancelled").length;
      if (failed) setToast(`${discovered} nouveau${discovered > 1 ? "x" : ""} · ${failed} recherche${failed > 1 ? "s" : ""} à reprendre`);
      else if (cancelled) setToast(discovered ? `${discovered} article${discovered > 1 ? "s" : ""} ajouté${discovered > 1 ? "s" : ""} avant l’arrêt` : "Découverte arrêtée · relance Trouver pour recommencer");
      else setToast(discovered ? `${discovered} ${discovered > 1 ? "nouveaux" : "nouvel"} article${discovered > 1 ? "s" : ""} ajouté${discovered > 1 ? "s" : ""}` : "Aucun nouvel article trouvé");
    } finally {
      if (discoveryMonitorRef.current === monitorId && isWorkspaceOperationCurrent(operation)) setDiscoveryBusy(false);
    }
  }

  async function cancelAtlasDiscovery() {
    const operation = captureWorkspaceOperation();
    const activeJobs = discoveryJobs.filter((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status));
    if (!activeJobs.length) return;
    discoveryMonitorRef.current += 1;
    setDiscoveryBusy(true);
    try {
      const cancelled = await Promise.allSettled(activeJobs.map(async (job) => {
        const response = await fetch(atlasWorkspaceApiUrl(`/discovery/jobs/${encodeURIComponent(job.id)}/cancel`, operation.workspaceId), { method: "POST", signal: operation.signal });
        if (!response.ok) throw new Error(`cancel ${job.id} unavailable`);
        return response.json() as Promise<AtlasDiscoveryJob>;
      }));
      const snapshots = new Map(cancelled.flatMap((result) => result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []));
      if (!isWorkspaceOperationCurrent(operation)) return;
      const nextJobs = discoveryJobs.map((job) => snapshots.get(job.id) ?? job);
      if (!snapshots.size) throw new Error("cancel unavailable");
      await monitorAtlasDiscovery(nextJobs, operation);
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      setDiscoveryBusy(false);
      setToast("Impossible d’arrêter toutes les recherches");
    }
  }

  async function resumeAtlasDiscovery() {
    const operation = captureWorkspaceOperation();
    const resumable = discoveryJobs.filter((job) => ["queued", "running", "failed", "blocked"].includes(job.status));
    if (!resumable.length || discoveryBusy) return;
    discoveryMonitorRef.current += 1;
    setDiscoveryBusy(true);
    setDiscoveryRecovered(false);
    try {
      const resumed = await Promise.allSettled(resumable.map(async (job) => {
        const action = ["failed", "blocked"].includes(job.status) ? "retry" : "resume";
        const interactive = job.status === "blocked" && job.source === "zalando-ch";
        const response = await fetch(atlasWorkspaceApiUrl(`/discovery/jobs/${encodeURIComponent(job.id)}/${action}${interactive ? "?interactive=1" : ""}`, operation.workspaceId), { method: "POST", signal: operation.signal });
        if (!response.ok) throw new Error(`${action} ${job.id} unavailable`);
        return response.json() as Promise<AtlasDiscoveryJob>;
      }));
      const snapshots = new Map(resumed.flatMap((result) => result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []));
      if (!isWorkspaceOperationCurrent(operation)) return;
      const nextJobs = discoveryJobs.map((job) => snapshots.get(job.id) ?? job);
      if (!snapshots.size) throw new Error("resume unavailable");
      await monitorAtlasDiscovery(nextJobs, operation);
    } catch {
      if (!isWorkspaceOperationCurrent(operation)) return;
      setDiscoveryBusy(false);
      setToast("Reprise de la découverte indisponible");
    }
  }

  async function addAtlasPromptImages(files: File[]) {
    const operation = captureWorkspaceOperation();
    try {
      const next = await atlasReadImages(files, promptImages.length);
      if (!isWorkspaceOperationCurrent(operation)) return;
      if (!next.length) return;
      setPromptImages((current) => [...current, ...next].slice(0, ATLAS_MAX_IMAGES));
      setAiStatus(`${next.length} image${next.length > 1 ? "s" : ""} ajoutée${next.length > 1 ? "s" : ""} au prochain prompt Vision`);
    } catch (error) { if (isWorkspaceOperationCurrent(operation)) setAiStatus(error instanceof Error ? error.message : "Image impossible à ajouter"); }
  }

  async function addAtlasPersonalImages(files: File[]) {
    const operation = captureWorkspaceOperation();
    try {
      const next = await atlasReadImages(files, personalImages.length, true);
      if (!isWorkspaceOperationCurrent(operation)) return;
      setPersonalImages((current) => [...current, ...next].slice(0, ATLAS_MAX_IMAGES));
    } catch (error) {
      if (isWorkspaceOperationCurrent(operation)) setToast(error instanceof Error ? error.message : "Images invalides");
    }
  }

  async function dropOnAtlasAssistant(event: ReactDragEvent<HTMLElement>) {
    const operation = captureWorkspaceOperation();
    event.preventDefault();
    setAssistantDropActive(false);
    const productId = event.dataTransfer.getData("application/x-wardrobe-product");
    if (productId) {
      const item = catalogItems.find((candidate) => candidate.id === productId);
      if (item) addAtlasProductToPrompt(item);
    }
    const images = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (images.length) await addAtlasPromptImages(images);
    if (!isWorkspaceOperationCurrent(operation)) return;
    const droppedText = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (droppedText && !productId) setAiPrompt((current) => [current, droppedText.trim()].filter(Boolean).join("\n"));
  }

  async function monitorAtlasRefresh(initialJob: AtlasAcquisitionJob, operation = captureWorkspaceOperation()) {
    if (!isWorkspaceOperationCurrent(operation)) return;
    let job = initialJob;
    setRefreshRecovered(false);
    setRefreshJob(job);
    while (!(job.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(job.status))) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!isWorkspaceOperationCurrent(operation)) return;
      const poll = await fetch(atlasWorkspaceApiUrl(`/acquisition/jobs/${encodeURIComponent(job.id)}`, operation.workspaceId), { signal: operation.signal });
      if (!poll.ok) throw new Error("job unavailable");
      job = await poll.json() as AtlasAcquisitionJob;
      if (!isWorkspaceOperationCurrent(operation)) return;
      setRefreshJob(job);
    }
    // A failed/cancelled batch can still contain successful refreshes. Merge
    // those writes before surfacing the terminal state to the user.
    if (job.status === "complete" || (job.succeeded ?? 0) > 0) {
      await reloadAtlasCatalog(operation);
    }
    if (!isWorkspaceOperationCurrent(operation)) return;
    if (["error", "blocked"].includes(job.status)) throw new Error(job.error ?? "refresh failed");
    if (job.status === "complete") {
      setToast("Prix et stocks rafraîchis");
    } else setToast((job.succeeded ?? 0) > 0 ? `${job.succeeded} fiche${job.succeeded === 1 ? "" : "s"} mise${job.succeeded === 1 ? "" : "s"} à jour avant l’arrêt` : "Rafraîchissement arrêté");
  }

  async function startAtlasRefresh(productIds: string[]) {
    // Callers already derive IDs from shop-only AtlasItem collections. Keep the
    // request independent from a possibly stale catalog closure after a reload;
    // the API remains the authority and drops non-shop IDs defensively.
    const ids = [...new Set(productIds)].filter(Boolean).slice(0, 120);
    if (!ids.length) return;
    const operation = captureWorkspaceOperation();
    setToast(`Rafraîchissement de ${ids.length} fiche${ids.length > 1 ? "s" : ""}…`);
    try {
      const response = await fetch(`${ATLAS_API}/acquisition/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productIds: ids, workspaceId: operation.workspaceId || undefined }), signal: operation.signal });
      if (!response.ok) throw new Error(await response.text() || "queue unavailable");
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob, operation);
    } catch (error) { if (isWorkspaceOperationCurrent(operation)) setToast(`Rafraîchissement indisponible — ${error instanceof Error ? error.message : "reprise disponible"}`); }
  }

  async function startAtlasUnknownSizeRefresh() {
    const operation = captureWorkspaceOperation();
    setToast("Préparation des tailles Zalando manquantes…");
    try {
      const response = await fetch(atlasWorkspaceApiUrl("/acquisition/jobs/unknown-sizes", operation.workspaceId), { method: "POST", signal: operation.signal });
      if (!response.ok) throw new Error(await response.text() || "queue unavailable");
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob, operation);
    } catch (error) {
      if (isWorkspaceOperationCurrent(operation)) setToast(`Vérification Zalando indisponible — ${error instanceof Error ? error.message : "réessaie plus tard"}`);
    }
  }

  async function retryAtlasRefresh() {
    if (!refreshJob) return;
    const operation = captureWorkspaceOperation();
    try {
      const response = await fetch(atlasWorkspaceApiUrl(`/acquisition/jobs/${encodeURIComponent(refreshJob.id)}/resume`, operation.workspaceId), { method: "POST", signal: operation.signal });
      if (!response.ok) throw new Error("retry unavailable");
      if (!isWorkspaceOperationCurrent(operation)) return;
      setRefreshRecovered(false);
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob, operation);
    } catch { if (isWorkspaceOperationCurrent(operation)) setToast("Reprise indisponible"); }
  }

  async function cancelAtlasRefresh() {
    if (!refreshJob) return;
    const operation = captureWorkspaceOperation();
    try {
      const response = await fetch(atlasWorkspaceApiUrl(`/acquisition/jobs/${encodeURIComponent(refreshJob.id)}/cancel`, operation.workspaceId), { method: "POST", signal: operation.signal });
      if (!response.ok) throw new Error("cancel unavailable");
      if (!isWorkspaceOperationCurrent(operation)) return;
      setRefreshRecovered(false);
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob, operation);
    } catch { if (isWorkspaceOperationCurrent(operation)) setToast("Impossible d’arrêter la vérification"); }
  }

  function currentAtlasView(): AtlasSavedView {
    return atlasNormalizeView({
      id: crypto.randomUUID(), name: viewName.trim() || `Vue ${savedViews.length + 1}`, scope, activeFilter, sourceFilter,
      priceFilter: showClothingFallback ? priceFilter : "all", fitFilter: showClothingFallback ? fitFilter : "all",
      materialFilter: showClothingFallback ? materialFilter : "all", sizeFilters: showClothingFallback ? selectedSizes : [],
      stockFilter: showClothingFallback ? stockFilter : "all", attributeQuery, minPrice, maxPrice,
      includeRejected, selectedCollectionId, dynamicFacetSelections, dynamicNumberFilters, xAxis, yAxis, mode, imageMode,
    });
  }

  async function saveAtlasView(event: FormEvent) {
    event.preventDefault();
    const operation = captureWorkspaceOperation();
    const payload = currentAtlasView();
    try {
      const response = await fetch(`${ATLAS_API}/views`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, workspaceId: operation.workspaceId || undefined }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("save failed");
      const saved = atlasNormalizeView(await response.json() as AtlasSavedView);
      if (!isWorkspaceOperationCurrent(operation)) return;
      setSavedViews((current) => [saved, ...current.filter((view) => view.id !== saved.id)]); setViewName(""); setToast("Vue sauvegardée");
    } catch { if (isWorkspaceOperationCurrent(operation)) setToast("Impossible de sauvegarder cette vue"); }
  }

  function applyAtlasView(view: AtlasSavedView) {
    const nextScope = showClothingFallback || ["catalogue", "saved", "reference"].includes(view.scope) ? view.scope : "catalogue";
    setScope(nextScope); setActiveFilter(showClothingFallback ? view.activeFilter : "Tout"); setSourceFilter(!showClothingFallback && view.sourceFilter === "owned" ? "all" : view.sourceFilter);
    setPriceFilter(showClothingFallback ? view.priceFilter : "all"); setFitFilter(showClothingFallback ? view.fitFilter : "all");
    setMaterialFilter(showClothingFallback ? view.materialFilter : "all"); setSelectedSizes(showClothingFallback ? view.sizeFilters : ["M", "L"]); setStockFilter(showClothingFallback ? view.stockFilter : "all");
    setAttributeQuery(view.attributeQuery); setMinPrice(view.minPrice); setMaxPrice(view.maxPrice); setIncludeRejected(view.includeRejected);
    setSelectedCollectionId(view.selectedCollectionId ?? null); setDynamicFacetSelections(view.dynamicFacetSelections ?? {}); setDynamicNumberFilters(view.dynamicNumberFilters ?? {});
    setXAxis(view.xAxis); setYAxis(view.yAxis); setMode(view.mode); setImageMode(view.imageMode); setDrawer(null); setToast(`Vue « ${view.name} » appliquée`);
  }

  async function deleteAtlasView(id: string) {
    const operation = captureWorkspaceOperation();
    const previous = savedViews;
    setSavedViews((current) => current.filter((view) => view.id !== id));
    try { const response = await fetch(atlasWorkspaceApiUrl(`/views/${encodeURIComponent(id)}`, operation.workspaceId), { method: "DELETE", signal: operation.signal }); if (!response.ok) throw new Error("delete failed"); }
    catch { if (isWorkspaceOperationCurrent(operation)) { setSavedViews(previous); setToast("Suppression impossible"); } }
  }

  async function addAtlasPersonalItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const operation = captureWorkspaceOperation();
    if ((personalKind !== "shop" && !personalImages.length) || personalBusy) { setToast("Ajoute au moins une image"); return; }
    const form = new FormData(event.currentTarget);
    setPersonalBusy(true);
    try {
      const response = await fetch(`${ATLAS_API}/${personalKind === "shop" ? "products/import-url" : "personal-items"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(personalKind === "shop" ? {
          url: String(form.get("url") ?? "").trim(), workspaceId: operation.workspaceId || undefined,
        } : {
          kind: personalKind, name: String(form.get("name") ?? "").trim(), images: personalImages.map((image) => image.dataUrl),
          description: String(form.get("description") ?? "").trim() || undefined,
          category: String(form.get("category") ?? "Autre"), color: String(form.get("color") ?? "Inconnue"),
          fit: String(form.get("fit") ?? "unknown"), tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
          workspaceId: operation.workspaceId || undefined,
        }),
        signal: operation.signal,
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(failure.error ?? "create failed");
      }
      const created = atlasApiToItem(await response.json() as AtlasApiProduct);
      if (!isWorkspaceOperationCurrent(operation)) return;
      setCatalogItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setPersonalImages([]); event.currentTarget.reset(); setDrawer(null); setScope(showClothingFallback && personalKind === "owned" ? "owned" : personalKind === "reference" ? "reference" : "catalogue");
      setToast(personalKind === "owned" ? (showClothingFallback ? "Vêtement ajouté au dressing" : "Élément local ajouté au catalogue") : personalKind === "reference" ? "Référence ajoutée" : "Fiche produit importée");
    } catch (error) { if (isWorkspaceOperationCurrent(operation)) setToast(error instanceof Error ? `Ajout impossible — ${error.message}` : "Ajout impossible — API locale indisponible"); }
    finally { if (isWorkspaceOperationCurrent(operation)) setPersonalBusy(false); }
  }

  async function createAtlasOutfit(event: FormEvent) {
    event.preventDefault();
    const operation = captureWorkspaceOperation();
    const productIds = outfitDraftIds.size ? [...outfitDraftIds] : [...compareIds];
    if (!productIds.length) { setToast("Ajoute d’abord quelques pièces à la tenue"); return; }
    try {
      const response = await fetch(`${ATLAS_API}/outfit-boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: outfitName.trim() || `Tenue ${outfitBoards.length + 1}`, productIds, workspaceId: operation.workspaceId || undefined }), signal: operation.signal });
      if (!response.ok) throw new Error("create failed");
      const board = await response.json() as AtlasOutfitBoard;
      if (!isWorkspaceOperationCurrent(operation)) return;
      setOutfitBoards((current) => [board, ...current.filter((item) => item.id !== board.id)]);
      setOutfitName(""); setOutfitDraftIds(new Set()); setSelectedOutfitBoardId(board.id); setScope("outfits"); setToast("Planche de tenue enregistrée");
    } catch { if (isWorkspaceOperationCurrent(operation)) setToast("Impossible d’enregistrer cette tenue"); }
  }

  async function generateAtlasOutfits() {
    const operation = captureWorkspaceOperation();
    const anchor = outfitDraftItems.find((item) => item.kind === "shop")
      ?? compareItems.find((item) => item.kind === "shop")
      ?? catalogItems.find((item) => item.kind === "shop" && item.decision === "saved");
    if (!anchor) { setToast("Sélectionne d’abord un achat potentiel"); return; }
    setToast(`Luna compose autour de ${anchor.name}…`);
    try {
      const response = await fetch(`${ATLAS_API}/outfit-boards/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorProductId: anchor.id, maxOutfits: 3, workspaceId: operation.workspaceId || undefined }), signal: operation.signal,
      });
      if (!response.ok) throw new Error("generation unavailable");
      const boards = await response.json() as AtlasOutfitBoard[];
      if (!isWorkspaceOperationCurrent(operation)) return;
      setOutfitBoards((current) => [...boards, ...current.filter((board) => !boards.some((created) => created.id === board.id))]);
      if (boards[0]) setSelectedOutfitBoardId(boards[0].id);
      setScope("outfits");
      setToast(`${boards.length} tenue${boards.length > 1 ? "s" : ""} proposée${boards.length > 1 ? "s" : ""}`);
    } catch { if (isWorkspaceOperationCurrent(operation)) setToast("Luna n’a pas pu composer de tenue"); }
  }

  async function deleteAtlasOutfit(id: string) {
    const operation = captureWorkspaceOperation();
    const previous = outfitBoards;
    setOutfitBoards((current) => current.filter((board) => board.id !== id));
    if (selectedOutfitBoardId === id) setSelectedOutfitBoardId(null);
    try { const response = await fetch(atlasWorkspaceApiUrl(`/outfit-boards/${encodeURIComponent(id)}`, operation.workspaceId), { method: "DELETE", signal: operation.signal }); if (!response.ok) throw new Error("delete failed"); }
    catch { if (isWorkspaceOperationCurrent(operation)) { setOutfitBoards(previous); setToast("Suppression impossible"); } }
  }

  function exportAtlasJson() {
    const payload = { exportedAt: new Date().toISOString(), scope, filters: currentAtlasView(), products, savedViews, outfitBoards };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `wardrobe-atlas-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
    setToast("Export JSON créé");
  }

  const scopeLabel = atlasScopes.find((item) => item.id === scope)?.label ?? "Catalogue";
  const progressDone = refreshJob?.completed ?? refreshJob?.processed ?? 0;
  const progressTotal = refreshJob?.total ?? 0;
  const refreshNeedsResume = refreshRecovered || ["error", "blocked"].includes(refreshJob?.status ?? "");
  const refreshCooldownAt = atlasCooldownTimestamp(refreshJob?.cooldownUntil);
  const refreshCooldownActive = Boolean(refreshCooldownAt && Date.parse(refreshJob?.cooldownUntil ?? "") > Date.now());
  const discoveryTotal = discoveryJobs.reduce((sum, job) => sum + job.total, 0);
  const discoveryCompleted = discoveryJobs.reduce((sum, job) => sum + job.completed, 0);
  const discoveryProgress = discoveryTotal
    ? Math.min(1, discoveryCompleted / discoveryTotal)
    : discoveryJobs.length ? Math.min(1, discoveryJobs.reduce((sum, job) => sum + job.progress, 0) / discoveryJobs.length) : 0;
  const discoveryDiscovered = discoveryJobs.reduce((sum, job) => sum + job.discovered, 0);
  const discoveryDiscarded = discoveryJobs.reduce((sum, job) => sum + job.duplicates + job.filtered + job.invalid, 0);
  const discoverySources = [...new Set((discoveryPlan?.searches.map((search) => search.source) ?? discoveryJobs.map((job) => job.source))
    .map((source) => ATLAS_DISCOVERY_SOURCE_LABELS[source] ?? source))];
  const discoverySizes = discoveryPlan?.sizes.length ? discoveryPlan.sizes.join(" ou ") : "M ou L";
  const discoveryHasActive = discoveryJobs.some((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status));
  const discoveryCanResume = !discoveryBusy && discoveryJobs.some((job) => ["queued", "running", "failed", "blocked"].includes(job.status));
  const discoveryHasFailures = discoveryJobs.some((job) => ["failed", "blocked"].includes(job.status));
  const discoveryNeedsInteractive = discoveryJobs.some((job) => job.status === "blocked" && job.source === "zalando-ch");
  const discoveryWasCancelled = discoveryJobs.length > 0 && discoveryJobs.every((job) => ["succeeded", "cancelled"].includes(job.status))
    && discoveryJobs.some((job) => job.status === "cancelled");
  const discoveryStatusText = discoveryRecovered ? "Session retrouvée · reprise manuelle"
    : discoveryBusy && discoveryHasActive ? `${discoveryCompleted}/${discoveryTotal || "…"} listes explorées`
      : discoveryHasFailures ? "Certaines recherches peuvent être reprises"
        : discoveryWasCancelled ? "Arrêtée · relance Trouver pour recommencer"
          : "Découverte terminée";
  const effectiveFocusedIndex = Math.min(focusedIndex, Math.max(0, renderedProducts.length - 1));
  const previewProduct = previewItem ? catalogItems.find((item) => item.id === previewItem.id) ?? previewItem : null;
  const activeWorkspace = mosaicWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaceSchema?.workspace;
  const showClothingFallback = activeWorkspace?.profile
    ? activeWorkspace.profile === "clothing"
    : !(workspaceSchema?.fields.length) || workspaceSchema?.workspace?.profile === "clothing";
  const dynamicFilterFields = (workspaceSchema?.fields ?? []).filter((field) => field.facetable || ["number", "boolean", "enum", "multi-enum"].includes(field.type)).slice(0, 40);
  const workspaceDisplayFields = (workspaceSchema?.fields ?? []).filter((field) => field.display !== false).slice(0, 24);
  const dynamicFilterCount = Object.values(dynamicFacetSelections).filter((values) => values.length).length
    + Object.values(dynamicNumberFilters).filter((range) => range.min || range.max).length;
  const onboardingExamples = activeWorkspace?.profile === "clothing" ? [
    "Trouve les pièces visuellement proches de mes références, en M ou L",
    "Regroupe ce board par silhouettes et explique les zones",
    "Compare ma sélection et dis-moi laquelle apporte le plus",
  ] : activeWorkspace?.profile === "televisions" ? [
    "Regroupe ces téléviseurs par diagonale et technologie de dalle",
    "Trouve les téléviseurs proches de mes références sans doublons",
    "Compare ma sélection sur dalle, fréquence, connectique et prix",
  ] : [
    "Regroupe ce board par familles visuelles et explique les zones",
    "Trouve les éléments proches de mes références sans doublons",
    "Compare ma sélection avec les critères importants de cet espace",
  ];
  const activityAttentionCount = (refreshJob && ["error", "blocked"].includes(refreshJob.status) ? 1 : 0)
    + (discoveryHasFailures ? 1 : 0) + mosaicRuns.filter((run) => ["failed", "error", "blocked"].includes(run.status)).length;
  const advancedFilterCount = [Boolean(attributeQuery.trim()), Boolean(minPrice), Boolean(maxPrice), includeRejected,
    ...(showClothingFallback ? [priceFilter !== "all", fitFilter !== "all", materialFilter !== "all", stockFilter !== "all"] : []),
  ].filter(Boolean).length + dynamicFilterCount;
  const filterBadgeCount = advancedFilterCount + (sourceFilter !== "all" ? 1 : 0)
    + (showClothingFallback ? selectedSizes.length + (activeFilter !== "Tout" ? 1 : 0) : 0);

  return (
    <main className={`appShell atlasAppShell mosaicShell imageMode-${imageMode}`}>
      <aside className="mosaicSidebar" aria-label="Navigation principale">
        <details className="mosaicWorkspaceSwitcher">
          <summary className="mosaicIdentity"><span className="mosaicMark" aria-hidden="true">M</span><div><b>{activeWorkspace?.name ?? "Mosaic"}</b><small>{activeWorkspace?.profile ?? "Local visual research"}</small></div><i aria-hidden="true">⌄</i></summary>
          <div className="mosaicWorkspaceMenu">
            <span>Espaces</span>
            <div>{mosaicWorkspaces.map((workspace) => <button type="button" className={workspace.id === activeWorkspaceId ? "active" : ""} key={workspace.id} onClick={(event) => { switchMosaicWorkspace(workspace.id); (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); }}><b>{workspace.name}</b><small>{workspace.profile ?? "generic"}</small>{workspace.id === activeWorkspaceId && <i>✓</i>}</button>)}</div>
            <form onSubmit={(event) => void createMosaicWorkspace(event)}><input value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} placeholder="Nouvel espace" aria-label="Nom du nouvel espace" /><select value={newWorkspaceProfile} onChange={(event) => setNewWorkspaceProfile(event.target.value)} aria-label="Profil du nouvel espace"><option value="generic">Générique</option><option value="clothing">Vêtements</option><option value="televisions">Téléviseurs</option></select><button disabled={workspaceBusy || !newWorkspaceName.trim()}>{workspaceBusy ? "…" : "Créer"}</button></form>
          </div>
        </details>
        <nav className="mosaicPrimaryNav">
          <button className={drawer === null ? "active" : ""} onClick={() => { setDrawer(null); setSelectedCollectionId(null); }}>⌘ <span>Explorer</span></button>
          <button className={drawer === "collections" ? "active" : ""} onClick={() => setDrawer("collections")}>▣ <span>Collections</span><b>{mosaicCollections.length}</b></button>
          <button className={drawer === "activity" ? "active" : ""} onClick={() => setDrawer("activity")}>◷ <span>Activité</span>{activityAttentionCount > 0 && <b className="attention">{activityAttentionCount}</b>}</button>
          <button className={drawer === "studio" ? "active" : ""} onClick={() => setDrawer("studio")}>◩ <span>Studio</span>{mosaicArtifacts.length > 0 && <b>{mosaicArtifacts.length}</b>}</button>
        </nav>
        <div className="mosaicLibrary"><small>Bibliothèque</small>{atlasScopes.filter((item) => showClothingFallback || ["catalogue", "saved", "reference"].includes(item.id)).map((item) => <button key={item.id} className={scope === item.id ? "active" : ""} onClick={() => { setScope(item.id); setSelectedCollectionId(null); setDrawer(null); }}><span>{item.icon}</span>{item.id === "catalogue" ? "Tous les éléments" : item.id === "saved" ? "Favoris" : item.label}</button>)}</div>
        <button className="mosaicAdd" onClick={() => setDrawer("add")}>＋ Ajouter</button>
      </aside>

      <section className="mosaicWorkspace">
        <header className="mosaicTopbar">
          <div><span>{activeWorkspace?.profile === "clothing" ? "Garde-robe" : activeWorkspace?.profile === "televisions" ? "Téléviseurs" : "Espace de travail"} · {catalogStatus}</span><h1>{activeWorkspace?.name ?? "Mosaic"}</h1></div>
          <div className="mosaicTopActions">
            <button className={filterBadgeCount ? "hasBadge" : ""} data-count={filterBadgeCount || undefined} onClick={() => setDrawer("filters")}>☷ Filtres</button>
            <details className="mosaicViewMenu"><summary>◫ Vue</summary><div>
              <fieldset><legend>Disposition</legend><button className={mode === "space" ? "active" : ""} onClick={() => setMode("space")}>Espace</button><button className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>Grille</button></fieldset>
              <fieldset><legend>Images</legend><button className={imageMode === "cropped" ? "active" : ""} onClick={() => setImageMode("cropped")}>Recadrées</button><button className={imageMode === "full" ? "active" : ""} onClick={() => setImageMode("full")}>Entières</button></fieldset>
              <fieldset className="mosaicZoom"><legend>Zoom</legend><button disabled={mode !== "space" || zoom <= .25} onClick={() => changeAtlasZoom(atlasZoomRef.current - .5)}>−</button><button disabled={mode !== "space"} onClick={resetAtlasView}>{Math.round(zoom * 100)}%</button><button disabled={mode !== "space" || zoom >= ATLAS_MAX_ZOOM} onClick={() => changeAtlasZoom(atlasZoomRef.current + .5)}>＋</button></fieldset>
              <details><summary>Avancé</summary><label>X <select value={xAxis} onChange={(event) => setXAxis(event.target.value as AxisField)}><option value="pca">Similarité</option><option value="price">Prix</option><option value="score">Score</option></select></label><label>Y <select value={yAxis} onChange={(event) => setYAxis(event.target.value as AxisField)}><option value="pca">Similarité</option><option value="price">Prix</option><option value="score">Score</option></select></label></details>
              <button onClick={() => { setDrawer("views"); }}>Vues sauvegardées</button>
            </div></details>
            <button className="mosaicAddTop" onClick={() => setDrawer("add")}>＋ Ajouter</button>
          </div>
        </header>

        <section className="boardPanel atlasBoardPanel mosaicBoardPanel">
          <form
            className={`mosaicComposer${composerExpanded ? " expanded" : " compact"}${assistantDropActive ? " dropActive" : ""}`}
            onSubmit={(event) => { event.preventDefault(); setComposerExpanded(false); void askAtlasAssistant(); }}
            onDragEnter={(event) => { event.preventDefault(); setAssistantDropActive(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAssistantDropActive(false); }}
            onDrop={(event) => void dropOnAtlasAssistant(event)}
            onFocus={() => setComposerExpanded(true)}
          >
            {composerExpanded && <div className="mosaicComposerIntro"><span>Assistant visuel</span><h2>Qu’est-ce qu’on cherche aujourd’hui ?</h2><p>Décris une direction, colle des liens ou dépose un moodboard. Mosaic combine ton catalogue, tes références et tes collections.</p></div>}
            {composerExpanded && onboardingVisible && <div className="mosaicOnboarding" role="note"><div><b>Essaie une demande concrète</b><span>Tu peux partir d’une intention, d’une URL ou d’images. Rien ne quitte cette machine sans action explicite.</span></div><div>{onboardingExamples.map((example) => <button type="button" key={example} onClick={() => { setAiPrompt(example); requestAnimationFrame(() => composerInputRef.current?.focus()); }}>{example}</button>)}</div><button type="button" className="mosaicOnboardingDismiss" onClick={() => { setOnboardingVisible(false); try { window.localStorage.setItem(MOSAIC_ONBOARDING_KEY, "1"); } catch { /* optional */ } }} aria-label="Masquer ces exemples">×</button></div>}
            <div className="mosaicComposerInput">
              <span className="mosaicSpark" aria-hidden="true">✦</span>
              <textarea ref={composerInputRef} value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (!images.length) return; event.preventDefault(); void addAtlasPromptImages(images); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); setComposerExpanded(false); void askAtlasAssistant(); } }} placeholder={activeWorkspace?.profile === "clothing" ? "Trouve-moi des vestes courtes brunes, texturées, disponibles en M ou L…" : "Décris ce que tu veux trouver, comparer, organiser ou comprendre…"} aria-label="Demander à l’assistant Mosaic" rows={composerExpanded ? 2 : 1} />
              <input ref={atlasImageInputRef} className="hiddenImageInput" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { void addAtlasPromptImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <button className="mosaicAttach" type="button" onClick={() => atlasImageInputRef.current?.click()} aria-label="Ajouter des images">＋</button>
              <button type="submit" className="mosaicSend" disabled={assistantBusy || (!aiPrompt.trim() && !promptImages.length && !promptProductIds.length && !promptCollectionIds.length)} aria-busy={assistantBusy}>{assistantBusy ? "…" : "↑"}<span>Demander</span></button>
            </div>
            {(promptImages.length > 0 || promptProducts.length > 0 || promptCollectionIds.length > 0 || aiStatus) && <div className="mosaicComposerContext">
              {promptProducts.map((item) => <span className="promptProduct" key={item.id}>{item.image ? <img src={item.image} alt="" /> : <i>✦</i>}<b>{item.name}</b><button type="button" onClick={() => setPromptProductIds((current) => current.filter((id) => id !== item.id))} aria-label={`Retirer ${item.name}`}>×</button></span>)}
              {promptImages.map((image) => <span className="promptImage" key={image.id}><img src={image.dataUrl} alt="" /><button type="button" onClick={() => setPromptImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Retirer ${image.name}`}>×</button></span>)}
              {promptCollectionIds.map((id) => { const collection = mosaicCollections.find((item) => item.id === id); return collection ? <span className="mosaicContextChip" key={id}>▣ {collection.name}<button type="button" onClick={() => setPromptCollectionIds((current) => current.filter((item) => item !== id))}>×</button></span> : null; })}
              {promptImages.length > 0 && <span className="segmented analysisMode"><button type="button" className={visualMode === "sequential" ? "active" : ""} onClick={() => setVisualMode("sequential")}>1×1</button><button type="button" className={visualMode === "sheet" ? "active" : ""} onClick={() => setVisualMode("sheet")}>Planche</button></span>}
              {aiStatus && <span className="aiStatus atlasAiStatus">{aiStatus}{aiItems && <button type="button" onClick={() => { setAiItems(null); setAiStatus(""); }}>×</button>}</span>}
            </div>}
            {composerExpanded && <div className="mosaicComposerFooter"><span>Contraintes : {showClothingFallback ? `${selectedSizes.length ? selectedSizes.join(" ou ") : "toutes tailles"} · ` : ""}{sourceFilter === "all" ? "toutes sources" : sourceFilter.replace("source:", "")}{dynamicFilterCount ? ` · ${dynamicFilterCount} champs` : ""}</span><label>Réflexion <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as "low" | "medium")}><option value="low">Rapide</option><option value="medium">Approfondie</option></select></label></div>}
          </form>

          <div className="mosaicBoardBar">
            <div><span className="eyebrow">{scopeLabel}</span><h2>{selectedCollectionId ? mosaicCollections.find((item) => item.id === selectedCollectionId)?.name : showClothingFallback ? "Automne · brun ténébreux" : "Exploration visuelle"}</h2></div>
            <div className="mosaicActiveChips" aria-label="Filtres actifs">
              {showClothingFallback && activeFilter !== "Tout" && <button onClick={() => setActiveFilter("Tout")}>{activeFilter} ×</button>}
              {sourceFilter !== "all" && <button onClick={() => setSourceFilter("all")}>{sourceFilter.replace("source:", "")} ×</button>}
              {showClothingFallback && selectedSizes.map((size) => <button key={size} onClick={() => toggleAtlasSize(size)}>Taille {size} ×</button>)}
              {(minPrice || maxPrice) && <button onClick={() => { setMinPrice(""); setMaxPrice(""); }}>{minPrice || "0"}–{maxPrice || "∞"} CHF ×</button>}
              {attributeQuery && <button onClick={() => setAttributeQuery("")}>{attributeQuery} ×</button>}
              {selectedCollectionId && <button onClick={() => setSelectedCollectionId(null)}>▣ {mosaicCollections.find((item) => item.id === selectedCollectionId)?.name ?? "Collection"} ×</button>}
              {Object.entries(dynamicFacetSelections).flatMap(([key, values]) => values.length ? [<button key={key} onClick={() => setDynamicFacetSelections((current) => ({ ...current, [key]: [] }))}>{workspaceSchema?.fields.find((field) => field.key === key)?.label ?? key}: {values.join(" ∨ ")} ×</button>] : [])}
              {Object.entries(dynamicNumberFilters).flatMap(([key, range]) => range.min || range.max ? [<button key={key} onClick={() => setDynamicNumberFilters((current) => ({ ...current, [key]: { min: "", max: "" } }))}>{workspaceSchema?.fields.find((field) => field.key === key)?.label ?? key}: {range.min || "−∞"}–{range.max || "∞"} ×</button>] : [])}
              <button className="mosaicFilterButton" onClick={() => setDrawer("filters")}>＋ Filtres</button>
            </div>
            <div className="mosaicBoardMeta"><span>{products.length} éléments</span><button className="undoButton" disabled={!undoStack.length} onClick={() => void undoLastAction()} title="Annuler la dernière décision (⌘Z)">↶</button></div>
          </div>

        <div className="operationStack">
          {refreshJob && !(refreshJob.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(refreshJob.status)) && <div className="jobProgress" role="status"><span style={{ width: progressTotal ? `${Math.min(100, progressDone / progressTotal * 100)}%` : "18%" }} /><b>{refreshCooldownActive ? `Pause Zalando · reprise automatique à ${refreshCooldownAt} (heure suisse)` : refreshJob.message ?? "Fiches en cours de vérification"}</b><em>{progressTotal ? `${progressDone}/${progressTotal}` : refreshJob.status}</em><button onClick={() => void cancelAtlasRefresh()}>Arrêter</button></div>}
          {discoveryBusy && discoveryHasActive && <div className="discoveryProgress" role="status" aria-live="polite" title={discoveryPlan?.description}>
            <span className="discoveryFill" style={{ width: `${Math.round(discoveryProgress * 100)}%` }} />
            <div className="discoveryPlanInfo"><b>{discoveryPlan?.name ?? "Découverte agentique"}</b><small>{showClothingFallback ? `Tailles ${discoverySizes} · ` : ""}{discoverySources.join(" + ") || "sources locales"}{discoveryPlan?.targetCount ? ` · cible ${discoveryPlan.targetCount}` : ""} · {discoveryStatusText}</small></div>
            <em><b>{discoveryDiscovered}</b> nouveau{discoveryDiscovered > 1 ? "x" : ""}{discoveryDiscarded > 0 ? ` · ${discoveryDiscarded} écartés` : ""}</em>
            <div className="discoveryActions">{discoveryBusy && discoveryHasActive && <button type="button" onClick={() => void cancelAtlasDiscovery()}>Arrêter</button>}{discoveryCanResume && <button type="button" title={discoveryNeedsInteractive ? "Ouvre un Chrome visible local, sans login ni contournement" : undefined} onClick={() => void resumeAtlasDiscovery()}>{discoveryNeedsInteractive ? "Reprendre dans Chrome" : "Reprendre"}</button>}</div>
          </div>}
        </div>

        <div ref={atlasElementRef} className={`${mode === "space" ? "atlas spaceMode" : "atlas gridMode"}${dragging ? " dragging" : ""}`} onScroll={(event) => scheduleAtlasView(event.currentTarget)} onPointerDown={startAtlasPan} onPointerMove={atlasPan} onPointerUp={stopAtlasPan} onPointerCancel={stopAtlasPan}>
          <div ref={atlasCanvasRef} className="atlasCanvas" style={mode === "space" ? ({ width: spaceLayout.width * zoom, height: spaceLayout.height * zoom } as CSSProperties) : undefined}>
            <div ref={atlasSceneRef} className="atlasScene" style={mode === "space" ? ({ width: spaceLayout.width, height: spaceLayout.height, transform: `scale(${zoom})` } as CSSProperties) : undefined}>
            {renderedProducts.map((item, index) => (
              <article
                className={`productCard ${item.kind === "reference" ? "referenceCard" : ""} decision-${item.decision}${selectedIds.has(item.id) ? " mosaicSelected" : ""}${compareIds.has(item.id) ? " comparing" : ""}${outfitDraftIds.has(item.id) ? " inOutfit" : ""}`}
                key={item.id} style={mode === "space" ? atlasSpaceCardStyle(item, spaceLayout) : undefined} title={item.reason}
                data-card-index={index} data-product-id={item.id} data-source={item.kind === "shop" ? item.source : undefined} tabIndex={index === effectiveFocusedIndex ? 0 : -1}
                aria-label={`${mosaicBrandLabel(item, showClothingFallback)}, ${item.name}, ${atlasDecisionLabel(item.decision)}`} data-selected={selectedIds.has(item.id) || undefined}
                onFocus={() => setFocusedIndex(index)} onKeyDown={(event) => handleAtlasCardKey(event, item, index)} onPointerEnter={prepareAtlasPreview}
                onPointerLeave={(event) => cancelAtlasPreview(event.currentTarget)}
              >
                <button type="button" tabIndex={index === effectiveFocusedIndex ? 0 : -1} className="mosaicSelectButton" aria-label={selectedIds.has(item.id) ? `Retirer ${item.name} de la sélection` : `Sélectionner ${item.name}`} aria-pressed={selectedIds.has(item.id)} onClick={(event) => { event.stopPropagation(); toggleMosaicSelection(item.id); }}>{selectedIds.has(item.id) ? "✓" : ""}</button>
                <div className="cardActions">
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={item.decision === "saved" ? "active" : ""} onClick={() => void setAtlasDecision(item, "saved")} aria-label={item.decision === "saved" ? `Retirer ${item.name} des gardés` : `Garder ${item.name}`} title="Garder (S)">{item.decision === "saved" ? "♥" : "♡"}</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={compareIds.has(item.id) ? "active" : ""} onClick={() => toggleCompare(item.id)} aria-label={`Comparer ${item.name}`} title="Comparer (C)">⇄</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-wardrobe-product", item.id); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => addAtlasProductToPrompt(item)} aria-label={`Utiliser ${item.name} avec Luna`} title="Utiliser avec l’IA ou glisser dans le prompt">✦</button>
                  {showClothingFallback && <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={outfitDraftIds.has(item.id) ? "active" : ""} onClick={() => toggleOutfitDraft(item.id)} aria-label={`Ajouter ${item.name} à une tenue`} title="Ajouter à une tenue">＋</button>}
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={item.decision === "owned" ? "active" : ""} onClick={() => void setAtlasDecision(item, "owned")} aria-label={`Marquer ${item.name} comme possédé`} title="Possédé (O)">◆</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={item.decision === "rejected" ? "active reject" : "reject"} onClick={() => void setAtlasDecision(item, "rejected")} aria-label={`Rejeter ${item.name}`} title="Rejeter (R)">×</button>
                </div>
                {item.url && item.kind === "shop" && <a tabIndex={index === effectiveFocusedIndex ? 0 : -1} className="productLinkOverlay" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Prévisualiser ${item.brand} — ${item.name}`} onClick={(event) => {
                  if (atlasSuppressClickRef.current) { event.preventDefault(); atlasSuppressClickRef.current = false; return; }
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); cancelAtlasPreview(event.currentTarget.closest<HTMLElement>(".productCard") ?? undefined); setPreviewItem(item);
                }} />}
                {(!item.url || item.kind !== "shop") && <button type="button" tabIndex={index === effectiveFocusedIndex ? 0 : -1} className="productLinkOverlay" aria-label={`Inspecter ${item.brand} — ${item.name}`} onClick={() => { cancelAtlasPreview(); setPreviewItem(item); }} />}
                <div className={`productImage${item.image ? " hasImage" : ""}`} style={{ backgroundPosition: item.crop }}>{item.image && <img src={item.image} alt="" loading="lazy" decoding="async" onLoad={(event) => {
                  const card = event.currentTarget.closest<HTMLElement>(".productCard");
                  if (mode === "space" && card && atlasHoverCardRef.current === card && card.matches(":hover") && card.style.getPropertyValue("--hover-scale")) applyNaturalPreviewGeometry(card);
                }} />}</div>
                <div className="productMeta">
                  <div className="scoreRow"><span>{mosaicBrandLabel(item, showClothingFallback)}</span><b>{item.score}</b></div>
                  <h3>{item.name}</h3><p>{item.reason ?? (showClothingFallback ? `${item.color} · ${item.fit}` : `${item.category} · ${item.source}`)}</p>
                  <strong>{item.kind === "reference" ? (showClothingFallback ? "Ancre de style" : "Référence") : item.kind === "owned" ? (showClothingFallback ? "Dans mon dressing" : "Possédé") : item.price == null ? "Prix inconnu" : `${item.currency} ${item.price.toFixed(2)}`}{showClothingFallback && item.kind === "shop" && item.sizeAvailabilityKnown && <em className="sizeSummary"> · {item.sizes.length ? item.sizes.slice(0, 5).join(" ") : "épuisé"}</em>}</strong>
                  {item.kind === "shop" && <small className={atlasIsStale(item.stockCheckedAt) ? "freshness stale" : "freshness"} title={showClothingFallback ? `Stock ${atlasTimestamp(item.stockCheckedAt)} · prix ${atlasTimestamp(item.priceCheckedAt)} · tailles ${atlasTimestamp(item.sizesCheckedAt)}` : `Disponibilité ${atlasTimestamp(item.stockCheckedAt)} · prix ${atlasTimestamp(item.priceCheckedAt)}`}>{atlasIsStale(item.stockCheckedAt) ? "◷ à vérifier" : `● stock ${atlasTimestamp(item.stockCheckedAt)}`}</small>}
                </div>
                {item.kind !== "shop" && <span className="kindBadge">{item.kind === "reference" ? "RÉF" : "MOI"}</span>}
                {item.decision === "owned" && item.kind === "shop" && <span className="kindBadge">MOI</span>}
              </article>
            ))}
            {products.length === 0 && (
              <div className="emptyBoard">
                <strong>{catalogStatus === "chargement…" ? "Chargement de l’espace…" : showClothingFallback && scope === "owned" ? "Ton dressing attend sa première pièce" : showClothingFallback && scope === "outfits" ? "Aucune planche de tenue ici" : showClothingFallback ? `Aucun article${selectedSizes.length ? ` confirmé en ${selectedSizes.join(" ou ")}` : ""}` : "Cet espace attend ses premiers éléments"}</strong>
                <span>{catalogStatus === "chargement…" ? "Mosaic prépare les champs, collections et positions du board." : showClothingFallback && scope === "owned" ? "Ajoute une photo et quelques métadonnées : Luna pourra ensuite évaluer les vrais ajouts à ta garde-robe." : showClothingFallback && scope === "outfits" ? "Sélectionne ＋ sur quelques cartes, puis ouvre Tenues pour les assembler." : showClothingFallback ? "Les tailles inconnues et les rejetés restent exclus par défaut." : "Ajoute une image, colle une URL ou demande à l’assistant de démarrer une recherche."}</span>
                {(showClothingFallback && scope === "owned" || scope === "reference") && <button className="primaryButton" onClick={() => setDrawer("add")}>＋ Ajouter {showClothingFallback ? "une pièce" : "un élément"}</button>}
                {catalogStatus.includes("indisponible") && <button className="primaryButton" onClick={() => void retryAtlasCatalog()}>Réessayer</button>}
              </div>
            )}
            {mode === "grid" && renderLimit < products.length && <button ref={loadMoreRef} className="loadMore" onClick={() => setRenderWindow((current) => ({ signature: renderSignature, limit: Math.min((current.signature === renderSignature ? current.limit : ATLAS_PAGE_SIZE) + ATLAS_PAGE_SIZE, products.length) }))}>Afficher {Math.min(ATLAS_PAGE_SIZE, products.length - renderLimit)} de plus</button>}
            </div>
          </div>
        </div>
        {mode === "space" && <canvas ref={atlasMinimapRef} className="atlasMinimap" width={360} height={220} aria-label="Minimap du board" onPointerDown={navigateAtlasMinimap} onPointerMove={navigateAtlasMinimap} />}

        <footer className="boardFooter atlasBoardFooter"><span><b>{products.length}</b> éléments · {renderedProducts.length} rendus{staleCount ? ` · ${staleCount} à vérifier` : ""}</span><span>Flèches naviguent · Espace sélectionne · S garde · R rejette · ⌘Z annule</span><span>Placement X/Y · voisinage visuel</span></footer>
      </section>
      </section>

      {selectedItems.length > 0 && (
        <aside className="mosaicSelectionTray" aria-label={`${selectedItems.length} élément${selectedItems.length > 1 ? "s" : ""} sélectionné${selectedItems.length > 1 ? "s" : ""}`}>
          <div className="mosaicSelectionThumbs" aria-hidden="true">{selectedItems.slice(0, 5).map((item) => item.image ? <img src={item.image} alt="" key={item.id} /> : <span key={item.id}>{item.brand.slice(0, 1)}</span>)}</div>
          <strong>{selectedItems.length} sélectionné{selectedItems.length > 1 ? "s" : ""}</strong>
          <div className="mosaicTrayActions">
            <button onClick={() => setDrawer("collections")}>▣ Collection</button>
            <button onClick={() => { setPromptProductIds((current) => [...new Set([...current, ...selectedItems.map((item) => item.id)])].slice(-12)); setSelectedIds(new Set()); setComposerExpanded(true); requestAnimationFrame(() => composerInputRef.current?.focus()); }}>✦ Demander à l’IA</button>
            <button onClick={() => { setCompareIds(new Set(selectedItems.slice(0, 4).map((item) => item.id))); setDrawer("compare"); }}>⇄ Comparer</button>
            <button onClick={() => setDrawer("studio")}>◩ Studio</button>
          </div>
          <button className="mosaicTrayClear" onClick={() => setSelectedIds(new Set())} aria-label="Vider la sélection">×</button>
        </aside>
      )}

      {compareItems.length > 0 && (
        <aside className={`compareDock${selectedItems.length ? " behindSelection" : ""}`} aria-label={`${compareItems.length} élément${compareItems.length > 1 ? "s" : ""} à comparer`}>
          <div className="compareDockThumbs" aria-hidden="true">
            {compareItems.map((item) => item.image
              ? <img key={item.id} src={item.image} alt="" />
              : <span key={item.id}>{item.brand.slice(0, 1)}</span>)}
          </div>
          <button className="compareDockOpen" onClick={() => setDrawer("compare")}>Comparer ({compareItems.length}/4)</button>
          <button className="compareDockClear" onClick={() => setCompareIds(new Set())}>Vider</button>
        </aside>
      )}

      {drawer && (
        <div className="drawerBackdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setDrawer(null); }}>
          <aside ref={drawerRef} tabIndex={-1} className={`drawer drawer-${drawer}`} role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <header><div><span className="eyebrow">Mosaic</span><h2 id="drawer-title">{drawer === "filters" ? "Filtres" : drawer === "view" ? "Vue" : drawer === "compare" ? "Comparer" : drawer === "views" ? "Vues sauvegardées" : drawer === "collections" ? "Collections" : drawer === "activity" ? "Activité" : drawer === "studio" ? "Studio" : drawer === "add" ? "Ajouter au catalogue" : showClothingFallback ? "Planches de tenues" : "Détails"}</h2></div><button ref={drawerCloseRef} className="drawerClose" onClick={() => setDrawer(null)} aria-label="Fermer">×</button></header>

            {drawer === "filters" && (
              <div className="drawerBody mosaicFiltersDrawer">
                {showClothingFallback && <div className="mosaicFilterSection"><header><div><span>Catégorie</span><small>{products.length} résultats</small></div></header><div className="mosaicChoiceGrid">{atlasCategories.map((filter) => <button type="button" key={filter} className={activeFilter === filter ? "active" : ""} onClick={() => setActiveFilter(filter)}><span>{filter}</span><b>{categoryCounts[filter] ?? 0}</b></button>)}</div></div>}
                <div className="mosaicFilterSection"><header><span>Source</span></header><label><span>Origine</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">Toutes les sources</option><option value="shop">Tous les shops</option><option value="zalando">Zalando</option><option value="aboutyou">About You</option><option value="aliexpress">AliExpress</option>{extraShopSources.map((source) => <option key={source} value={`source:${source}`}>{source}</option>)}{showClothingFallback && <option value="owned">Dressing</option>}<option value="reference">Références</option></select></label></div>
                {dynamicFilterFields.length > 0 && <div className="mosaicDynamicFilters"><div className="mosaicDrawerHeading"><span>Champs de l’espace</span><small>{dynamicFilterFields.length} disponibles</small></div>{dynamicFilterFields.map((field) => {
                  const selected = dynamicFacetSelections[field.key] ?? [];
                  const configured = (field.options ?? []).map((option) => typeof option === "string" ? { value: option, label: option, count: 0 } : { value: option.value, label: option.label ?? option.value, count: 0 });
                  const facets = workspaceSchema?.facets[field.key]?.length ? workspaceSchema.facets[field.key] : configured;
                  if (field.type === "number") {
                    const range = dynamicNumberFilters[field.key] ?? { min: "", max: "" };
                    return <div className="mosaicFilterSection" key={field.key}><header><div><span>{field.label}</span><small>{field.unit ?? "nombre"}</small></div></header><div className="priceRange"><label><span>Minimum</span><input inputMode="decimal" value={range.min} onChange={(event) => setDynamicNumberFilters((current) => ({ ...current, [field.key]: { ...range, min: event.target.value.replace(/[^0-9.-]/g, "") } }))} /></label><label><span>Maximum</span><input inputMode="decimal" value={range.max} onChange={(event) => setDynamicNumberFilters((current) => ({ ...current, [field.key]: { ...range, max: event.target.value.replace(/[^0-9.-]/g, "") } }))} /></label></div></div>;
                  }
                  if (field.type === "boolean") return <div className="mosaicFilterSection" key={field.key}><header><span>{field.label}</span></header><div className="mosaicChoiceGrid"><button type="button" className={selected.includes("true") ? "active" : ""} onClick={() => setDynamicFacetSelections((current) => ({ ...current, [field.key]: selected.includes("true") ? [] : ["true"] }))}>Oui</button><button type="button" className={selected.includes("false") ? "active" : ""} onClick={() => setDynamicFacetSelections((current) => ({ ...current, [field.key]: selected.includes("false") ? [] : ["false"] }))}>Non</button></div></div>;
                  if (facets.length) return <div className="mosaicFilterSection" key={field.key}><header><div><span>{field.label}</span><small>{field.cardinality ? `${field.cardinality} valeurs` : `${facets.length} options`}</small></div></header><div className="mosaicChoiceGrid">{facets.slice(0, 24).map((facet) => <button type="button" key={facet.value} className={selected.includes(facet.value) ? "active" : ""} onClick={() => setDynamicFacetSelections((current) => ({ ...current, [field.key]: selected.includes(facet.value) ? selected.filter((value) => value !== facet.value) : [...selected, facet.value] }))}><span>{facet.label ?? facet.value}</span><b>{facet.count || ""}</b></button>)}</div></div>;
                  return <div className="mosaicFilterSection" key={field.key}><label><span>{field.label}</span><input type={field.type === "date" ? "date" : "text"} value={selected[0] ?? ""} onChange={(event) => setDynamicFacetSelections((current) => ({ ...current, [field.key]: event.target.value ? [event.target.value] : [] }))} placeholder={`Filtrer ${field.label.toLocaleLowerCase()}…`} /></label></div>;
                })}</div>}
                {showClothingFallback && <div className="mosaicFilterSection"><header><div><span>Tailles</span><small>{selectedSizes.length ? `${selectedSizeMatchCount} correspondances` : `${knownSizeCount} fiches fraîches en stock`}</small></div></header><div className="mosaicChoiceGrid mosaicSizeGrid">{sizeOptions.map((size) => <button type="button" key={size} className={selectedSizes.includes(size) ? "active" : ""} aria-pressed={selectedSizes.includes(size)} onClick={() => toggleAtlasSize(size)}><span>{size}</span><b>{sizeCounts[size] ?? 0}</b></button>)}</div><p>OU entre les tailles · disponibilité connue, en stock et vérifiée sous 48 h.</p>{uncheckedGarmentItems.length > 0 && <button className="mosaicRefresh" disabled={Boolean(refreshJob && !(refreshJob.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(refreshJob.status)))} onClick={() => void startAtlasUnknownSizeRefresh()}>↻ Vérifier {uncheckedGarmentItems.length} fiches Zalando</button>}</div>}
                {showClothingFallback && <div className="mosaicFilterSection mosaicFilterColumns"><label><span>Prix</span><select value={priceFilter} onChange={(event) => setPriceFilter(event.target.value)}><option value="all">Tous</option><option value="under50">&lt; 50 CHF</option><option value="50to100">50–100 CHF</option><option value="100to180">100–180 CHF</option><option value="over180">&gt; 180 CHF</option></select></label><label><span>Coupe</span><select value={fitFilter} onChange={(event) => setFitFilter(event.target.value)}><option value="all">Toutes</option><option value="large">Large</option><option value="courte">Courte</option><option value="court">Court</option><option value="droite">Droite</option><option value="relax">Relax</option><option value="unknown">Inconnue</option></select></label><label><span>Matière</span><select value={materialFilter} onChange={(event) => setMaterialFilter(event.target.value)}><option value="all">Toutes</option><option value="knit">Maille / laine</option><option value="linen">Lin</option><option value="cotton">Coton</option><option value="leather">Cuir</option><option value="denim">Denim</option></select></label><label><span>Fraîcheur</span><select value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}><option value="all">Toutes</option><option value="available">En stock</option><option value="fresh">Vérifié &lt; 48 h</option><option value="stale">À rafraîchir</option></select></label></div>}
                <div className="mosaicFilterSection"><label><span>Recherche dans les attributs</span><input value={attributeQuery} onChange={(event) => setAttributeQuery(event.target.value)} placeholder={showClothingFallback ? "olive, texturé, sans logo…" : activeWorkspace?.profile === "televisions" ? "OLED, 120 Hz, HDMI 2.1…" : "mot-clé, valeur ou attribut…"} /></label><div className="priceRange"><label><span>Prix minimum</span><input inputMode="numeric" value={minPrice} onChange={(event) => setMinPrice(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" /></label><label><span>Prix maximum</span><input inputMode="numeric" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="180" /></label></div><label className="checkboxLine"><input type="checkbox" checked={includeRejected} onChange={(event) => setIncludeRejected(event.target.checked)} /> Inclure les éléments rejetés</label></div>
                <div className="drawerFooter mosaicStickyFooter"><button type="button" onClick={resetAtlasFilters}>{showClothingFallback ? "Réinitialiser · M ou L" : "Réinitialiser les filtres"}</button><button className="primaryButton" type="button" onClick={() => setDrawer(null)}>Voir {products.length} résultats</button></div>
              </div>
            )}

            {drawer === "collections" && (
              <div className="drawerBody mosaicCollectionsDrawer">
                <form className="mosaicCollectionCreate" onSubmit={(event) => void createMosaicCollection(event)}><input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="Nouvelle collection" aria-label="Nom de la collection" /><button className="primaryButton" disabled={!collectionName.trim()}>Créer{selectedIds.size ? ` avec ${selectedIds.size}` : ""}</button></form>
                <p className="drawerHint">Une collection peut guider l’assistant, filtrer le board ou recevoir la sélection courante.</p>
                <div className="mosaicSystemCollections">
                  <button onClick={() => { if (selectedItems.length) { selectedItems.filter((item) => item.decision !== "saved").forEach((item) => { void setAtlasDecision(item, "saved"); }); setSelectedIds(new Set()); setToast(`${selectedItems.length} élément${selectedItems.length > 1 ? "s" : ""} ajouté${selectedItems.length > 1 ? "s" : ""} aux favoris`); } else { setScope("saved"); setSelectedCollectionId(null); setDrawer(null); } }}><span className="mosaicCollectionIcon coral">♥</span><div><strong>Favoris</strong><small>{catalogItems.filter((item) => item.decision === "saved").length} éléments</small></div><i>{selectedItems.length ? `＋ ${selectedItems.length}` : "Vue système"}</i></button>
                  {showClothingFallback && <button onClick={() => { setScope("owned"); setSelectedCollectionId(null); setDrawer(null); }}><span className="mosaicCollectionIcon moss">◆</span><div><strong>Dressing</strong><small>{ownedItems.length} éléments</small></div><i>Vue système</i></button>}
                  {showClothingFallback && <button onClick={() => setDrawer("outfits")}><span className="mosaicCollectionIcon ochre">⊞</span><div><strong>Tenues</strong><small>{outfitBoards.length} planches</small></div><i>Compatibilité</i></button>}
                </div>
                <div className="mosaicDrawerHeading"><span>Mes collections</span><small>{collectionsApiAvailable ? "Synchronisées localement" : "Mode local de secours"}</small></div>
                <div className="mosaicCollectionList">{mosaicCollections.map((collection) => {
                  const items = collection.itemIds.map((id) => catalogItems.find((item) => item.id === id)).filter(Boolean) as AtlasItem[];
                  return <article key={collection.id}><button className="mosaicCollectionMain" onClick={() => { setSelectedCollectionId(collection.id); setScope("catalogue"); setDrawer(null); }}><span className="mosaicCollectionMosaic">{items.slice(0, 4).map((item) => item.image ? <img key={item.id} src={item.image} alt="" /> : <i key={item.id} />)}{!items.length && <b>▣</b>}</span><span><strong>{collection.name}</strong><small>{collection.itemIds.length} élément{collection.itemIds.length > 1 ? "s" : ""}</small></span></button><div>{selectedIds.size > 0 && <button onClick={() => void addSelectionToMosaicCollection(collection)}>＋ {selectedIds.size}</button>}<button className={promptCollectionIds.includes(collection.id) ? "active" : ""} onClick={() => { setPromptCollectionIds((current) => current.includes(collection.id) ? current.filter((id) => id !== collection.id) : [...current, collection.id].slice(-12)); setComposerExpanded(true); setDrawer(null); window.setTimeout(() => composerInputRef.current?.focus(), 0); }}>✦ IA</button></div></article>;
                })}{mosaicCollections.length === 0 && <div className="drawerEmpty"><strong>Crée ta première collection</strong><span>Sélectionne des éléments sur le board, puis rassemble-les ici sans modifier leur statut.</span></div>}</div>
              </div>
            )}

            {drawer === "activity" && (
              <div className="drawerBody mosaicActivityDrawer">
                <p className="drawerHint">Les tâches et erreurs vivent ici pour laisser le board calme. Rien n’est repris automatiquement après un blocage.</p>
                <div className="mosaicActivityList">
                  {embeddingJob && <article className={embeddingJob.status === "failed" ? "failed" : ""}><span className="mosaicRunIcon">◎</span><div><strong>Placement visuel local</strong><small>{embeddingJob.message ?? (embeddingJob.status === "idle" ? "Optionnel · rapproche les images qui se ressemblent" : embeddingJob.status)}{embeddingJob.summary ? ` · ${embeddingJob.summary.embedded} images` : ""}</small>{embeddingJob.status === "running" && <progress max={Math.max(1, embeddingJob.total)} value={embeddingJob.processed} />}</div>{embeddingJob.status !== "running" && <button onClick={() => void startMosaicEmbedding()}>{embeddingJob.status === "succeeded" ? "Actualiser" : embeddingJob.status === "failed" ? "Réessayer" : "Améliorer"}</button>}</article>}
                  {refreshJob && <article className={["error", "blocked"].includes(refreshJob.status) ? "failed" : ""}><span className="mosaicRunIcon">↻</span><div><strong>{refreshJob.message ?? "Actualisation des fiches"}</strong><small>{progressTotal ? `${progressDone}/${progressTotal}` : refreshJob.status}{refreshJob.error ? ` · ${mosaicCompactRunError(refreshJob.error)}` : ""}</small>{progressTotal > 0 && <progress max={progressTotal} value={progressDone} />}</div>{refreshNeedsResume ? refreshJob.canResume !== false && <button onClick={() => void retryAtlasRefresh()}>Reprendre</button> : !(refreshJob.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(refreshJob.status)) && <button onClick={() => void cancelAtlasRefresh()}>Arrêter</button>}</article>}
                  {discoveryJobs.length > 0 && <article className={discoveryHasFailures ? "failed" : ""}><span className="mosaicRunIcon">⌕</span><div><strong>{discoveryPlan?.name ?? "Découverte agentique"}</strong><small>{discoveryStatusText} · {discoveryDiscovered} nouveaux · {discoverySources.join(" + ")}</small><progress max={1} value={discoveryProgress} /></div>{discoveryBusy && discoveryHasActive ? <button onClick={() => void cancelAtlasDiscovery()}>Arrêter</button> : discoveryCanResume ? <button onClick={() => void resumeAtlasDiscovery()}>Reprendre</button> : null}</article>}
                  {mosaicRuns.map((run) => { const kind = run.kind ?? run.type; return <article className={["failed", "error", "blocked"].includes(run.status) ? "failed" : ""} key={run.id}><span className="mosaicRunIcon">{kind === "assistant" ? "✦" : kind === "import" ? "↓" : kind === "artifact" ? "◩" : "◷"}</span><div><strong>{run.title ?? run.label ?? run.message ?? kind ?? "Tâche Mosaic"}</strong><small>{run.status}{run.source ? ` · ${run.source}` : ""}{run.error ? ` · ${mosaicCompactRunError(run.error)}` : ""}{run.updatedAt || run.createdAt ? ` · ${atlasTimestamp(run.updatedAt ?? run.createdAt)}` : ""}</small>{(run.total ?? 0) > 0 && <progress max={run.total} value={run.completed ?? Math.round((run.progress ?? 0) * (run.total ?? 1))} />}</div></article>; })}
                  {!embeddingJob && !refreshJob && !discoveryJobs.length && !mosaicRuns.length && <div className="drawerEmpty"><strong>Aucune activité récente</strong><span>Les imports, analyses et actualisations apparaîtront ici avec leur progression.</span></div>}
                </div>
              </div>
            )}

            {drawer === "studio" && (
              <div className="drawerBody mosaicStudioDrawer">
                <div className="mosaicPrivacyNote"><span>⌁</span><div><strong>Studio local, privé par défaut</strong><p>Le brouillon enregistre uniquement les références choisies. Les aperçus visuels sont des approximations ; aucune image n’est envoyée à un fournisseur externe dans cette version.</p></div></div>
                <form onSubmit={(event) => void createMosaicArtifact(event)}><label><span>Nom du brouillon</span><input value={artifactName} onChange={(event) => setArtifactName(event.target.value)} placeholder={showClothingFallback ? "Planche matières chaudes" : "Planche de recherche"} /></label><div className="mosaicStudioContext"><span>{selectedIds.size || promptProductIds.length} éléments</span><span>{promptImages.length + personalImages.length} images de référence</span>{aiPrompt.trim() && <span>Prompt joint</span>}</div><button className="primaryButton" disabled={artifactBusy}>{artifactBusy ? "Enregistrement…" : "Créer le brouillon"}</button></form>
                <p className="drawerHint">{artifactsApiAvailable ? "Le service local d’artifacts est disponible. Aucun rendu distant n’est lancé." : "Fournisseur de génération non configuré. Les brouillons restent utilisables et persistés localement."}</p>
                <div className="mosaicDrawerHeading"><span>Brouillons</span><small>{mosaicArtifacts.length}</small></div>
                <div className="mosaicArtifactList">{mosaicArtifacts.map((artifact) => <article key={artifact.id}><span className="mosaicArtifactThumbs">{artifact.imageReferences?.slice(0, 3).some((reference) => /^(?:\/api\/|data:image\/)/.test(reference)) ? artifact.imageReferences.slice(0, 3).map((reference) => /^(?:\/api\/|data:image\/)/.test(reference) ? <img key={reference} src={reference} alt="" /> : null) : "◩"}</span><div><strong>{artifact.name}</strong><small>{artifact.itemIds.length} éléments · {artifact.imageReferences?.length ?? 0} images · {artifact.status ?? "draft"}</small>{artifact.prompt && <p>{artifact.prompt}</p>}</div></article>)}{mosaicArtifacts.length === 0 && <div className="drawerEmpty"><strong>Aucun brouillon Studio</strong><span>Sélectionne quelques éléments ou joins des images au prompt, puis enregistre une direction visuelle réutilisable.</span></div>}</div>
              </div>
            )}

            {drawer === "compare" && (
              <div className="drawerBody">
                {compareItems.length === 0 ? <div className="drawerEmpty"><strong>Aucun élément à comparer</strong><span>Utilise ⇄ sur les cartes. Quatre éléments maximum, pour garder la décision lisible.</span></div> : <>
                  <div className="compareGrid" style={{ "--compare-count": compareItems.length } as CSSProperties}>
                    <b className="compareLabel">Élément</b>{compareItems.map((item) => <div className="compareHead" key={item.id}>{item.image ? <img src={item.image} alt="" /> : <span className="imageFallback" />}<strong>{mosaicBrandLabel(item, showClothingFallback)}</strong><span>{item.name}</span><button onClick={() => toggleCompare(item.id)} aria-label={`Retirer ${item.name}`}>×</button></div>)}
                    <b className="compareLabel">Prix</b>{compareItems.map((item) => <span key={item.id}>{item.price == null ? "—" : `${item.currency} ${item.price.toFixed(2)}`}{item.originalPrice ? <del>{item.originalPrice.toFixed(2)}</del> : null}</span>)}
                    {showClothingFallback && <><b className="compareLabel">Tailles</b>{compareItems.map((item) => <span key={item.id}>{item.sizeAvailabilityKnown ? item.sizes.join(" · ") || "Épuisé" : "Inconnues"}</span>)}<b className="compareLabel">Matière</b>{compareItems.map((item) => <span key={item.id}>{item.materials.join(", ") || "Non renseignée"}</span>)}</>}
                    <b className="compareLabel">Retours</b>{compareItems.map((item) => <span key={item.id}>{item.returnsLabel ?? (item.returnsWindowDays ? `${item.returnsWindowDays} jours` : "Inconnus")}</span>)}
                    <b className="compareLabel">Stock</b>{compareItems.map((item) => <span className={atlasIsStale(item.stockCheckedAt) ? "staleText" : ""} key={item.id}>{atlasTimestamp(item.stockCheckedAt)}</span>)}
                    <b className="compareLabel">Prix vérifié</b>{compareItems.map((item) => <span className={atlasIsStale(item.priceCheckedAt) ? "staleText" : ""} key={item.id}>{atlasTimestamp(item.priceCheckedAt)}</span>)}
                    {showClothingFallback && <><b className="compareLabel">Tailles vérifiées</b>{compareItems.map((item) => <span className={atlasIsStale(item.sizesCheckedAt) ? "staleText" : ""} key={item.id}>{atlasTimestamp(item.sizesCheckedAt)}</span>)}</>}
                    {workspaceDisplayFields.flatMap((field) => {
                      if (["price", "materials", "sizes", "returnsLabel", "returnsWindowDays"].includes(field.key)) return [];
                      const values = compareItems.map((item) => mosaicFieldDisplayValue(item, field));
                      if (!values.some(Boolean)) return [];
                      return [<b className="compareLabel" key={`${field.key}-label`}>{field.label}</b>, ...values.map((value, index) => <span key={`${field.key}-${compareItems[index]?.id}`}>{value ?? "—"}</span>)];
                    })}
                    <b className="compareLabel">Pourquoi</b>{compareItems.map((item) => <span key={item.id}>{item.reason ?? "Pas encore évalué par Luna"}</span>)}
                    <b className="compareLabel">Décision</b>{compareItems.map((item) => <div className="compareDecision" key={item.id}><button className={item.decision === "saved" ? "active" : ""} onClick={() => void setAtlasDecision(item, "saved")}>♥ Garder</button><button className={item.decision === "owned" ? "active" : ""} onClick={() => void setAtlasDecision(item, "owned")}>◆</button><button onClick={() => void setAtlasDecision(item, "rejected")}>×</button></div>)}
                  </div>
                  <div className="drawerFooter"><button onClick={() => void startAtlasRefresh(compareItems.map((item) => item.id))}>↻ Rafraîchir ces fiches</button>{showClothingFallback && <button className="primaryButton" onClick={() => { setOutfitDraftIds(new Set(compareIds)); setDrawer("outfits"); }}>Créer une tenue</button>}</div>
                </>}
              </div>
            )}

            {drawer === "views" && (
              <div className="drawerBody">
                <form className="inlineCreate" onSubmit={(event) => void saveAtlasView(event)}><input value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="Nom de cette vue" aria-label="Nom de la vue" /><button className="primaryButton">Sauvegarder</button></form>
                <p className="drawerHint">La vue mémorise scope, filtres, rendu d’image, axes et mode{showClothingFallback ? ", ainsi que les tailles" : ""} — jamais ton prompt, ton zoom ou ta position.</p>
                <div className="savedList">{savedViews.map((view) => <div className="savedRow" key={view.id}><button className="savedMain" onClick={() => applyAtlasView(view)}><strong>{view.name}</strong><span>{showClothingFallback ? atlasScopes.find((item) => item.id === view.scope)?.label : view.scope === "saved" ? "Gardés" : view.scope === "reference" ? "Références" : "Catalogue"} · {showClothingFallback ? `${view.activeFilter} · ` : ""}{view.mode === "space" ? "PCA" : "grille"} · {view.imageMode === "full" ? "images entières" : "recadrées"}{showClothingFallback && view.sizeFilters.length ? ` · ${view.sizeFilters.join(" ou ")}` : ""}</span></button><button className="iconDanger" onClick={() => void deleteAtlasView(view.id)} aria-label={`Supprimer ${view.name}`}>×</button></div>)}{savedViews.length === 0 && <div className="drawerEmpty"><strong>Aucune vue sauvegardée</strong><span>Compose un filtre précis, puis reviens ici pour le garder.</span></div>}</div>
                <div className="drawerFooter"><button onClick={exportAtlasJson}>⇩ Exporter le scope en JSON</button></div>
              </div>
            )}

            {drawer === "add" && (
              <form className="drawerBody personalForm" onSubmit={(event) => void addAtlasPersonalItem(event)}>
                <div className="kindSwitch segmented"><button type="button" className={personalKind === "owned" ? "active" : ""} onClick={() => setPersonalKind("owned")}>◆ {showClothingFallback ? "Possédé" : "Élément local"}</button><button type="button" className={personalKind === "reference" ? "active" : ""} onClick={() => setPersonalKind("reference")}>◈ Référence</button><button type="button" className={personalKind === "shop" ? "active" : ""} onClick={() => setPersonalKind("shop")}>↗ Lien produit</button></div>
                {personalKind === "shop" ? <>
                  <label>URL de la fiche produit<input name="url" type="url" required placeholder={showClothingFallback ? "https://www.arket.com/…" : "https://www.example.com/product…"} /></label>
                  <p className="drawerHint">{showClothingFallback ? "Importe les données publiques structurées : nom, prix, images, matière et tailles si le shop les expose." : "Importe les données publiques structurées : nom, prix, images et attributs exposés par la page."} Aucun login ni panier.</p>
                </> : <>
                  <input ref={personalImageInputRef} className="hiddenImageInput" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { void addAtlasPersonalImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
                  <button type="button" className="imageDrop" onClick={() => personalImageInputRef.current?.click()}><span>＋</span><strong>Ajouter des photos</strong><small>JPG, PNG ou WebP · 6 images · 24 MB max</small></button>
                  {personalImages.length > 0 && <div className="personalPreviews">{personalImages.map((image) => <span key={image.id}><img src={image.dataUrl} alt="" /><button type="button" onClick={() => setPersonalImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Retirer ${image.name}`}>×</button></span>)}</div>}
                  <label>Nom<input name="name" required placeholder={showClothingFallback ? personalKind === "owned" ? "Mon cardigan brun" : "Silhouette courte / pantalon ample" : personalKind === "owned" ? activeWorkspace?.profile === "televisions" ? "Mon téléviseur OLED" : "Mon élément" : "Référence visuelle"} /></label>
                  {showClothingFallback ? <><div className="formColumns"><label>Catégorie<select name="category"><option>Vestes</option><option>Pantalons</option><option>Mailles</option><option>Chemises</option><option>T-shirts</option><option>Chaussures</option><option>Accessoires</option><option>Autre</option></select></label><label>Couleur<input name="color" placeholder="Chocolat" /></label></div><div className="formColumns"><label>Coupe<input name="fit" placeholder="Large, courte…" /></label><label>Tags<input name="tags" placeholder="automne, texture" /></label></div></> : <><label>Description<textarea name="description" rows={3} placeholder="Contexte, usage ou détails utiles…" /></label><div className="formColumns"><label>Catégorie<input name="category" placeholder={activeWorkspace?.profile === "televisions" ? "OLED, Mini-LED…" : "Catégorie"} /></label><label>Tags<input name="tags" placeholder={activeWorkspace?.profile === "televisions" ? "salon, 4K, jeu…" : "référence, usage, priorité…"} /></label></div></>}
                </>}
                <button className="primaryButton submitPersonal" disabled={personalBusy}>{personalBusy ? "Ajout…" : personalKind === "owned" ? showClothingFallback ? "Ajouter au dressing" : "Ajouter au catalogue" : personalKind === "reference" ? "Ajouter comme référence" : "Importer la fiche"}</button>
              </form>
            )}

            {drawer === "outfits" && showClothingFallback && (
              <div className="drawerBody outfitsBody">
                <form className="inlineCreate outfitCreate" onSubmit={(event) => void createAtlasOutfit(event)}><input value={outfitName} onChange={(event) => setOutfitName(event.target.value)} placeholder="Nom de la tenue" aria-label="Nom de la tenue" /><button type="button" onClick={() => void generateAtlasOutfits()}>✦ Luna</button><button className="primaryButton" disabled={!outfitDraftIds.size && !compareIds.size}>Enregistrer</button></form>
                <p className="drawerHint">{outfitDraftIds.size ? `${outfitDraftIds.size} pièces sélectionnées sur le board.` : compareIds.size ? `${compareIds.size} pièces de la comparaison seront utilisées.` : "Clique ＋ sur les cartes pour composer une planche."}</p>
                {outfitDraftItems.length > 0 && <div className="outfitStrip">{outfitDraftItems.map((item) => <button key={item.id} onClick={() => toggleOutfitDraft(item.id)} title={`Retirer ${item.name}`}>{item.image ? <img src={item.image} alt="" /> : <span className="imageFallback" />}<small>×</small></button>)}</div>}
                {wardrobeGaps.length > 0 && <div className="gapNote"><span>Manques détectés</span><strong>{wardrobeGaps.join(" · ")}</strong><small>Ajoute ce que tu possèdes pour rendre ce diagnostic plus pertinent.</small></div>}
                <div className="savedList outfitList">{outfitBoards.map((board) => {
                  const boardProducts = board.productIds.map((id) => catalogItems.find((item) => item.id === id)).filter(Boolean) as AtlasItem[];
                  const ownedCount = boardProducts.filter((item) => item.kind === "owned" || item.decision === "owned").length;
                  const scoreLine = board.metadata?.compatibilityScore != null ? `Compatibilité ${board.metadata.compatibilityScore}/100 · nouveauté ${board.metadata.noveltyScore ?? "—"}/100` : board.description;
                  return <div className="savedRow" key={board.id}><button className="savedMain outfitRow" onClick={() => { setSelectedOutfitBoardId(board.id); setScope("outfits"); setDrawer(null); }}><span className="outfitThumbs">{boardProducts.slice(0, 4).map((item) => item.image ? <img src={item.image} alt="" key={item.id} /> : <i key={item.id} />)}</span><strong>{board.name}</strong><span>{scoreLine ?? `${boardProducts.length} pièces · ${ownedCount} déjà possédée${ownedCount > 1 ? "s" : ""}`}</span></button><button className="iconDanger" onClick={() => void deleteAtlasOutfit(board.id)} aria-label={`Supprimer ${board.name}`}>×</button></div>;
                })}{outfitBoards.length === 0 && <div className="drawerEmpty"><strong>Pas encore de tenue</strong><span>Assemble un achat potentiel avec des pièces de ton dressing pour voir s’il crée vraiment de nouvelles tenues.</span></div>}</div>
              </div>
            )}
          </aside>
        </div>
      )}

      {previewProduct && (
        <div className="productPreviewBackdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setPreviewItem(null); }}>
          <section ref={previewDialogRef} tabIndex={-1} className="productPreviewDialog" role="dialog" aria-modal="true" aria-labelledby="product-preview-title">
            <header>
              <div><span>{mosaicBrandLabel(previewProduct, showClothingFallback)}</span><h2 id="product-preview-title">{previewProduct.name}</h2></div>
              <div className="productPreviewActions">
                <strong>{previewProduct.price == null ? "Prix inconnu" : `${previewProduct.currency} ${previewProduct.price.toFixed(2)}`}</strong>
                <button className="productPreviewRefresh" type="button" disabled={Boolean(refreshJob && !(refreshJob.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(refreshJob.status)))} onClick={() => void startAtlasRefresh([previewProduct.id])}>↻ Actualiser</button>
                {previewProduct.url && <a href={previewProduct.url} target="_blank" rel="noopener noreferrer">Ouvrir dans un onglet ↗</a>}
                <button ref={previewCloseRef} type="button" onClick={() => setPreviewItem(null)} aria-label="Fermer la prévisualisation">×</button>
              </div>
            </header>
            <div className="productQuickLook">
              <div className={`productPreviewGallery gallery-${Math.min(4, Math.max(1, previewProduct.images.length))}`}>
                {(previewProduct.images.length ? previewProduct.images : previewProduct.image ? [previewProduct.image] : []).map((image, imageIndex) => <img key={`${previewProduct.id}-${imageIndex}`} src={image} alt={`${previewProduct.name} — vue ${imageIndex + 1}`} />)}
                {!previewProduct.images.length && !previewProduct.image && <div className="productPreviewNoImage">Aucune image capturée</div>}
              </div>
              <aside className="productPreviewFacts">
                <section className="productPreviewTools" data-testid="product-preview-actions"><span>Actions</span><div>
                  <button type="button" className={previewProduct.decision === "saved" ? "active" : ""} onClick={() => void setAtlasDecision(previewProduct, "saved")}>{previewProduct.decision === "saved" ? "♥ Gardé" : "♡ Garder"}</button>
                  <button type="button" className={compareIds.has(previewProduct.id) ? "active" : ""} onClick={() => toggleCompare(previewProduct.id)}>⇄ Comparer</button>
                  <button type="button" onClick={() => { addAtlasProductToPrompt(previewProduct); setPreviewItem(null); }}>✦ Utiliser avec l’IA</button>
                  {showClothingFallback && <button type="button" className={outfitDraftIds.has(previewProduct.id) ? "active" : ""} onClick={() => toggleOutfitDraft(previewProduct.id)}>＋ Tenue</button>}
                  <button type="button" className={previewProduct.decision === "owned" ? "active" : ""} onClick={() => void setAtlasDecision(previewProduct, "owned")}>◆ Possédé</button>
                  <button type="button" className={previewProduct.decision === "rejected" ? "active reject" : "reject"} onClick={() => void setAtlasDecision(previewProduct, "rejected")}>× Rejeter</button>
                </div></section>
                <section><span>Prix</span><strong>{previewProduct.price == null ? "Inconnu" : <>{previewProduct.currency} {previewProduct.price.toFixed(2)}{previewProduct.originalPrice && previewProduct.originalPrice > previewProduct.price ? <del>{previewProduct.currency} {previewProduct.originalPrice.toFixed(2)}</del> : null}</>}</strong><small>Prix {atlasTimestamp(previewProduct.priceCheckedAt)}</small></section>
                <section><span>Disponibilité</span><strong>{previewProduct.stockStatus === "in_stock" ? "En stock" : previewProduct.stockStatus === "out_of_stock" ? "Épuisé" : "À vérifier"}</strong><small>Stock {atlasTimestamp(previewProduct.stockCheckedAt)}</small></section>
                {showClothingFallback && <section><span>Tailles</span><div className="productPreviewSizes">{previewProduct.sizeAvailabilityKnown ? previewProduct.sizes.length ? previewProduct.sizes.map((size) => <b key={size}>{size}</b>) : <em>Épuisé</em> : <em>Pas encore vérifiées</em>}</div><small>Tailles {atlasTimestamp(previewProduct.sizesCheckedAt)}</small></section>}
                <section><span>Détails</span><dl>{showClothingFallback ? <><div><dt>Catégorie</dt><dd>{previewProduct.category}</dd></div><div><dt>Couleur</dt><dd>{previewProduct.color}</dd></div><div><dt>Coupe</dt><dd>{previewProduct.fit}</dd></div><div><dt>Matière</dt><dd>{previewProduct.materials.join(", ") || "Inconnue"}</dd></div><div><dt>Retours</dt><dd>{previewProduct.returnsLabel ?? (previewProduct.returnsWindowDays ? `${previewProduct.returnsWindowDays} jours` : "Inconnus")}</dd></div></> : <><div><dt>Catégorie</dt><dd>{previewProduct.category || "Non renseignée"}</dd></div><div><dt>Source</dt><dd>{previewProduct.source}</dd></div>{workspaceDisplayFields.flatMap((field) => { const value = mosaicFieldDisplayValue(previewProduct, field); return value && !["category", "source", "price"].includes(field.key) ? [<div key={field.key}><dt>{field.label}</dt><dd>{value}</dd></div>] : []; })}</>}</dl></section>
                {previewProduct.reason && <section><span>Vision Luna</span><p>{previewProduct.reason}</p></section>}
                <p className="productPreviewNote">Aperçu local fiable. Les shops bloquent généralement leur intégration en iframe ; ouvre l’onglet pour la fiche complète.</p>
              </aside>
            </div>
          </section>
        </div>
      )}

      <div className="toast" role="status" aria-live="polite" aria-atomic="true">{toast}</div>
    </main>
  );
}
