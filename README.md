# PulseAnalytics — Frontend Analytics Platform 

A polished, frontend-only analytics platform you can deploy on GitHub Pages.

## Features
- Overview dashboard (KPIs + charts)
- Events Explorer (filtering, searching, sorting, pagination)
- Funnel analysis (unique-user steps + drop-off heuristics)
- Cohort retention (signup-week cohorts)
- Segment Builder (build segments and drill down)
- Alert rules (threshold checks against current filtered metrics)
- Import CSV / Export JSON / Export CSV
- Data persistence via LocalStorage
- Responsive UI + Dark/Light theme

## Run locally
Just open `index.html` in a browser.

## Deploy on GitHub Pages
1. Push this repo to GitHub
2. Settings → Pages → Deploy from branch → select `main` and `/root`
3. Your site will appear as a GitHub Pages link

## CSV Schema
Columns:
`timestamp,user_id,event,device,region,plan,value,category,properties_json`

Example events:
- session_start
- page_view
- signup
- add_to_cart
- purchase
