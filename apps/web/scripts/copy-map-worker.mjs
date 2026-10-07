// MapLibre runs its tile parsing in a module worker that it loads by URL, next to its own script.
// The bundler does not emit that file, so copy it (and the code it shares with the main script)
// into public/ before every build; the map points MapLibre at it (components/map/StreetMap.tsx).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const out = join(dirname(fileURLToPath(import.meta.url)), "../public/map/maplibre");
mkdirSync(out, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, file), join(out, file));
