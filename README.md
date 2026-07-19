# IronLog

A self-hosted lifting, body measurement, and progress dashboard. IronLog has no third-party runtime dependencies: it uses Node's built-in HTTP server and stores data in a local JSON file with atomic writes.

## Run locally

Requires Node.js 18 or newer.

```bash
npm start
```

Open `http://localhost:8787`. Data is stored in `data/lifting-data.json`.

## Raspberry Pi

1. Install Node.js 18 or newer on the Pi.
2. Copy the project to `/home/pi/ironlog`.
3. Run `node server.js` and browse to `http://<pi-address>:8787` from any device on the same network.

For automatic startup:

```bash
sudo cp deploy/ironlog.service /etc/systemd/system/ironlog.service
sudo systemctl daemon-reload
sudo systemctl enable --now ironlog
```

If the project lives elsewhere or uses a different Linux user, edit `User`, `WorkingDirectory`, and `ExecStart` in the service file first.

## Configuration

- `PORT`: listening port, default `8787`
- `HOST`: listening interface, default `0.0.0.0`
- `DATA_FILE`: path to the JSON data file, default `data/lifting-data.json`

Use Settings > Export backup regularly. Import replaces the current database with the selected backup.
