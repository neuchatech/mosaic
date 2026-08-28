"use client";

import { type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";

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
  { id: 1, brand: "Selected", name: "Veste worker raccourcie", price: 129, color: "Tabac", category: "Vestes", fit: "Courte", score: 94, x: 6, y: 8, crop: "4% 6%" },
  { id: 2, brand: "Weekday", name: "Pantalon ample à pinces", price: 79, color: "Brun", category: "Pantalons", fit: "Large", score: 91, x: 28, y: 18, crop: "29% 9%" },
  { id: 3, brand: "Massimo Dutti", name: "Maille texturée", price: 99, color: "Grège", category: "Mailles", fit: "Relax", score: 88, x: 52, y: 6, crop: "47% 8%" },
  { id: 4, brand: "Carhartt WIP", name: "Surchemise vieillie", price: 149, color: "Olive", category: "Vestes", fit: "Droite", score: 86, x: 73, y: 20, crop: "58% 58%" },
  { id: 5, brand: "ARKET", name: "Pantalon laine ample", price: 139, color: "Anthracite", category: "Pantalons", fit: "Large", score: 84, x: 16, y: 58, crop: "71% 19%" },
  { id: 6, brand: "COS", name: "Cardigan compact", price: 115, color: "Chocolat", category: "Mailles", fit: "Court", score: 82, x: 43, y: 55, crop: "86% 16%" },
  { id: 7, brand: "Levi's", name: "Jean 568 loose", price: 109, color: "Bleu vieilli", category: "Pantalons", fit: "Large", score: 79, x: 67, y: 62, crop: "80% 52%" },
  { id: 8, brand: "Minimum", name: "Pull col rond dense", price: 89, color: "Camel", category: "Mailles", fit: "Relax", score: 77, x: 83, y: 52, crop: "41% 79%" },
  { id: 9, brand: "Référence", name: "Silhouette veste courte", price: 0, color: "Brun", category: "Références", fit: "Courte", score: 97, x: 23, y: 40, crop: "14% 8%", kind: "reference" },
  { id: 10, brand: "Référence", name: "Volume pantalon ample", price: 0, color: "Terre", category: "Références", fit: "Large", score: 96, x: 61, y: 43, crop: "72% 17%", kind: "reference" },
];

const filters = ["Tout", "Vestes", "Pantalons", "Mailles", "Chemises", "T-shirts", "Références"];

function compactItems(items: SeedItem[]): SeedItem[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

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
  }));
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
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const atlasRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
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
  const products = useMemo(
    () => compactItems(visibleCatalog.filter((item) => activeFilter === "Tout" || item.category === activeFilter)),
    [activeFilter, visibleCatalog],
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

  function changeZoom(nextValue: number) {
    const atlas = atlasRef.current;
    const next = Math.min(2.5, Math.max(.65, Math.round(nextValue * 20) / 20));
    if (!atlas) return setZoom(next);
    const contentX = (atlas.scrollLeft + atlas.clientWidth / 2) / zoom;
    const contentY = (atlas.scrollTop + atlas.clientHeight / 2) / zoom;
    setZoom(next);
    requestAnimationFrame(() => {
      atlas.scrollLeft = contentX * next - atlas.clientWidth / 2;
      atlas.scrollTop = contentY * next - atlas.clientHeight / 2;
    });
  }

  function resetView() {
    setZoom(1);
    requestAnimationFrame(() => atlasRef.current?.scrollTo({ left: 0, top: 0 }));
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (mode !== "space" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    changeZoom(zoom * (event.deltaY > 0 ? .9 : 1.1));
  }

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
    const bounds = card.getBoundingClientRect();
    const targetArea = bounds.width * bounds.height * 1.2;
    const ratio = image.naturalWidth / image.naturalHeight;
    card.style.setProperty("--hover-width", `${Math.sqrt(targetArea * ratio)}px`);
    card.style.setProperty("--hover-height", `${Math.sqrt(targetArea / ratio)}px`);
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
              <div className="axisLegend">
                <span>habillé</span>
                <i />
                <span>casual</span>
              </div>
              <div className="segmented" aria-label="Mode d’affichage">
                <button className={mode === "space" ? "active" : ""} onClick={() => setMode("space")}>Espace</button>
                <button className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>Grille</button>
              </div>
              <div className="zoomControls" aria-label="Zoom du board">
                <button disabled={mode !== "space" || zoom <= .65} onClick={() => changeZoom(zoom - .15)} aria-label="Dézoomer">−</button>
                <button disabled={mode !== "space"} onClick={resetView} className="zoomValue">{Math.round(zoom * 100)}%</button>
                <button disabled={mode !== "space" || zoom >= 2.5} onClick={() => changeZoom(zoom + .15)} aria-label="Zoomer">＋</button>
              </div>
            </div>
          </div>

          <div className="filterBar">
            <button><small>Source</small><strong>Toutes</strong><span>⌄</span></button>
            <button><small>Prix</small><strong>40–180</strong><span>⌄</span></button>
            <button><small>Coupe</small><strong>Large · courte</strong><span>⌄</span></button>
            <button><small>Matière</small><strong>Toutes</strong><span>⌄</span></button>
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
            onWheel={handleWheel}
            onPointerDown={startPan}
            onPointerMove={pan}
            onPointerUp={stopPan}
            onPointerCancel={stopPan}
          >
            <div className="atlasCanvas" style={mode === "space" ? ({ zoom, width: `${zoom * 160}%` } as CSSProperties) : undefined}>
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
                  <strong>{item.kind === "reference" ? "Ancre de style" : item.price == null ? "Prix inconnu" : `CHF ${item.price.toFixed(2)}`}</strong>
                </div>
              </article>
            ))}
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
