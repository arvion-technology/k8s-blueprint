SHELL := /bin/bash
ENV ?= dev

.PHONY: help validate render-base sync render test demo

help:
	@echo "make validate         render chart through overlays + policy checks"
	@echo "make render-base      regenerate base/ from chart defaults"
	@echo "make sync             regenerate demo/chart-data.js"
	@echo "make render ENV=prod  print the rendered manifests for an overlay"
	@echo "make test             node --test"
	@echo "make demo             serve the demo on :4173"

validate:
	@./scripts/validate.sh

render-base:
	@node scripts/render-base.mjs

sync:
	@node scripts/sync-demo.mjs

render:
	@node -e "import('./scripts/chart-files.mjs').then(async ({loadChart,loadOverlays}) => { const {renderOverlay}=await import('./src/render.js'); const {stringifyYaml}=await import('./src/yaml.js'); const root=process.cwd(); const {chart}=loadChart(root); const overlay=loadOverlays(root).find(o=>o.name===process.env.ENV||o.name==='$(ENV)'); const {manifests}=renderOverlay({chart,overlay}); for (const m of manifests) console.log('---'); console.log(stringifyYaml(m.manifest)); });"

test:
	@npm test

demo:
	@node scripts/serve.mjs . 4173
