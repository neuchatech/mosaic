"use client";

/* Remote shop imagery cannot use the framework image proxy; cards provide their own lazy loading. */
/* eslint-disable @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions */

import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
            <label className="quickFilter"><small>Source</small><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">Toutes</option><option value="shop">Tous shops</option><option value="zalando">Zalando</option><option value="aliexpress">AliExpress</option><option value="reference">Références</option></select></label>
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
type AtlasDrawer = "compare" | "views" | "add" | "outfits" | null;
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

type AtlasDiscoverySession = { plan: AtlasDiscoveryPlan; jobIds: string[] };

const ATLAS_API = "http://localhost:8788/api";
const ATLAS_ORIGIN = ATLAS_API.slice(0, -4);
const ATLAS_PAGE_SIZE = 240;
const ATLAS_DEFAULT_ZOOM = 2;
const ATLAS_MAX_IMAGES = 6;
const ATLAS_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ATLAS_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const ATLAS_DEMO_FRESH_AT = "2026-08-28T12:00:00.000Z";
const ATLAS_TERMINAL_REFRESH_STATUSES = ["complete", "error", "blocked", "cancelled"];
const ATLAS_PREFERENCES_KEY = "wardrobe-atlas:board-preferences:v2";
const ATLAS_DISCOVERY_SESSION_KEY = "wardrobe-atlas:discovery-session:v1";
const ATLAS_TERMINAL_DISCOVERY_STATUSES = new Set<AtlasDiscoveryStatus>(["succeeded", "failed", "blocked", "cancelled"]);
const ATLAS_DISCOVERY_SOURCE_LABELS: Record<string, string> = { "zalando-ch": "Zalando CH", aliexpress: "AliExpress" };

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
    source: item.source ?? "local", materials: item.materials ?? [], sizes, tags: item.tags ?? [],
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
  const padding = 16;
  const targetArea = items.length * nominalArea / .9;
  const baseWidth = Math.max(viewportWidth * 1.65, Math.sqrt(targetArea * viewportRatio));
  const baseHeight = Math.max(viewportHeight * 1.65, Math.sqrt(targetArea / viewportRatio));
  const nodes = items.map((item, index) => {
    const hash = [...item.id].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) | 0, 0);
    const aspect = Math.min(2.6, Math.max(.38, imageMode === "full" ? item.imageAspectRatio ?? (item.source === "aliexpress" ? 1 : .72) : 1));
    const seed = imageMode === "cropped" ? 18 : 20;
    const width = imageMode === "full" ? (aspect >= 1 ? seed * aspect : seed) : seed;
    const height = imageMode === "full" ? (aspect >= 1 ? seed : seed / aspect) : seed;
    const targetX = padding + width / 2 + xPositions[index] * Math.max(1, baseWidth - padding * 2 - width);
    const targetY = padding + height / 2 + yPositions[index] * Math.max(1, baseHeight - padding * 2 - height);
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
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
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
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
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

function atlasScaledLayout(layout: AtlasSpaceLayout, zoom: number): AtlasSpaceLayout {
  if (zoom === 1) return layout;
  return {
    width: layout.width * zoom,
    height: layout.height * zoom,
    positions: new Map([...layout.positions].map(([id, rectangle]) => [id, {
      left: rectangle.left * zoom,
      top: rectangle.top * zoom,
      width: rectangle.width * zoom,
      height: rectangle.height * zoom,
    }])),
  };
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
    yAxis: value.yAxis ?? "pca", mode: value.mode ?? "space", imageMode: value.imageMode === "full" ? "full" : "cropped",
  };
}

function atlasDecisionLabel(decision: AtlasDecision) {
  return { unseen: "À voir", saved: "Gardé", rejected: "Rejeté", owned: "Possédé" }[decision];
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
  const [visualBusy, setVisualBusy] = useState(false);
  const [visualMode, setVisualMode] = useState<"sequential" | "sheet">("sequential");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium">("low");
  const [promptImages, setPromptImages] = useState<AtlasPromptImage[]>([]);
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
  const [personalKind, setPersonalKind] = useState<"owned" | "reference">("owned");
  const [personalImages, setPersonalImages] = useState<AtlasPromptImage[]>([]);
  const [personalBusy, setPersonalBusy] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const atlasElementRef = useRef<HTMLDivElement>(null);
  const atlasImageInputRef = useRef<HTMLInputElement>(null);
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
  const atlasViewRef = useRef({ left: 0, top: 0, width: 1000, height: 650 });
  const atlasZoomScrollRef = useRef<{ left: number; top: number } | null>(null);
  const atlasDragRef = useRef<{ x: number; y: number; left: number; top: number; pointerId: number; captured: boolean; lastX: number; lastY: number; lastAt: number; velocityX: number; velocityY: number } | null>(null);
  const atlasInertiaFrameRef = useRef<number | null>(null);
  const atlasSuppressClickRef = useRef(false);
  const atlasDraggingRef = useRef(false);
  const atlasHoverTimerRef = useRef<number | null>(null);
  const atlasHoverCardRef = useRef<HTMLElement | null>(null);
  const atlasLayoutCacheRef = useRef(new WeakMap<AtlasItem[], Map<string, AtlasSpaceLayout>>());
  const discoveryMonitorRef = useRef(0);

  async function reloadAtlasCatalog() {
    const response = await fetch(`${ATLAS_API}/products?limit=10000`);
    if (!response.ok) throw new Error("catalog unavailable");
    const items = await response.json() as AtlasApiProduct[];
    setCatalogItems((current) => atlasMergeItems(items, current));
    setCatalogStatus("catalogue local");
  }

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([
      fetch(`${ATLAS_API}/products?limit=10000`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("catalog unavailable");
        const items = await response.json() as AtlasApiProduct[];
        if (items.length) setCatalogItems((current) => atlasMergeItems(items, current));
        setCatalogStatus("catalogue local");
      }),
      fetch(`${ATLAS_API}/views`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasSavedView[] | { views?: AtlasSavedView[] };
        setSavedViews((Array.isArray(payload) ? payload : payload.views ?? []).map(atlasNormalizeView));
      }),
      fetch(`${ATLAS_API}/outfit-boards`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasOutfitBoard[] | { boards?: AtlasOutfitBoard[] };
        setOutfitBoards(Array.isArray(payload) ? payload : payload.boards ?? []);
      }),
      fetch(`${ATLAS_API}/acquisition/jobs?limit=20`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const jobs = await response.json() as AtlasAcquisitionJob[];
        const recoverable = jobs.find((job) => job.canResume && ["queued", "running", "error"].includes(job.status));
        if (recoverable) { setRefreshJob(recoverable); setRefreshRecovered(true); }
      }),
      fetch(`${ATLAS_API}/discovery/jobs?limit=20`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as AtlasDiscoveryJob[] | { jobs?: AtlasDiscoveryJob[] };
        const recentJobs = Array.isArray(payload) ? payload : payload.jobs ?? [];
        if (!recentJobs.length) return;
        let session: AtlasDiscoverySession | null = null;
        try {
          const stored = window.localStorage.getItem(ATLAS_DISCOVERY_SESSION_KEY);
          if (stored) {
            const candidate = JSON.parse(stored) as Partial<AtlasDiscoverySession>;
            if (candidate.plan && Array.isArray(candidate.jobIds)) session = candidate as AtlasDiscoverySession;
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
        const plan = session?.plan ?? {
          id: "recovered", name: "Découverte locale retrouvée", description: "Derniers jobs persistés par source.",
          targetCount: jobs.reduce((sum, job) => sum + (job.intent.maxItems ?? 0), 0), sizes: ["M", "L"], sizeMode: "any" as const,
          searches: jobs.map((job) => job.intent),
        };
        setDiscoveryPlan(plan);
        setDiscoveryJobs(jobs);
        setDiscoveryRecovered(jobs.some((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status) || ["failed", "blocked"].includes(job.status)));
      }),
    ]).then((results) => {
      if (results[0]?.status === "rejected" && !(results[0].reason instanceof DOMException && results[0].reason.name === "AbortError")) setCatalogStatus("démo · API hors ligne");
    });
    return () => controller.abort();
  }, []);

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
      if (storedSizes) setSelectedSizes(storedSizes);
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

  const scopeCatalog = useMemo(() => visibleCatalog.filter((item) => {
    if (scope === "saved") return item.decision === "saved";
    if (scope === "owned") return item.kind === "owned" || item.decision === "owned";
    if (scope === "reference") return item.kind === "reference";
    if (scope === "outfits") return activeOutfitIds.has(item.id);
    return true;
  }), [activeOutfitIds, scope, visibleCatalog]);

  const catalogBeforeSize = useMemo(() => scopeCatalog.filter((item) => {
    if (!includeRejected && item.decision === "rejected") return false;
    if (sourceFilter === "shop" && item.kind !== "shop") return false;
    if (sourceFilter === "reference" && item.kind !== "reference") return false;
    if (sourceFilter === "owned" && item.kind !== "owned") return false;
    if (sourceFilter === "zalando" && (item.kind !== "shop" || item.source !== "zalando-ch")) return false;
    if (sourceFilter === "aliexpress" && (item.kind !== "shop" || item.source !== "aliexpress")) return false;
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
      const haystack = [item.brand, item.name, item.color, item.category, item.fit, item.source, item.reason, ...item.materials, ...item.tags].join(" ").toLocaleLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  }), [attributeQuery, fitFilter, includeRejected, materialFilter, maxPrice, minPrice, priceFilter, scopeCatalog, sourceFilter, stockFilter]);

  const quickFilteredCatalog = useMemo(() => catalogBeforeSize.filter((item) => {
    if (!selectedSizes.length || item.kind !== "shop" || item.decision === "owned") return true;
    return selectedSizes.some((size) => atlasHasSize(item, size));
  }), [catalogBeforeSize, selectedSizes]);

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
  const sizeCounts = useMemo(() => Object.fromEntries(sizeOptions.map((size) => [size, sizeFacetCatalog.filter((item) => atlasHasSize(item, size)).length])), [sizeFacetCatalog, sizeOptions]);
  const selectedSizeMatchCount = useMemo(() => sizeFacetCatalog.filter((item) => {
    if (!selectedSizes.length || item.kind !== "shop" || item.decision === "owned") return true;
    return selectedSizes.some((size) => atlasHasSize(item, size));
  }).length, [selectedSizes, sizeFacetCatalog]);
  const products = useMemo(() => atlasArrange(quickFilteredCatalog.filter((item) => activeFilter === "Tout" || item.category === activeFilter), xAxis, yAxis), [activeFilter, quickFilteredCatalog, xAxis, yAxis]);
  const renderSignature = useMemo(() => JSON.stringify([
    aiItems ? "ai" : "catalogue", scope, selectedOutfitBoardId, activeFilter, sourceFilter, priceFilter, fitFilter,
    materialFilter, selectedSizes, stockFilter, attributeQuery, minPrice, maxPrice, includeRejected, xAxis, yAxis, mode,
    products.length, products[0]?.id ?? "", products.at(-1)?.id ?? "",
  ]), [activeFilter, aiItems, attributeQuery, fitFilter, includeRejected, materialFilter, maxPrice, minPrice, mode, priceFilter, products, scope, selectedOutfitBoardId, selectedSizes, sourceFilter, stockFilter, xAxis, yAxis]);
  const renderLimit = renderWindow.signature === renderSignature ? renderWindow.limit : ATLAS_PAGE_SIZE;
  const baseSpaceLayout = useMemo(() => {
    let layouts = atlasLayoutCacheRef.current.get(products);
    if (!layouts) { layouts = new Map(); atlasLayoutCacheRef.current.set(products, layouts); }
    const key = `${xAxis}:${yAxis}:${atlasViewport.width}:${atlasViewport.height}:${imageMode}`;
    const cached = layouts.get(key);
    if (cached) return cached;
    const layout = atlasSpaceLayout(products, xAxis, yAxis, atlasViewport.width, atlasViewport.height, imageMode);
    layouts.set(key, layout);
    return layout;
  }, [atlasViewport.height, atlasViewport.width, imageMode, products, xAxis, yAxis]);
  const spaceLayout = useMemo(() => atlasScaledLayout(baseSpaceLayout, zoom), [baseSpaceLayout, zoom]);
  const renderedProducts = useMemo(() => {
    if (mode === "grid") return products.slice(0, renderLimit);
    const overscan = 240;
    const minimumX = atlasView.left - overscan;
    const maximumX = atlasView.left + atlasView.width + overscan;
    const minimumY = atlasView.top - overscan;
    const maximumY = atlasView.top + atlasView.height + overscan;
    return products.filter((item) => {
      const rectangle = spaceLayout.positions.get(item.id);
      if (!rectangle) return false;
      return rectangle.left + rectangle.width / 2 >= minimumX
        && rectangle.left - rectangle.width / 2 <= maximumX
        && rectangle.top + rectangle.height / 2 >= minimumY
        && rectangle.top - rectangle.height / 2 <= maximumY;
    });
  }, [atlasView.height, atlasView.left, atlasView.top, atlasView.width, mode, products, renderLimit, spaceLayout.positions]);
  const categoryCounts = useMemo(() => Object.fromEntries(atlasCategories.map((filter) => [filter, filter === "Tout" ? quickFilteredCatalog.length : quickFilteredCatalog.filter((item) => item.category === filter).length])), [quickFilteredCatalog]);
  const compareItems = useMemo(() => [...compareIds].map((id) => catalogItems.find((item) => item.id === id) ?? visibleCatalog.find((item) => item.id === id)).filter(Boolean) as AtlasItem[], [catalogItems, compareIds, visibleCatalog]);
  const outfitDraftItems = useMemo(() => [...outfitDraftIds].map((id) => catalogItems.find((item) => item.id === id)).filter(Boolean) as AtlasItem[], [catalogItems, outfitDraftIds]);
  const ownedItems = useMemo(() => catalogItems.filter((item) => item.kind === "owned" || item.decision === "owned"), [catalogItems]);
  const wardrobeGaps = useMemo(() => ["Vestes", "Pantalons", "Mailles", "Chemises", "Chaussures"].filter((category) => !ownedItems.some((item) => item.category === category)), [ownedItems]);
  const staleCount = useMemo(() => catalogItems.filter((item) => item.kind === "shop" && atlasIsStale(item.stockCheckedAt)).length, [catalogItems]);

  function scheduleAtlasView(element: HTMLDivElement) {
    const next = { left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight };
    const current = atlasViewRef.current;
    const escapedOverscan = Math.abs(next.left - current.left) > 160 || Math.abs(next.top - current.top) > 160;
    if (atlasScrollTimerRef.current !== null) window.clearTimeout(atlasScrollTimerRef.current);
    if (escapedOverscan) {
      atlasScrollTimerRef.current = null;
      atlasViewRef.current = next;
      setAtlasView(next);
      return;
    }
    atlasScrollTimerRef.current = window.setTimeout(() => {
      atlasScrollTimerRef.current = null;
      atlasViewRef.current = next;
      setAtlasView(next);
    }, 140);
  }

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
    const scaleX = width / Math.max(1, spaceLayout.width);
    const scaleY = height / Math.max(1, spaceLayout.height);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(239, 235, 226, .94)";
    context.fillRect(0, 0, width, height);
    for (const item of products) {
      const rectangle = spaceLayout.positions.get(item.id);
      if (!rectangle) continue;
      context.fillStyle = item.decision === "saved" ? "#9a6148" : item.kind === "reference" ? "#66705d" : "#8b8377";
      context.fillRect(
        (rectangle.left - rectangle.width / 2) * scaleX,
        (rectangle.top - rectangle.height / 2) * scaleY,
        Math.max(1.5, rectangle.width * scaleX),
        Math.max(1.5, rectangle.height * scaleY),
      );
    }
    context.strokeStyle = "#332c24";
    context.lineWidth = 3;
    context.strokeRect(atlasView.left * scaleX, atlasView.top * scaleY, atlasView.width * scaleX, atlasView.height * scaleY);
  }, [atlasView.height, atlasView.left, atlasView.top, atlasView.width, mode, products, spaceLayout]);

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
    const nextDecision = item.decision === requested && requested !== "owned" ? "unseen" : requested;
    const previousDecision = item.decision;
    if (previousDecision === nextDecision) return;
    updateProductLocally(item.id, { decision: nextDecision });
    try {
      const response = await fetch(`${ATLAS_API}/products/${encodeURIComponent(item.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: nextDecision }),
      });
      if (!response.ok) throw new Error("decision unavailable");
      const result = await response.json() as { product?: AtlasApiProduct; actionId?: string };
      if (result.product) updateProductLocally(item.id, atlasApiToItem(result.product));
      setUndoStack((current) => [...current.slice(-29), { actionId: result.actionId, productId: item.id, previousDecision, nextDecision }]);
      setToast(`${atlasDecisionLabel(nextDecision)} · ⌘Z pour annuler`);
    } catch {
      updateProductLocally(item.id, { decision: previousDecision });
      setToast("Impossible d’enregistrer — changement annulé");
    }
  }

  async function undoLastAction() {
    const action = undoStack.at(-1);
    if (!action) return;
    setUndoStack((current) => current.slice(0, -1));
    updateProductLocally(action.productId, { decision: action.previousDecision });
    try {
      const response = action.actionId
        ? await fetch(`${ATLAS_API}/actions/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId: action.actionId }) })
        : await fetch(`${ATLAS_API}/products/${encodeURIComponent(action.productId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: action.previousDecision }) });
      if (!response.ok) throw new Error("undo unavailable");
      const result = await response.json() as { product?: AtlasApiProduct };
      if (result.product) updateProductLocally(action.productId, atlasApiToItem(result.product));
      setToast("Dernière décision annulée");
    } catch {
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

  const drawerOpen = drawer !== null;
  useEffect(() => {
    if (!drawerOpen) return;
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
  }, [drawerOpen]);

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
      setToast("Comparaison limitée à 4 pièces");
      return;
    }
    setCompareIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
  }

  function changeAtlasZoom(nextValue: number, anchor?: { x: number; y: number }) {
    const atlas = atlasElementRef.current;
    const next = Math.min(3, Math.max(.25, Math.round(nextValue * 1000) / 1000));
    const current = atlasZoomRef.current;
    if (next === current) return;
    atlasZoomRef.current = next;
    if (!atlas) return setZoom(next);
    const point = anchor ?? { x: atlas.clientWidth / 2, y: atlas.clientHeight / 2 };
    const pendingScroll = atlasZoomScrollRef.current ?? { left: atlas.scrollLeft, top: atlas.scrollTop };
    const contentX = (pendingScroll.left + point.x) / current;
    const contentY = (pendingScroll.top + point.y) / current;
    atlasZoomScrollRef.current = { left: contentX * next - point.x, top: contentY * next - point.y };
    setZoom(next);
    if (atlasZoomFrameRef.current !== null) cancelAnimationFrame(atlasZoomFrameRef.current);
    atlasZoomFrameRef.current = requestAnimationFrame(() => {
      const target = atlasZoomScrollRef.current;
      if (target) { atlas.scrollLeft = target.left; atlas.scrollTop = target.top; }
      atlasZoomScrollRef.current = null; atlasZoomFrameRef.current = null;
    });
  }

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
        const intensity = event.deltaMode === 1 ? .018 : .0018;
        changeAtlasZoom(atlasZoomRef.current * Math.exp(-event.deltaY * intensity), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
        return;
      }
      atlas.scrollLeft += event.deltaX || (event.shiftKey ? event.deltaY : 0);
      atlas.scrollTop += event.shiftKey ? 0 : event.deltaY;
    };
    atlas.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => atlas.removeEventListener("wheel", handleNativeWheel);
  }, [mode]);

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
    cancelAtlasPreview();
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
    if (event.key === "Enter" && item.url) window.open(item.url, "_blank", "noopener,noreferrer");
  }

  async function askAtlasCodex() {
    if (!aiPrompt.trim()) return;
    setAiStatus("Codex Luna traduit la demande…");
    try {
      const response = await fetch(`${ATLAS_API}/codex/filter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: aiPrompt }) });
      if (!response.ok) throw new Error("bridge unavailable");
      const result = await response.json() as { filter?: { name?: string } };
      if (!result.filter) throw new Error("missing filter");
      const queryResponse = await fetch(`${ATLAS_API}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result.filter) });
      if (!queryResponse.ok) throw new Error("query failed");
      const matches = await queryResponse.json() as AtlasApiProduct[];
      setAiItems(atlasMergeItems(matches, catalogItems)); setScope("catalogue"); setActiveFilter("Tout");
      setAiStatus(`« ${result.filter.name ?? "Codex"} » · ${matches.length} résultats`);
    } catch { setAiStatus("Bridge local hors ligne — lance npm run dev"); }
  }

  async function askAtlasVision() {
    if ((!aiPrompt.trim() && !promptImages.length) || visualBusy) return;
    const presetRange = priceFilter === "under50" ? { max: 49.99 }
      : priceFilter === "50to100" ? { min: 50, max: 100 }
        : priceFilter === "100to180" ? { min: 100, max: 180 }
          : priceFilter === "over180" ? { min: 180.01 } : {};
    const requestedMin = minPrice && Number.isFinite(Number(minPrice)) ? Number(minPrice) : undefined;
    const requestedMax = maxPrice && Number.isFinite(Number(maxPrice)) ? Number(maxPrice) : undefined;
    const effectiveMinPrice = requestedMin === undefined ? presetRange.min : Math.max(requestedMin, presetRange.min ?? 0);
    const effectiveMaxPrice = requestedMax === undefined ? presetRange.max : Math.min(requestedMax, presetRange.max ?? Number.MAX_SAFE_INTEGER);
    const constrainedSources = sourceFilter === "zalando" ? ["zalando-ch"]
      : sourceFilter === "aliexpress" ? ["aliexpress"]
      : sourceFilter === "owned" ? [...new Set(visibleCatalog.filter((item) => item.kind === "owned").map((item) => item.source))]
        : sourceFilter === "reference" ? [...new Set(visibleCatalog.filter((item) => item.kind === "reference").map((item) => item.source))]
          : undefined;
    setVisualBusy(true); setAiItems([]);
    setAiStatus(visualMode === "sheet" ? "Luna prépare sa première planche…" : "Luna prépare la sélection visuelle…");
    try {
      const response = await fetch(`${ATLAS_API}/codex/visual-select`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: aiPrompt.trim() || "Trouve des vêtements visuellement proches du mood board joint.", maxCandidates: 72, topN: 30,
          threshold: .5, analysisMode: visualMode, reasoningEffort,
          constraints: {
            sizes: selectedSizes.length ? selectedSizes : undefined,
            freshWithinHours: selectedSizes.length ? 48 : undefined,
            minPrice: effectiveMinPrice, maxPrice: effectiveMaxPrice,
            categories: activeFilter === "Tout" ? undefined : [activeFilter], sources: constrainedSources?.length ? constrainedSources : undefined,
            includeRejected,
          },
          images: promptImages.map(({ name, dataUrl }) => ({ name, dataUrl })),
        }),
      });
      if (!response.ok) throw new Error(await response.text() || "visual job unavailable");
      let job = await response.json() as AtlasVisualJob;
      while (job.status !== "complete" && job.status !== "error") {
        setAiItems(atlasMergeItems(job.products, catalogItems)); setScope("catalogue"); setActiveFilter("Tout");
        setAiStatus(`${job.message} · ${job.inspected}/${job.maxInspections} vues · ${job.selected} retenus`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const poll = await fetch(`${ATLAS_API}/codex/visual-jobs/${job.id}`);
        if (!poll.ok) throw new Error("visual job lost");
        job = await poll.json() as AtlasVisualJob;
      }
      if (job.status === "error") throw new Error(job.error ?? "visual selection failed");
      setAiItems(atlasMergeItems(job.products, catalogItems)); setAiStatus(`${job.message} · score > ${job.threshold.toFixed(2)}`);
    } catch (error) { setAiStatus(`Vision indisponible — ${error instanceof Error ? error.message : "erreur locale"}`); }
    finally { setVisualBusy(false); }
  }

  function persistAtlasDiscovery(plan: AtlasDiscoveryPlan, jobs: AtlasDiscoveryJob[]) {
    try {
      window.localStorage.setItem(ATLAS_DISCOVERY_SESSION_KEY, JSON.stringify({ plan, jobIds: jobs.map((job) => job.id) } satisfies AtlasDiscoverySession));
    } catch { /* Server snapshots remain recoverable if browser storage is unavailable. */ }
  }

  async function monitorAtlasDiscovery(initialJobs: AtlasDiscoveryJob[]) {
    const monitorId = discoveryMonitorRef.current + 1;
    discoveryMonitorRef.current = monitorId;
    let jobs = initialJobs;
    setDiscoveryJobs(jobs);
    setDiscoveryBusy(true);
    setDiscoveryRecovered(false);
    try {
      while (jobs.some((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status))) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (discoveryMonitorRef.current !== monitorId) return;
        const snapshots = await Promise.all(jobs.map(async (job) => {
          if (ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status)) return job;
          const response = await fetch(`${ATLAS_API}/discovery/jobs/${encodeURIComponent(job.id)}`);
          if (!response.ok) throw new Error(`job ${job.id} unavailable`);
          return response.json() as Promise<AtlasDiscoveryJob>;
        }));
        if (discoveryMonitorRef.current !== monitorId) return;
        jobs = snapshots;
        setDiscoveryJobs(jobs);
      }
      if (discoveryMonitorRef.current !== monitorId) return;
      const discovered = jobs.reduce((sum, job) => sum + job.discovered, 0);
      if (discovered > 0) {
        try { await reloadAtlasCatalog(); }
        catch { setToast(`${discovered} article${discovered > 1 ? "s" : ""} trouvé${discovered > 1 ? "s" : ""}, catalogue à recharger`); return; }
      }
      const failed = jobs.filter((job) => ["failed", "blocked"].includes(job.status)).length;
      const cancelled = jobs.filter((job) => job.status === "cancelled").length;
      if (failed) setToast(`${discovered} nouveau${discovered > 1 ? "x" : ""} · ${failed} recherche${failed > 1 ? "s" : ""} à reprendre`);
      else if (cancelled) setToast(discovered ? `${discovered} article${discovered > 1 ? "s" : ""} ajouté${discovered > 1 ? "s" : ""} avant l’arrêt` : "Découverte arrêtée · relance Trouver pour recommencer");
      else setToast(discovered ? `${discovered} ${discovered > 1 ? "nouveaux" : "nouvel"} article${discovered > 1 ? "s" : ""} ajouté${discovered > 1 ? "s" : ""}` : "Aucun nouvel article trouvé");
    } finally {
      if (discoveryMonitorRef.current === monitorId) setDiscoveryBusy(false);
    }
  }

  async function startAtlasDiscovery() {
    const prompt = aiPrompt.trim();
    if (!prompt || discoveryBusy) return;
    discoveryMonitorRef.current += 1;
    setDiscoveryBusy(true);
    setDiscoveryRecovered(false);
    setDiscoveryJobs([]);
    setDiscoveryPlan(null);
    setAiStatus("Luna prépare un plan de recherche local M ou L…");
    try {
      const response = await fetch(`${ATLAS_API}/codex/discover`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
      });
      if (!response.ok) throw new Error(await response.text() || "discovery unavailable");
      const payload = await response.json() as { plan: AtlasDiscoveryPlan; jobs: AtlasDiscoveryJob[] };
      if (!payload.plan || !payload.jobs?.length) throw new Error("Le plan n’a créé aucune recherche");
      setDiscoveryPlan(payload.plan);
      persistAtlasDiscovery(payload.plan, payload.jobs);
      setAiStatus("");
      await monitorAtlasDiscovery(payload.jobs);
    } catch (error) {
      setAiStatus(`Découverte indisponible — ${error instanceof Error ? error.message : "erreur locale"}`);
      setDiscoveryBusy(false);
    }
  }

  async function cancelAtlasDiscovery() {
    const activeJobs = discoveryJobs.filter((job) => !ATLAS_TERMINAL_DISCOVERY_STATUSES.has(job.status));
    if (!activeJobs.length) return;
    discoveryMonitorRef.current += 1;
    setDiscoveryBusy(true);
    try {
      const cancelled = await Promise.allSettled(activeJobs.map(async (job) => {
        const response = await fetch(`${ATLAS_API}/discovery/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" });
        if (!response.ok) throw new Error(`cancel ${job.id} unavailable`);
        return response.json() as Promise<AtlasDiscoveryJob>;
      }));
      const snapshots = new Map(cancelled.flatMap((result) => result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []));
      const nextJobs = discoveryJobs.map((job) => snapshots.get(job.id) ?? job);
      if (!snapshots.size) throw new Error("cancel unavailable");
      await monitorAtlasDiscovery(nextJobs);
    } catch {
      setDiscoveryBusy(false);
      setToast("Impossible d’arrêter toutes les recherches");
    }
  }

  async function resumeAtlasDiscovery() {
    const resumable = discoveryJobs.filter((job) => ["queued", "running", "failed", "blocked"].includes(job.status));
    if (!resumable.length || discoveryBusy) return;
    discoveryMonitorRef.current += 1;
    setDiscoveryBusy(true);
    setDiscoveryRecovered(false);
    try {
      const resumed = await Promise.allSettled(resumable.map(async (job) => {
        const action = ["failed", "blocked"].includes(job.status) ? "retry" : "resume";
        const response = await fetch(`${ATLAS_API}/discovery/jobs/${encodeURIComponent(job.id)}/${action}`, { method: "POST" });
        if (!response.ok) throw new Error(`${action} ${job.id} unavailable`);
        return response.json() as Promise<AtlasDiscoveryJob>;
      }));
      const snapshots = new Map(resumed.flatMap((result) => result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []));
      const nextJobs = discoveryJobs.map((job) => snapshots.get(job.id) ?? job);
      if (!snapshots.size) throw new Error("resume unavailable");
      await monitorAtlasDiscovery(nextJobs);
    } catch {
      setDiscoveryBusy(false);
      setToast("Reprise de la découverte indisponible");
    }
  }

  async function addAtlasPromptImages(files: File[]) {
    try {
      const next = await atlasReadImages(files, promptImages.length);
      if (!next.length) return;
      setPromptImages((current) => [...current, ...next].slice(0, ATLAS_MAX_IMAGES));
      setAiStatus(`${next.length} image${next.length > 1 ? "s" : ""} ajoutée${next.length > 1 ? "s" : ""} au prochain prompt Vision`);
    } catch (error) { setAiStatus(error instanceof Error ? error.message : "Image impossible à ajouter"); }
  }

  async function monitorAtlasRefresh(initialJob: AtlasAcquisitionJob) {
    let job = initialJob;
    setRefreshRecovered(false);
    setRefreshJob(job);
    while (!(job.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(job.status))) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const poll = await fetch(`${ATLAS_API}/acquisition/jobs/${job.id}`);
      if (!poll.ok) throw new Error("job unavailable");
      job = await poll.json() as AtlasAcquisitionJob;
      setRefreshJob(job);
    }
    // A failed/cancelled batch can still contain successful refreshes. Merge
    // those writes before surfacing the terminal state to the user.
    if (job.status === "complete" || (job.succeeded ?? 0) > 0) {
      await reloadAtlasCatalog();
    }
    if (["error", "blocked"].includes(job.status)) throw new Error(job.error ?? "refresh failed");
    if (job.status === "complete") {
      setToast("Prix et stocks rafraîchis");
    } else setToast((job.succeeded ?? 0) > 0 ? `${job.succeeded} fiche${job.succeeded === 1 ? "" : "s"} mise${job.succeeded === 1 ? "" : "s"} à jour avant l’arrêt` : "Rafraîchissement arrêté");
  }

  async function startAtlasRefresh(productIds: string[]) {
    const ids = [...new Set(productIds)].filter((id) => catalogItems.some((item) => item.id === id && item.kind === "shop"));
    if (!ids.length || refreshJob && !(refreshJob.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(refreshJob.status))) return;
    setToast(`Rafraîchissement de ${ids.length} fiche${ids.length > 1 ? "s" : ""}…`);
    try {
      const response = await fetch(`${ATLAS_API}/acquisition/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productIds: ids }) });
      if (!response.ok) throw new Error("queue unavailable");
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob);
    } catch { setToast("Rafraîchissement interrompu — reprise disponible"); }
  }

  async function retryAtlasRefresh() {
    if (!refreshJob) return;
    try {
      const response = await fetch(`${ATLAS_API}/acquisition/jobs/${refreshJob.id}/resume`, { method: "POST" });
      if (!response.ok) throw new Error("retry unavailable");
      setRefreshRecovered(false);
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob);
    } catch { setToast("Reprise indisponible"); }
  }

  async function cancelAtlasRefresh() {
    if (!refreshJob) return;
    try {
      const response = await fetch(`${ATLAS_API}/acquisition/jobs/${refreshJob.id}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error("cancel unavailable");
      setRefreshRecovered(false);
      await monitorAtlasRefresh(await response.json() as AtlasAcquisitionJob);
    } catch { setToast("Impossible d’arrêter la vérification"); }
  }

  function currentAtlasView(): AtlasSavedView {
    return atlasNormalizeView({
      id: crypto.randomUUID(), name: viewName.trim() || `Vue ${savedViews.length + 1}`, scope, activeFilter, sourceFilter,
      priceFilter, fitFilter, materialFilter, sizeFilters: selectedSizes, stockFilter, attributeQuery, minPrice, maxPrice,
      includeRejected, xAxis, yAxis, mode, imageMode,
    });
  }

  async function saveAtlasView(event: FormEvent) {
    event.preventDefault();
    const payload = currentAtlasView();
    try {
      const response = await fetch(`${ATLAS_API}/views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error("save failed");
      const saved = atlasNormalizeView(await response.json() as AtlasSavedView);
      setSavedViews((current) => [saved, ...current.filter((view) => view.id !== saved.id)]); setViewName(""); setToast("Vue sauvegardée");
    } catch { setToast("Impossible de sauvegarder cette vue"); }
  }

  function applyAtlasView(view: AtlasSavedView) {
    setScope(view.scope); setActiveFilter(view.activeFilter); setSourceFilter(view.sourceFilter); setPriceFilter(view.priceFilter);
    setFitFilter(view.fitFilter); setMaterialFilter(view.materialFilter); setSelectedSizes(view.sizeFilters); setStockFilter(view.stockFilter);
    setAttributeQuery(view.attributeQuery); setMinPrice(view.minPrice); setMaxPrice(view.maxPrice); setIncludeRejected(view.includeRejected);
    setXAxis(view.xAxis); setYAxis(view.yAxis); setMode(view.mode); setImageMode(view.imageMode); setDrawer(null); setToast(`Vue « ${view.name} » appliquée`);
  }

  async function deleteAtlasView(id: string) {
    const previous = savedViews;
    setSavedViews((current) => current.filter((view) => view.id !== id));
    try { const response = await fetch(`${ATLAS_API}/views/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!response.ok) throw new Error("delete failed"); }
    catch { setSavedViews(previous); setToast("Suppression impossible"); }
  }

  async function addAtlasPersonalItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!personalImages.length || personalBusy) { setToast("Ajoute au moins une image"); return; }
    const form = new FormData(event.currentTarget);
    setPersonalBusy(true);
    try {
      const response = await fetch(`${ATLAS_API}/personal-items`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: personalKind, name: String(form.get("name") ?? "").trim(), images: personalImages.map((image) => image.dataUrl),
          category: String(form.get("category") ?? "Autre"), color: String(form.get("color") ?? "Inconnue"),
          fit: String(form.get("fit") ?? "unknown"), tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) throw new Error("create failed");
      const created = atlasApiToItem(await response.json() as AtlasApiProduct);
      setCatalogItems((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setPersonalImages([]); event.currentTarget.reset(); setDrawer(null); setScope(personalKind === "owned" ? "owned" : "reference");
      setToast(personalKind === "owned" ? "Vêtement ajouté au dressing" : "Référence ajoutée");
    } catch { setToast("Ajout impossible — API locale indisponible"); }
    finally { setPersonalBusy(false); }
  }

  async function createAtlasOutfit(event: FormEvent) {
    event.preventDefault();
    const productIds = outfitDraftIds.size ? [...outfitDraftIds] : [...compareIds];
    if (!productIds.length) { setToast("Ajoute d’abord quelques pièces à la tenue"); return; }
    try {
      const response = await fetch(`${ATLAS_API}/outfit-boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: outfitName.trim() || `Tenue ${outfitBoards.length + 1}`, productIds }) });
      if (!response.ok) throw new Error("create failed");
      const board = await response.json() as AtlasOutfitBoard;
      setOutfitBoards((current) => [board, ...current.filter((item) => item.id !== board.id)]);
      setOutfitName(""); setOutfitDraftIds(new Set()); setSelectedOutfitBoardId(board.id); setScope("outfits"); setToast("Planche de tenue enregistrée");
    } catch { setToast("Impossible d’enregistrer cette tenue"); }
  }

  async function generateAtlasOutfits() {
    const anchor = outfitDraftItems.find((item) => item.kind === "shop")
      ?? compareItems.find((item) => item.kind === "shop")
      ?? catalogItems.find((item) => item.kind === "shop" && item.decision === "saved");
    if (!anchor) { setToast("Sélectionne d’abord un achat potentiel"); return; }
    setToast(`Luna compose autour de ${anchor.name}…`);
    try {
      const response = await fetch(`${ATLAS_API}/outfit-boards/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchorProductId: anchor.id, maxOutfits: 3 }),
      });
      if (!response.ok) throw new Error("generation unavailable");
      const boards = await response.json() as AtlasOutfitBoard[];
      setOutfitBoards((current) => [...boards, ...current.filter((board) => !boards.some((created) => created.id === board.id))]);
      if (boards[0]) setSelectedOutfitBoardId(boards[0].id);
      setScope("outfits");
      setToast(`${boards.length} tenue${boards.length > 1 ? "s" : ""} proposée${boards.length > 1 ? "s" : ""}`);
    } catch { setToast("Luna n’a pas pu composer de tenue"); }
  }

  async function deleteAtlasOutfit(id: string) {
    const previous = outfitBoards;
    setOutfitBoards((current) => current.filter((board) => board.id !== id));
    if (selectedOutfitBoardId === id) setSelectedOutfitBoardId(null);
    try { const response = await fetch(`${ATLAS_API}/outfit-boards/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!response.ok) throw new Error("delete failed"); }
    catch { setOutfitBoards(previous); setToast("Suppression impossible"); }
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
  const discoveryWasCancelled = discoveryJobs.length > 0 && discoveryJobs.every((job) => ["succeeded", "cancelled"].includes(job.status))
    && discoveryJobs.some((job) => job.status === "cancelled");
  const discoveryStatusText = discoveryRecovered ? "Session retrouvée · reprise manuelle"
    : discoveryBusy && discoveryHasActive ? `${discoveryCompleted}/${discoveryTotal || "…"} listes explorées`
      : discoveryHasFailures ? "Certaines recherches peuvent être reprises"
        : discoveryWasCancelled ? "Arrêtée · relance Trouver pour recommencer"
          : "Découverte terminée";
  const effectiveFocusedIndex = Math.min(focusedIndex, Math.max(0, renderedProducts.length - 1));
  const previewProduct = previewItem ? catalogItems.find((item) => item.id === previewItem.id) ?? previewItem : null;
  const advancedFilterCount = [priceFilter !== "all", fitFilter !== "all", materialFilter !== "all", Boolean(attributeQuery.trim()), Boolean(minPrice), Boolean(maxPrice), stockFilter !== "all", includeRejected].filter(Boolean).length;

  return (
    <main className={`appShell atlasAppShell imageMode-${imageMode}`}>
      <header className="topbar atlasTopbar">
        <div className="brandBlock">
          <span className="brandMark">WA</span>
          <div><h1>Wardrobe Atlas</h1><p>{catalogStatus}</p></div>
        </div>
        <nav className="scopeNav" aria-label="Sections du catalogue">
          {atlasScopes.map((item) => {
            const count = item.id === "catalogue" ? catalogItems.filter((product) => includeRejected || product.decision !== "rejected").length
              : item.id === "saved" ? catalogItems.filter((product) => product.decision === "saved").length
              : item.id === "owned" ? ownedItems.length
              : item.id === "reference" ? catalogItems.filter((product) => product.kind === "reference").length
              : outfitBoards.length;
            return (
              <button key={item.id} className={scope === item.id ? "active" : ""} onClick={() => setScope(item.id)} aria-current={scope === item.id ? "page" : undefined}>
                <span>{item.icon}</span>{item.label}<b>{count}</b>
              </button>
            );
          })}
        </nav>
        <div className="topActions">
          <button className="quietButton" onClick={() => setDrawer("views")} aria-label="Ouvrir les vues sauvegardées">Vues</button>
          <button className={compareIds.size ? "quietButton hasBadge" : "quietButton"} data-count={compareIds.size || undefined} onClick={() => setDrawer("compare")} aria-label={`Ouvrir la comparaison, ${compareIds.size} pièce${compareIds.size > 1 ? "s" : ""}`}>Comparer</button>
          <button className={outfitDraftIds.size ? "quietButton hasBadge" : "quietButton"} data-count={outfitDraftIds.size || undefined} onClick={() => setDrawer("outfits")} aria-label="Ouvrir les planches de tenues">Tenues</button>
          <button className="primaryButton" onClick={() => setDrawer("add")}>＋ Ajouter</button>
        </div>
      </header>

      <section className="boardPanel atlasBoardPanel">
        <div className="boardToolbar atlasBoardToolbar">
          <div className="boardTitle"><span className="eyebrow">Carte de style · {scopeLabel} · PCA compacte</span><h2>Automne · brun ténébreux</h2></div>
          <div className="toolbarRight">
            <button className="undoButton" disabled={!undoStack.length} onClick={() => void undoLastAction()} title="Annuler la dernière décision (⌘Z)">↶</button>
            <div className="axisControls" aria-label="Axes de rangement">
              <label>X<select value={xAxis} onChange={(event) => setXAxis(event.target.value as AxisField)}><option value="pca">PCA</option><option value="price">Prix</option><option value="score">Score</option></select></label>
              <label>Y<select value={yAxis} onChange={(event) => setYAxis(event.target.value as AxisField)}><option value="pca">PCA</option><option value="price">Prix</option><option value="score">Score</option></select></label>
            </div>
            <div className="segmented" aria-label="Mode d’affichage">
              <button className={mode === "space" ? "active" : ""} onClick={() => setMode("space")}>Espace</button>
              <button className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>Grille</button>
            </div>
            <div className="zoomControls" aria-label="Zoom du board">
              <button disabled={mode !== "space" || zoom <= .25} onClick={() => changeAtlasZoom(atlasZoomRef.current - .15)} aria-label="Dézoomer">−</button>
              <button disabled={mode !== "space"} onClick={resetAtlasView} className="zoomValue">{Math.round(zoom * 100)}%</button>
              <button disabled={mode !== "space" || zoom >= 3} onClick={() => changeAtlasZoom(atlasZoomRef.current + .15)} aria-label="Zoomer">＋</button>
            </div>
            <div className="segmented imageDisplaySwitch" aria-label="Affichage des images">
              <button className={imageMode === "cropped" ? "active" : ""} aria-pressed={imageMode === "cropped"} onClick={() => setImageMode("cropped")}>Crop</button>
              <button className={imageMode === "full" ? "active" : ""} aria-pressed={imageMode === "full"} onClick={() => setImageMode("full")}>Entier</button>
            </div>
          </div>
        </div>

        <div className="filterBar atlasFilterBar">
          <label className="quickFilter"><small>Catégorie</small><select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value)}>{atlasCategories.map((filter) => <option value={filter} key={filter}>{filter} ({categoryCounts[filter] ?? 0})</option>)}</select></label>
          <label className="quickFilter"><small>Source</small><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">Toutes</option><option value="shop">Tous shops</option><option value="zalando">Zalando</option><option value="aliexpress">AliExpress</option><option value="owned">Dressing</option><option value="reference">Références</option></select></label>
          <label className="quickFilter"><small>Prix</small><select value={priceFilter} onChange={(event) => setPriceFilter(event.target.value)}><option value="all">Tous</option><option value="under50">&lt; 50</option><option value="50to100">50–100</option><option value="100to180">100–180</option><option value="over180">&gt; 180</option></select></label>
          <label className="quickFilter"><small>Coupe</small><select value={fitFilter} onChange={(event) => setFitFilter(event.target.value)}><option value="all">Toutes</option><option value="large">Large</option><option value="courte">Courte</option><option value="court">Court</option><option value="droite">Droite</option><option value="relax">Relax</option><option value="unknown">Inconnue</option></select></label>
          <label className="quickFilter"><small>Matière</small><select value={materialFilter} onChange={(event) => setMaterialFilter(event.target.value)}><option value="all">Toutes</option><option value="knit">Maille/laine</option><option value="linen">Lin</option><option value="cotton">Coton</option><option value="leather">Cuir</option><option value="denim">Denim</option></select></label>
          <details className="quickFilter sizeMultiFilter" title={`${knownSizeCount} articles en stock avec tailles fraîches dans ce scope`}>
            <summary aria-label={`Filtrer par tailles, ${selectedSizes.length ? selectedSizes.join(" ou ") : "toutes"}`}><small>Tailles · {selectedSizeMatchCount}</small><span className="sizeFilterValue">{selectedSizes.length ? selectedSizes.length <= 3 ? selectedSizes.join(" ∨ ") : `${selectedSizes.length} tailles` : "Toutes"}<b>⌄</b></span></summary>
            <div className="sizeFilterPopover">
              <div className="sizeFilterHeader"><strong>Disponibilité exacte</strong><span>{knownSizeCount} fiches fraîches</span></div>
              <div className="sizeChoiceGrid">{sizeOptions.map((size) => <button type="button" key={size} className={selectedSizes.includes(size) ? "active" : ""} aria-pressed={selectedSizes.includes(size)} onClick={() => toggleAtlasSize(size)}><span>{size}</span><b>{sizeCounts[size] ?? 0}</b></button>)}</div>
              <div className="sizeFilterActions"><button type="button" onClick={() => setSelectedSizes([])}>Toutes</button><button type="button" onClick={() => setSelectedSizes(["M", "L"])}>M ou L</button></div>
              <p>OU entre les tailles · stock connu · vérifié sous 48 h.</p>
            </div>
          </details>
          <details className="advancedFilters">
            <summary aria-label={`${advancedFilterCount} filtres avancés actifs`}><span>＋ filtres</span>{advancedFilterCount > 0 && <b>{advancedFilterCount}</b>}</summary>
            <div className="filterPopover">
              <div className="mobileFilterFallbacks">
                <label>Prix<select value={priceFilter} onChange={(event) => setPriceFilter(event.target.value)}><option value="all">Tous</option><option value="under50">&lt; 50</option><option value="50to100">50–100</option><option value="100to180">100–180</option><option value="over180">&gt; 180</option></select></label>
                <label>Coupe<select value={fitFilter} onChange={(event) => setFitFilter(event.target.value)}><option value="all">Toutes</option><option value="large">Large</option><option value="courte">Courte</option><option value="court">Court</option><option value="droite">Droite</option><option value="relax">Relax</option><option value="unknown">Inconnue</option></select></label>
                <label>Matière<select value={materialFilter} onChange={(event) => setMaterialFilter(event.target.value)}><option value="all">Toutes</option><option value="knit">Maille/laine</option><option value="linen">Lin</option><option value="cotton">Coton</option><option value="leather">Cuir</option><option value="denim">Denim</option></select></label>
              </div>
              <label>Recherche attributs<input value={attributeQuery} onChange={(event) => setAttributeQuery(event.target.value)} placeholder="olive laine sans logo…" /></label>
              <div className="priceRange"><label>Prix min<input inputMode="numeric" value={minPrice} onChange={(event) => setMinPrice(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" /></label><label>Prix max<input inputMode="numeric" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="180" /></label></div>
              <label>Fraîcheur<select value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}><option value="all">Toutes</option><option value="available">En stock</option><option value="fresh">Vérifié &lt; 48 h</option><option value="stale">À rafraîchir</option></select></label>
              <label className="checkboxLine"><input type="checkbox" checked={includeRejected} onChange={(event) => setIncludeRejected(event.target.checked)} /> Inclure les rejetés</label>
              <button type="button" className="resetFilters" onClick={resetAtlasFilters}>Réinitialiser aux défauts · M ou L</button>
              <div className="refreshActions"><button type="button" onClick={() => void startAtlasRefresh(renderedProducts.map((item) => item.id))}>↻ visibles</button><button type="button" onClick={() => void startAtlasRefresh(catalogItems.filter((item) => item.decision === "saved").map((item) => item.id))}>↻ shortlist</button></div>
            </div>
          </details>
          <div className="aiComposer atlasAiComposer">
            <label className="aiFilter">
              <span className="pulseDot" />
              <input value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (!images.length) return; event.preventDefault(); void addAtlasPromptImages(images); }} onKeyDown={(event) => { if (event.key === "Enter") void askAtlasCodex(); }} placeholder="Décris un filtre ou colle un mood board…" aria-label="Demander un filtre à Codex" />
              <input ref={atlasImageInputRef} className="hiddenImageInput" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { void addAtlasPromptImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <button className="attachButton" type="button" onClick={() => atlasImageInputRef.current?.click()} aria-label="Ajouter des images" title="Ajouter ou coller un mood board">＋ img</button>
              <select className="reasoningSelect" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as "low" | "medium")} aria-label="Niveau de réflexion Luna"><option value="low">Luna low</option><option value="medium">Luna medium</option></select>
              <button type="button" className="filterButton" onClick={() => void askAtlasCodex()}>Filtrer</button>
              <button type="button" className="discoverButton" disabled={discoveryBusy || !aiPrompt.trim()} aria-busy={discoveryBusy} onClick={() => void startAtlasDiscovery()} title="Faire planifier puis exécuter une recherche locale sur les shops">{discoveryBusy ? "Trouve…" : "Trouver"}</button>
              <button type="button" className="visionButton" title="Vision 1×1 ou Planche + détail" disabled={visualBusy} onClick={() => void askAtlasVision()}>{visualBusy ? "Analyse…" : "Vision"}</button>
            </label>
            {(promptImages.length > 0 || aiStatus) && (
              <div className="aiSubline">
                {promptImages.map((image) => <span className="promptImage" key={image.id} title={image.name}><img src={image.dataUrl} alt="" /><button type="button" onClick={() => setPromptImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Retirer ${image.name}`}>×</button></span>)}
                {promptImages.length > 0 && <span className="segmented analysisMode"><button className={visualMode === "sequential" ? "active" : ""} onClick={() => setVisualMode("sequential")}>1×1</button><button className={visualMode === "sheet" ? "active" : ""} onClick={() => setVisualMode("sheet")}>Planche + détail</button></span>}
                {aiStatus && <span className="aiStatus atlasAiStatus">{aiStatus}{aiItems && <button onClick={() => { setAiItems(null); setAiStatus(""); }}>×</button>}</span>}
              </div>
            )}
          </div>
        </div>

        <div className="operationStack">
          {refreshJob && !["complete", "cancelled"].includes(refreshJob.status) && <div className={`jobProgress${["error", "blocked"].includes(refreshJob.status) ? " jobError" : ""}`} role="status"><span style={{ width: progressTotal ? `${Math.min(100, progressDone / progressTotal * 100)}%` : "18%" }} /><b>{["error", "blocked"].includes(refreshJob.status) ? refreshJob.error ?? "Certaines fiches sont bloquées" : refreshRecovered ? "Une vérification locale peut être reprise" : refreshJob.message ?? "Fiches en cours de vérification"}</b><em>{progressTotal ? `${progressDone}/${progressTotal}` : refreshJob.status}</em>{refreshNeedsResume ? refreshJob.canResume !== false && <button onClick={() => void retryAtlasRefresh()}>Reprendre</button> : <button onClick={() => void cancelAtlasRefresh()}>Arrêter</button>}</div>}
          {discoveryJobs.length > 0 && <div className={`discoveryProgress${discoveryHasFailures ? " discoveryError" : discoveryWasCancelled ? " discoveryCancelled" : ""}`} role="status" aria-live="polite" title={discoveryPlan?.description}>
            <span className="discoveryFill" style={{ width: `${Math.round(discoveryProgress * 100)}%` }} />
            <div className="discoveryPlanInfo"><b>{discoveryPlan?.name ?? "Découverte agentique"}</b><small>Tailles {discoverySizes} · {discoverySources.join(" + ") || "shops locaux"}{discoveryPlan?.targetCount ? ` · cible ${discoveryPlan.targetCount}` : ""} · {discoveryStatusText}</small></div>
            <em><b>{discoveryDiscovered}</b> nouveau{discoveryDiscovered > 1 ? "x" : ""}{discoveryDiscarded > 0 ? ` · ${discoveryDiscarded} écartés` : ""}</em>
            <div className="discoveryActions">{discoveryBusy && discoveryHasActive && <button type="button" onClick={() => void cancelAtlasDiscovery()}>Arrêter</button>}{discoveryCanResume && <button type="button" onClick={() => void resumeAtlasDiscovery()}>Reprendre</button>}</div>
          </div>}
        </div>

        <div ref={atlasElementRef} className={`${mode === "space" ? "atlas spaceMode" : "atlas gridMode"}${dragging ? " dragging" : ""}`} onScroll={(event) => scheduleAtlasView(event.currentTarget)} onPointerDown={startAtlasPan} onPointerMove={atlasPan} onPointerUp={stopAtlasPan} onPointerCancel={stopAtlasPan}>
          <div className="atlasCanvas" style={mode === "space" ? ({ width: spaceLayout.width, height: spaceLayout.height } as CSSProperties) : undefined}>
            {renderedProducts.map((item, index) => (
              <article
                className={`productCard ${item.kind === "reference" ? "referenceCard" : ""} decision-${item.decision}${compareIds.has(item.id) ? " comparing" : ""}${outfitDraftIds.has(item.id) ? " inOutfit" : ""}`}
                key={item.id} style={mode === "space" ? atlasSpaceCardStyle(item, spaceLayout) : undefined} title={item.reason}
                data-card-index={index} data-product-id={item.id} tabIndex={index === effectiveFocusedIndex ? 0 : -1}
                aria-label={`${item.brand}, ${item.name}, ${atlasDecisionLabel(item.decision)}`}
                onFocus={() => setFocusedIndex(index)} onKeyDown={(event) => handleAtlasCardKey(event, item, index)} onPointerEnter={prepareAtlasPreview}
                onPointerLeave={(event) => cancelAtlasPreview(event.currentTarget)}
              >
                <div className="cardActions">
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={item.decision === "saved" ? "active" : ""} onClick={() => void setAtlasDecision(item, "saved")} aria-label={item.decision === "saved" ? `Retirer ${item.name} des gardés` : `Garder ${item.name}`} title="Garder (S)">{item.decision === "saved" ? "♥" : "♡"}</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={compareIds.has(item.id) ? "active" : ""} onClick={() => toggleCompare(item.id)} aria-label={`Comparer ${item.name}`} title="Comparer (C)">⇄</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={outfitDraftIds.has(item.id) ? "active" : ""} onClick={() => toggleOutfitDraft(item.id)} aria-label={`Ajouter ${item.name} à une tenue`} title="Ajouter à une tenue">＋</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={item.decision === "owned" ? "active" : ""} onClick={() => void setAtlasDecision(item, "owned")} aria-label={`Marquer ${item.name} comme possédé`} title="Possédé (O)">◆</button>
                  <button tabIndex={index === effectiveFocusedIndex ? 0 : -1} className={item.decision === "rejected" ? "active reject" : "reject"} onClick={() => void setAtlasDecision(item, "rejected")} aria-label={`Rejeter ${item.name}`} title="Rejeter (R)">×</button>
                </div>
                {item.url && item.kind === "shop" && <a tabIndex={index === effectiveFocusedIndex ? 0 : -1} className="productLinkOverlay" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Prévisualiser ${item.brand} — ${item.name}`} onClick={(event) => {
                  if (atlasSuppressClickRef.current) { event.preventDefault(); atlasSuppressClickRef.current = false; return; }
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); cancelAtlasPreview(event.currentTarget.closest<HTMLElement>(".productCard") ?? undefined); setPreviewItem(item);
                }} />}
                <div className={`productImage${item.image ? " hasImage" : ""}`} style={{ backgroundPosition: item.crop }}>{item.image && <img src={item.image} alt="" loading="lazy" decoding="async" onLoad={(event) => {
                  const card = event.currentTarget.closest<HTMLElement>(".productCard");
                  if (mode === "space" && card && atlasHoverCardRef.current === card && card.matches(":hover") && card.style.getPropertyValue("--hover-scale")) applyNaturalPreviewGeometry(card);
                }} />}</div>
                <div className="productMeta">
                  <div className="scoreRow"><span>{item.brand}</span><b>{item.score}</b></div>
                  <h3>{item.name}</h3><p>{item.reason ?? `${item.color} · ${item.fit}`}</p>
                  <strong>{item.kind === "reference" ? "Ancre de style" : item.kind === "owned" ? "Dans mon dressing" : item.price == null ? "Prix inconnu" : `${item.currency} ${item.price.toFixed(2)}`}{item.kind === "shop" && item.sizeAvailabilityKnown && <em className="sizeSummary"> · {item.sizes.length ? item.sizes.slice(0, 5).join(" ") : "épuisé"}</em>}</strong>
                  {item.kind === "shop" && <small className={atlasIsStale(item.stockCheckedAt) ? "freshness stale" : "freshness"} title={`Stock ${atlasTimestamp(item.stockCheckedAt)} · prix ${atlasTimestamp(item.priceCheckedAt)} · tailles ${atlasTimestamp(item.sizesCheckedAt)}`}>{atlasIsStale(item.stockCheckedAt) ? "◷ à vérifier" : `● stock ${atlasTimestamp(item.stockCheckedAt)}`}</small>}
                </div>
                {item.kind !== "shop" && <span className="kindBadge">{item.kind === "reference" ? "RÉF" : "MOI"}</span>}
                {item.decision === "owned" && item.kind === "shop" && <span className="kindBadge">MOI</span>}
              </article>
            ))}
            {products.length === 0 && (
              <div className="emptyBoard">
                <strong>{scope === "owned" ? "Ton dressing attend sa première pièce" : scope === "outfits" ? "Aucune planche de tenue ici" : `Aucun article${selectedSizes.length ? ` confirmé en ${selectedSizes.join(" ou ")}` : ""}`}</strong>
                <span>{scope === "owned" ? "Ajoute une photo et quelques métadonnées : Luna pourra ensuite évaluer les vrais ajouts à ta garde-robe." : scope === "outfits" ? "Sélectionne ＋ sur quelques cartes, puis ouvre Tenues pour les assembler." : "Les tailles inconnues et les rejetés restent exclus par défaut."}</span>
                {(scope === "owned" || scope === "reference") && <button className="primaryButton" onClick={() => setDrawer("add")}>＋ Ajouter une pièce</button>}
              </div>
            )}
            {mode === "grid" && renderLimit < products.length && <button ref={loadMoreRef} className="loadMore" onClick={() => setRenderWindow((current) => ({ signature: renderSignature, limit: Math.min((current.signature === renderSignature ? current.limit : ATLAS_PAGE_SIZE) + ATLAS_PAGE_SIZE, products.length) }))}>Afficher {Math.min(ATLAS_PAGE_SIZE, products.length - renderLimit)} de plus</button>}
          </div>
        </div>
        {mode === "space" && <canvas ref={atlasMinimapRef} className="atlasMinimap" width={360} height={220} aria-label="Minimap du board" onPointerDown={navigateAtlasMinimap} onPointerMove={navigateAtlasMinimap} />}

        <footer className="boardFooter atlasBoardFooter"><span><b>{products.length}</b> pièces · {renderedProducts.length} rendues{staleCount ? ` · ${staleCount} à vérifier` : ""}</span><span>Flèches naviguent · S garde · R rejette · C compare · ⌘Z annule</span><span>Placement X/Y · voisinage visuel</span></footer>
      </section>

      {compareItems.length > 0 && (
        <aside className="compareDock" aria-label={`${compareItems.length} pièce${compareItems.length > 1 ? "s" : ""} à comparer`}>
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
            <header><div><span className="eyebrow">Wardrobe Atlas</span><h2 id="drawer-title">{drawer === "compare" ? "Comparer" : drawer === "views" ? "Vues sauvegardées" : drawer === "add" ? "Ajouter au catalogue" : "Planches de tenues"}</h2></div><button ref={drawerCloseRef} className="drawerClose" onClick={() => setDrawer(null)} aria-label="Fermer">×</button></header>

            {drawer === "compare" && (
              <div className="drawerBody">
                {compareItems.length === 0 ? <div className="drawerEmpty"><strong>Aucune pièce à comparer</strong><span>Utilise ⇄ sur les cartes. Quatre pièces maximum, pour garder la décision lisible.</span></div> : <>
                  <div className="compareGrid" style={{ "--compare-count": compareItems.length } as CSSProperties}>
                    <b className="compareLabel">Pièce</b>{compareItems.map((item) => <div className="compareHead" key={item.id}>{item.image ? <img src={item.image} alt="" /> : <span className="imageFallback" />}<strong>{item.brand}</strong><span>{item.name}</span><button onClick={() => toggleCompare(item.id)} aria-label={`Retirer ${item.name}`}>×</button></div>)}
                    <b className="compareLabel">Prix</b>{compareItems.map((item) => <span key={item.id}>{item.price == null ? "—" : `${item.currency} ${item.price.toFixed(2)}`}{item.originalPrice ? <del>{item.originalPrice.toFixed(2)}</del> : null}</span>)}
                    <b className="compareLabel">Tailles</b>{compareItems.map((item) => <span key={item.id}>{item.sizeAvailabilityKnown ? item.sizes.join(" · ") || "Épuisé" : "Inconnues"}</span>)}
                    <b className="compareLabel">Matière</b>{compareItems.map((item) => <span key={item.id}>{item.materials.join(", ") || "Non renseignée"}</span>)}
                    <b className="compareLabel">Retours</b>{compareItems.map((item) => <span key={item.id}>{item.returnsLabel ?? (item.returnsWindowDays ? `${item.returnsWindowDays} jours` : "Inconnus")}</span>)}
                    <b className="compareLabel">Stock</b>{compareItems.map((item) => <span className={atlasIsStale(item.stockCheckedAt) ? "staleText" : ""} key={item.id}>{atlasTimestamp(item.stockCheckedAt)}</span>)}
                    <b className="compareLabel">Prix vérifié</b>{compareItems.map((item) => <span className={atlasIsStale(item.priceCheckedAt) ? "staleText" : ""} key={item.id}>{atlasTimestamp(item.priceCheckedAt)}</span>)}
                    <b className="compareLabel">Tailles vérifiées</b>{compareItems.map((item) => <span className={atlasIsStale(item.sizesCheckedAt) ? "staleText" : ""} key={item.id}>{atlasTimestamp(item.sizesCheckedAt)}</span>)}
                    <b className="compareLabel">Pourquoi</b>{compareItems.map((item) => <span key={item.id}>{item.reason ?? "Pas encore évalué par Luna"}</span>)}
                    <b className="compareLabel">Décision</b>{compareItems.map((item) => <div className="compareDecision" key={item.id}><button className={item.decision === "saved" ? "active" : ""} onClick={() => void setAtlasDecision(item, "saved")}>♥ Garder</button><button className={item.decision === "owned" ? "active" : ""} onClick={() => void setAtlasDecision(item, "owned")}>◆</button><button onClick={() => void setAtlasDecision(item, "rejected")}>×</button></div>)}
                  </div>
                  <div className="drawerFooter"><button onClick={() => void startAtlasRefresh(compareItems.map((item) => item.id))}>↻ Rafraîchir ces fiches</button><button className="primaryButton" onClick={() => { setOutfitDraftIds(new Set(compareIds)); setDrawer("outfits"); }}>Créer une tenue</button></div>
                </>}
              </div>
            )}

            {drawer === "views" && (
              <div className="drawerBody">
                <form className="inlineCreate" onSubmit={(event) => void saveAtlasView(event)}><input value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="Nom de cette vue" aria-label="Nom de la vue" /><button className="primaryButton">Sauvegarder</button></form>
                <p className="drawerHint">La vue mémorise scope, filtres, tailles, rendu d’image, axes et mode — jamais ton prompt, ton zoom ou ta position.</p>
                <div className="savedList">{savedViews.map((view) => <div className="savedRow" key={view.id}><button className="savedMain" onClick={() => applyAtlasView(view)}><strong>{view.name}</strong><span>{atlasScopes.find((item) => item.id === view.scope)?.label} · {view.activeFilter} · {view.mode === "space" ? "PCA" : "grille"} · {view.imageMode === "full" ? "images entières" : "recadrées"}{view.sizeFilters.length ? ` · ${view.sizeFilters.join(" ou ")}` : ""}</span></button><button className="iconDanger" onClick={() => void deleteAtlasView(view.id)} aria-label={`Supprimer ${view.name}`}>×</button></div>)}{savedViews.length === 0 && <div className="drawerEmpty"><strong>Aucune vue sauvegardée</strong><span>Compose un filtre précis, puis reviens ici pour le garder.</span></div>}</div>
                <div className="drawerFooter"><button onClick={exportAtlasJson}>⇩ Exporter le scope en JSON</button></div>
              </div>
            )}

            {drawer === "add" && (
              <form className="drawerBody personalForm" onSubmit={(event) => void addAtlasPersonalItem(event)}>
                <div className="kindSwitch segmented"><button type="button" className={personalKind === "owned" ? "active" : ""} onClick={() => setPersonalKind("owned")}>◆ Vêtement possédé</button><button type="button" className={personalKind === "reference" ? "active" : ""} onClick={() => setPersonalKind("reference")}>◈ Référence visuelle</button></div>
                <input ref={personalImageInputRef} className="hiddenImageInput" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={async (event) => { try { const next = await atlasReadImages(Array.from(event.target.files ?? []), personalImages.length, true); setPersonalImages((current) => [...current, ...next].slice(0, ATLAS_MAX_IMAGES)); } catch (error) { setToast(error instanceof Error ? error.message : "Images invalides"); } event.target.value = ""; }} />
                <button type="button" className="imageDrop" onClick={() => personalImageInputRef.current?.click()}><span>＋</span><strong>Ajouter des photos</strong><small>JPG, PNG ou WebP · 6 images · 24 MB max</small></button>
                {personalImages.length > 0 && <div className="personalPreviews">{personalImages.map((image) => <span key={image.id}><img src={image.dataUrl} alt="" /><button type="button" onClick={() => setPersonalImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Retirer ${image.name}`}>×</button></span>)}</div>}
                <label>Nom<input name="name" required placeholder={personalKind === "owned" ? "Mon cardigan brun" : "Silhouette courte / pantalon ample"} /></label>
                <div className="formColumns"><label>Catégorie<select name="category"><option>Vestes</option><option>Pantalons</option><option>Mailles</option><option>Chemises</option><option>T-shirts</option><option>Chaussures</option><option>Accessoires</option><option>Autre</option></select></label><label>Couleur<input name="color" placeholder="Chocolat" /></label></div>
                <div className="formColumns"><label>Coupe<input name="fit" placeholder="Large, courte…" /></label><label>Tags<input name="tags" placeholder="automne, texture" /></label></div>
                <button className="primaryButton submitPersonal" disabled={personalBusy}>{personalBusy ? "Ajout…" : personalKind === "owned" ? "Ajouter au dressing" : "Ajouter comme référence"}</button>
              </form>
            )}

            {drawer === "outfits" && (
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

      {previewProduct?.url && (
        <div className="productPreviewBackdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setPreviewItem(null); }}>
          <section ref={previewDialogRef} tabIndex={-1} className="productPreviewDialog" role="dialog" aria-modal="true" aria-labelledby="product-preview-title">
            <header>
              <div><span>{previewProduct.brand}</span><h2 id="product-preview-title">{previewProduct.name}</h2></div>
              <div className="productPreviewActions">
                <strong>{previewProduct.price == null ? "Prix inconnu" : `${previewProduct.currency} ${previewProduct.price.toFixed(2)}`}</strong>
                <button className="productPreviewRefresh" type="button" disabled={Boolean(refreshJob && !(refreshJob.terminal ?? ATLAS_TERMINAL_REFRESH_STATUSES.includes(refreshJob.status)))} onClick={() => void startAtlasRefresh([previewProduct.id])}>↻ Actualiser</button>
                <a href={previewProduct.url} target="_blank" rel="noopener noreferrer">Ouvrir dans un onglet ↗</a>
                <button ref={previewCloseRef} type="button" onClick={() => setPreviewItem(null)} aria-label="Fermer la prévisualisation">×</button>
              </div>
            </header>
            <div className="productQuickLook">
              <div className={`productPreviewGallery gallery-${Math.min(4, Math.max(1, previewProduct.images.length))}`}>
                {(previewProduct.images.length ? previewProduct.images : previewProduct.image ? [previewProduct.image] : []).map((image, imageIndex) => <img key={`${previewProduct.id}-${imageIndex}`} src={image} alt={`${previewProduct.name} — vue ${imageIndex + 1}`} />)}
                {!previewProduct.images.length && !previewProduct.image && <div className="productPreviewNoImage">Aucune image capturée</div>}
              </div>
              <aside className="productPreviewFacts">
                <section><span>Disponibilité</span><strong>{previewProduct.stockStatus === "in_stock" ? "En stock" : previewProduct.stockStatus === "out_of_stock" ? "Épuisé" : "À vérifier"}</strong><small>Stock {atlasTimestamp(previewProduct.stockCheckedAt)}</small></section>
                <section><span>Tailles</span><div className="productPreviewSizes">{previewProduct.sizeAvailabilityKnown ? previewProduct.sizes.length ? previewProduct.sizes.map((size) => <b key={size}>{size}</b>) : <em>Épuisé</em> : <em>Pas encore vérifiées</em>}</div><small>Tailles {atlasTimestamp(previewProduct.sizesCheckedAt)}</small></section>
                <section><span>Détails</span><dl><div><dt>Catégorie</dt><dd>{previewProduct.category}</dd></div><div><dt>Couleur</dt><dd>{previewProduct.color}</dd></div><div><dt>Coupe</dt><dd>{previewProduct.fit}</dd></div><div><dt>Matière</dt><dd>{previewProduct.materials.join(", ") || "Inconnue"}</dd></div><div><dt>Retours</dt><dd>{previewProduct.returnsLabel ?? (previewProduct.returnsWindowDays ? `${previewProduct.returnsWindowDays} jours` : "Inconnus")}</dd></div></dl></section>
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
