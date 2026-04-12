# CGA Dashboards Project

## What this is
Automated sales pipeline dashboards for CGA Growers Association, pulling live data from GoHighLevel CRM.

## GHL Details
- Location ID: KdQ3HwgUyOT2bXhJRwQ3
- API Base: https://services.leadconnectorhq.com
- API Key: stored as GitHub Secret (GHL_API_KEY), never in code

## Sales Pipeline IDs
- CHEMICALS: baLiY8EDb3rVmYMcZ5od
- CUSTOM BOXES: UBW05ZwmhKvdtIQTpMsP
- FERTILIZER: DCVBtlDwTjJbdD0wzYCp
- GENERAL MERCH: x6sDRoJEyGvDGaP3kNLv
- IRRIGATION: I4L8FspzjBWLG91nJrM2
- MULCH FILM: Ptfft52Stw3Cz8Jxmd2h
- ROB'S CUSTOM ORDERS: 3zKDcNtA4Aj3PNNhTdy1
- BIANCA'S ORDERS: BjmYeazjI8ODKvLJRIDF

## Opportunity Custom Fields
- Is this newly acquired business?: oMSSLYDRjcnx8j3tWxU9 (Yes/No radio)
- Additional Notes: w7wlP9VMBOH9Hr15pHiZ (Large text)
- Expected Units Required: xFt1ENMUzgLseClxi6is (Number)

## How it works
- GitHub Action runs daily at 5am AWST
- scripts/update-dashboard.js calls GHL API directly
- Rebuilds index.html with fresh data
- Commits and pushes automatically
- GitHub Pages serves it at dashboards.hortxp.com

## Commands
- Manual update: `node scripts/update-dashboard.js` (needs GHL_API_KEY env var)
- Test locally: open index.html in browser
