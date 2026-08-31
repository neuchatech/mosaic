# Generative try-on studio

## Product shape

The try-on feature should live in a `Studio` drawer, not inside the catalog board. The AI composer creates a draft when it receives one person photo plus one or more attached garments. Every generation becomes an immutable attempt in a compact right-hand rail with thumbnail, status, date, garments, prompt, model, and seed. Opening an attempt shows the full image and lets the user retry, branch, compare, download, or delete it.

This is a visual styling preview, not a sizing guarantee. The UI must say that generated fit, proportions, fabric behavior, logos, and exact colors can be wrong.

## Local data contract

Add two versioned SQLite tables:

- `studio_jobs`: `id`, `status`, `person_media_id`, `prompt`, `provider`, `model`, `consent_at`, `created_at`, `started_at`, `finished_at`, `error`.
- `studio_attempts`: `id`, `job_id`, `parent_attempt_id`, `output_media_id`, `seed`, `prompt_snapshot`, `provider_metadata_json`, `created_at`.
- `studio_garments`: `job_id`, `product_id`, `role`, `position`.

Person photos and outputs belong under `data/studio/<job-id>/`, with random file names and private filesystem permissions. SQLite stores relative media identifiers, never large data URLs. Deleting a job removes its local media and metadata together. Export must be explicit and omit the original person photo by default.

## Provider boundary

Use a narrow adapter so the app is not tied to one image model:

```ts
type TryOnRequest = {
  personImages: string[];
  garments: Array<{ productId: string; image: string; role: string }>;
  prompt: string;
  previousAttemptImage?: string;
};

interface TryOnProvider {
  generate(request: TryOnRequest, signal: AbortSignal): Promise<{
    imageBytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    seed?: string;
    metadata?: Record<string, unknown>;
  }>;
}
```

The first provider can be a general image-edit model. A dedicated virtual try-on provider can be added later without changing the UI or persistence. Any remote provider requires a one-time explicit consent explaining that the selected person and garment images leave the machine. There is no background upload.

## Agent and UI flow

1. The unified composer detects `try_on` when a person photo and garment attachments are present. Before a provider exists, it creates a local draft and opens Studio instead of silently doing something else.
2. Studio shows the person image, garment slots (`haut`, `couche`, `bas`, `chaussures`, `accessoire`), an editable prompt, and the provider/privacy state.
3. **Generate** creates a queued job. The rail streams `queued → generating → complete/error` and survives reloads.
4. `Variante` keeps the same inputs and branches from an attempt. Replacing one garment creates a new job, preserving the old comparison.
5. Completed attempts can be dragged back into the AI composer as mood-board references, but are never treated as shop products.

## Delivery phases

### Phase 1 — local Studio shell

Implement migrations, media storage, CRUD/job APIs, Studio drawer/rail, drag-and-drop garment slots, reload recovery, delete/export, and a fake deterministic provider for UI tests. No image leaves the machine.

### Phase 2 — first generative provider

Add explicit consent, provider credentials in local environment configuration, cancellation/timeouts, provenance metadata, retry/branching, and safety limits on file type/size. Validate identity preservation and garment-reference handling on a small private test set.

### Phase 3 — quality and comparison

Add side-by-side attempts, optional pose/background lock, per-garment masking when supported, result ratings, and provider/model comparison. Keep the original image and every failed attempt locally deletable.

## Acceptance criteria

- A reload never loses job state or completed attempts.
- No remote request occurs before explicit consent.
- Cancelling stops the provider request and leaves a resumable or retryable record.
- Deleting an attempt removes its local output; deleting a job also removes the person-photo copy.
- The rail remains usable with hundreds of attempts through thumbnail virtualization.
- Every output lists the exact input products, provider/model, creation time, and the visual-approximation warning.
