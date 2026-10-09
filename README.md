# Pic2Desmos

Turn any picture into **one** Desmos equation. Paste it into a single expression line at
[desmos.com/calculator](https://www.desmos.com/calculator) and it draws a line sketch of the picture. You don't need helper definitions, sliders, or t-range changes.

Everything runs in your browser. The image never leaves your device.

## Features

- Upload, drag-and-drop, or paste (Ctrl+V) PNG / JPG / WebP / GIF (first frame) / SVG
- **Crop** and a **mask brush** to erase background areas before edge detection
- Three modes: **Line sketch** (Canny), **Silhouette** (Otsu threshold, for logos), **Color** (k-means clusters, one equation per color)
- Presets (Low / Medium / High / Max) plus an Advanced panel with live sliders
- Instant canvas preview that recomputes exactly what Desmos will draw. Click a stroke to delete it (Ctrl+Z undoes).
- Embedded Desmos calculator that checks the equation and shows a ✅ badge when Desmos accepts it
- Live stats: strokes kept/dropped, list length vs. Desmos's 10,000-element limit, character count, with warnings
- Copy button (with a fallback for non-HTTPS pages), `.txt` download, and a multi-expression export (one equation per stroke)
- Heavy processing runs in a Web Worker, so the UI stays responsive
- OpenCV.js does the image processing. If it can't load, a built-in Canny edge detector and Suzuki–Abe contour tracer take over.
- Light/dark themes, responsive down to 360 px, keyboard shortcuts, settings remembered in `localStorage`

## How the equation works

With `P = 2·(Kmax+1)`, `n` strokes, and `X`/`Y` holding every stroke's quantized Fourier coefficients:

```latex
\frac{1}{S}\left(\sum_{j=0}^{P-1}\left[X\right]\left[P\cdot\left[0...n-1\right]+j+1\right]C,\sum_{j=0}^{P-1}\left[Y\right]\left[P\cdot\left[0...n-1\right]+j+1\right]C\right)
C = \cos\left(2\pi\operatorname{floor}\left(\frac{j}{2}\right)t-\frac{\pi}{2}\operatorname{mod}\left(j,2\right)\right)
```

- `[0...n-1]` makes Desmos broadcast the expression into `n` separate curves, so no lines connect one stroke to the next.
- An even `j` gives `cos(2πkt)` and an odd `j` gives `sin(2πkt)`, so each list appears only once per axis.
- The `2π` means Desmos's default `0 ≤ t ≤ 1` already draws full loops.
- The `\cdot` before `\left[0...n-1\right]` is required. Without it Desmos tries to index a number.
- Each list is capped at 10,000 elements (`n × P ≤ 10000`). The longest strokes are kept first.

The picture fits roughly in `−5 ≤ x ≤ 5`, `0 ≤ y ≤ 10·h/w`.

## Run locally

The page uses a Web Worker and ES modules, so it has to be served over HTTP. Opening `index.html` from the file system won't work.

```bash
cd pic2desmos
python -m http.server 8000
# open http://localhost:8000
```

Add `?fallback` to the URL to test the built-in engine without OpenCV.js.

## Deploy to GitHub Pages

1. Create a new public GitHub repo (e.g. `pic2desmos`) and push these files to the root of the `main` branch.
2. In the repo, open **Settings → Pages**, choose **Deploy from a branch**, select **main** / **(root)**, and click **Save**.
3. Wait about a minute. The site goes live at `https://<username>.github.io/pic2desmos/`.
4. (Optional) Request your own free Desmos API key at <https://www.desmos.com/api> and put it in `js/config.js` (`DESMOS_API_KEY`). The demo key works but shows a console warning and is meant for prototyping.

The empty `.nojekyll` file tells GitHub Pages to serve the files as they are.

## Files

```
index.html          page markup
style.css           styles (light + dark)
js/config.js        API key, CDN URLs, presets, defaults
js/app.js           UI wiring
js/worker.js        image → strokes → Fourier coefficients (Web Worker)
js/fourier.js       resampling + DFT + reconstruction helpers (shared by worker and page)
js/cv-fallback.js   built-in Canny, bilateral, Otsu, contour tracer, k-means
js/equation.js      builds the Desmos LaTeX
js/preview.js       canvas reconstruction + Desmos embed
assets/samples/     sample images
```

## Sample image credits

- `astronaut.jpg`: Eileen Collins, NASA (public domain), via scikit-image
- `cat.jpg`: "Chelsea" by Stéfan van der Walt (CC0), via scikit-image
- `coffee.jpg`: by Rachel Michetti (CC0), via scikit-image
- `logo.svg`: original drawing made for this project

## Tips

- The best quality fix is to crop out frames and paint over busy backgrounds (trees, text).
- If you hit the list limit, lower **Kmax**, raise **Min stroke length**, or use the **Low/Medium** preset.
- Equations over about 60k characters paste fine on desktop but can lag. The Desmos phone app is unreliable with huge pastes.
- In Color mode each color is its own equation. Paste each one into its own line and set its color.
