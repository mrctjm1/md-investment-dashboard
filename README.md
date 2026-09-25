# Maryland Place-Based Investment Dashboard

Interactive dashboard (list, map, detail and "Ask the Ledger" views) over the
Maryland investment tracker's published records — private capital investments
and public funding awards.

- **Site:** plain HTML/JS in `index.html`, hosted on GitHub Pages. No build step.
- **Data:** read live from Supabase on every page load (`md_dashboard.records`,
  a read-only view of published records). Updating the database updates the site;
  there is no export step.
- **Map geometry:** `data/geo/us-counties-10m.json` — Census boundaries from
  [us-atlas](https://github.com/topojson/us-atlas) 3.0.1, bundled so the map never
  depends on a third-party CDN at runtime.
- **Ask the Ledger:** `supabase/functions/ask-the-ledger/` — a Supabase Edge
  Function that reads the same view and calls the Claude API with a key held in
  Supabase secrets. The browser only ever sends the question.

The only key in this repo is Supabase's publishable key, which is meant to be
public: it can read the published-records view and nothing else.

## Local preview

```
python -m http.server 8765 --bind 127.0.0.1
```
then open http://127.0.0.1:8765/.

## Deploying changes

- Site: push to `main`; GitHub Pages redeploys automatically.
- Edge Function: `supabase functions deploy ask-the-ledger --no-verify-jwt`
- Database view: see `supabase/migrations/`.
