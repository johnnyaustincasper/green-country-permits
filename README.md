# IST Permit Intel — Tulsa Metro

Construction permit intelligence map for NE Oklahoma. HD satellite imagery with real November 2025 NOW Report permit data.

## Deploy to Vercel (5 minutes)

### 1. Get a Mapbox Token (free)
- Go to [mapbox.com/signup](https://account.mapbox.com/auth/signup/) — no credit card
- After signup, copy your **Default public token** from the dashboard (starts with `pk.`)

### 2. Push to GitHub
```bash
git init
git add .
git commit -m "IST Permit Intel v1"
git remote add origin https://github.com/YOUR_USERNAME/ist-permit-intel.git
git push -u origin main
```

### 3. Deploy on Vercel
- Go to [vercel.com](https://vercel.com) and import the GitHub repo
- **Before deploying**, go to Settings > Environment Variables
- Add: `NEXT_PUBLIC_MAPBOX_TOKEN` = your Mapbox token (paste the pk.xxx value)
- Deploy

That's it. HD satellite map with all your permit data.

## Features
- **HD Satellite Imagery** — Real aerial photos via Mapbox, zoom into neighborhoods and lots
- **3D Terrain** — Elevation and hills rendered in 3D
- **60+ Real Permits** — November 2025 NOW reports parsed and geocoded
- **Filter by city** — Click any city chip to fly there
- **Custom-only toggle** — Strip out production builders (Simmons, DR Horton, etc.)
- **Click any pin** — Builder name, phone, sqft, value, subdivision, contact person
- **Style switching** — Satellite / Hybrid (sat + roads) / Dark vector

## Adding New Permit Data
Edit `lib/permits.js` and add entries to the `PERMITS` array. Each permit needs:
```js
{
  id: 100,
  builder: "Builder Name",
  address: "123 E Main St",
  city: "Tulsa",
  sqft: 3500,
  value: 450000,
  lat: 36.15,
  lng: -95.95,
  week: "12/1-12/7",
  phone: "(918)555-1234",
  subdivision: "Subdivision Name",
  contact: "Contact Person",
  production: false
}
```

## Celeste Auto-Upload (Future)
The next step is connecting to Firebase so Celeste can auto-push new permits weekly. The pipeline:
1. NOW PDF arrives → Celeste parses HOUSE-NEW entries
2. Geocodes addresses via Google Maps API
3. Pushes to Firestore `permits` collection
4. This app reads from Firestore instead of the static file
5. Map updates live — zero manual work

## Local Development
```bash
cp .env.local.example .env.local
# Edit .env.local with your Mapbox token
npm install
npm run dev
```
