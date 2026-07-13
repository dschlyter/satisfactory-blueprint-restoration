# Satisfactory Blueprint Recovery

Satisfactory game saves are cloud synced, but blueprints are not, which means they will be lost when machines are switched. However the blueprints are still in the save file, so they can be extracted and restored. This tool helps you do this.

# Development

## Web version

A static HTML page where you drag-and-drop your save file and download blueprints. Everything runs locally in your browser.

```bash
npm install
npm run serve
```

Or via podman (no npm install needed):

```bash
./run.sh serve
```

## CLI version

```bash
npm install
node src/index.mjs your-save.sav list
node src/index.mjs your-save.sav extract --all
```

Alternatively, run in a podman container for sandboxed execution:

```bash
./run.sh data/your-save.sav list
./run.sh data/your-save.sav extract --all
```
