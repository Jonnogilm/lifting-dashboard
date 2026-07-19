# IronLog

IronLog is a self-hosted lifting, body measurement, and progress dashboard. It has no third-party runtime dependencies: Node's built-in HTTP server serves the application, and data is stored in a local JSON file using atomic writes.

## What you need

- A Raspberry Pi running Ubuntu Server or Ubuntu Desktop 24.04 LTS
- A network connection, preferably Ethernet for an always-on server
- Node.js 18 or newer
- A free Tailscale account
- Tailscale installed on each phone or computer that will access IronLog remotely

IronLog does not currently have its own login system. The recommended setup uses Tailscale to keep it private. **Do not configure router port forwarding for port 8787.** Tailscale works without opening an inbound router port, public DNS, or a static public IP.

## Run on a laptop

Requires Node.js 18 or newer.

```bash
npm test
npm start
```

Open `http://localhost:8787`. Application data is stored in `data/lifting-data.json`.

## Install on Ubuntu 24.04 on a Raspberry Pi

The commands below are for Ubuntu 24.04 LTS and clone IronLog to `/home/<your-user>/ironlog`. Run them in a terminal on the Pi, either directly or over SSH.

Confirm the installed operating system and CPU architecture:

```bash
. /etc/os-release && echo "$PRETTY_NAME"
uname -m
```

The operating system should report Ubuntu 24.04 LTS. A 64-bit Raspberry Pi installation normally reports `aarch64`.

### 1. Install system packages

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y git curl nodejs npm
```

Confirm that Node.js is version 18 or newer:

```bash
node --version
npm --version
```

The Ubuntu 24.04 repositories should provide a compatible Node.js version. Do not continue if `node --version` reports anything older than version 18.

### 2. Clone IronLog

```bash
cd "$HOME"
git clone https://github.com/Jonnogilm/lifting-dashboard.git ironlog
cd "$HOME/ironlog"
npm test
```

This repository is currently accessible over HTTPS. If it becomes private, authenticate with GitHub using an SSH key or personal access token before cloning.

### 3. Test the server

```bash
npm start
```

In another terminal, verify the health endpoint:

```bash
curl http://127.0.0.1:8787/api/health
```

The response should be:

```json
{"status":"ok"}
```

Stop the manual server with `Ctrl+C` before configuring the background service.

## Start IronLog automatically

The repository includes a `systemd` service template with defaults for Ubuntu's typical `ubuntu` account. The following commands adapt it to the actual Ubuntu username, clone directory, and Node.js executable, so they also work when a custom username was selected during installation:

```bash
cd "$HOME/ironlog"

INSTALL_DIR="$(pwd)"
INSTALL_USER="$(id -un)"
NODE_PATH="$(command -v node)"

sed \
  -e "s|User=ubuntu|User=${INSTALL_USER}|" \
  -e "s|/home/ubuntu/ironlog|${INSTALL_DIR}|g" \
  -e "s|/usr/bin/node|${NODE_PATH}|" \
  deploy/ironlog.service | sudo tee /etc/systemd/system/ironlog.service >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now ironlog
```

`enable` starts IronLog during every boot. The service also restarts the Node process if it crashes.

Check the service and local endpoint:

```bash
sudo systemctl status ironlog --no-pager
curl http://127.0.0.1:8787/api/health
```

View live application logs:

```bash
sudo journalctl -u ironlog -f
```

Press `Ctrl+C` to leave the log view; this does not stop IronLog.

## Access IronLog from anywhere with Tailscale

Tailscale creates a private encrypted network between the Pi and your approved devices. This replaces conventional router port forwarding.

### 1. Install Tailscale on the Pi

Use the [official Tailscale Linux installer](https://tailscale.com/docs/install/linux):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up
```

`tailscale up` prints an authentication URL. Open that URL and sign into your Tailscale account. Then verify the connection:

```bash
tailscale status
tailscale ip
```

### 2. Publish IronLog privately inside Tailscale

```bash
tailscale serve --bg 8787
tailscale serve status
```

Tailscale prints a private HTTPS address similar to:

```text
https://your-pi.your-tailnet.ts.net
```

The `--bg` option stores the Serve configuration and restores it after a reboot or Tailscale restart. See the [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve) for current command details.

### 3. Connect your phone or laptop

1. Install Tailscale on the phone, tablet, or computer.
2. Sign in with the same Tailscale account used for the Pi.
3. Confirm the device appears in the [Tailscale Machines dashboard](https://login.tailscale.com/admin/machines).
4. Open the HTTPS address printed by `tailscale serve status`.

The device can now reach IronLog over cellular data, hotel Wi-Fi, or another network. Only devices and users permitted by your Tailscale account can connect.

For an unattended server, Tailscale allows device-key expiry to be disabled from the Machines dashboard. Do this only for a trusted, physically secured Pi, because a non-expiring device key has a larger security impact if the Pi is stolen.

## Recover automatically after a power outage

A Raspberry Pi normally boots as soon as power returns. The two persistent services handle the rest:

- `ironlog.service` starts the dashboard and restarts it after application failures.
- `tailscaled.service` reconnects the Pi to Tailscale.
- `tailscale serve --bg` restores the private HTTPS proxy.

Test the complete boot process:

```bash
sudo reboot
```

Wait for the Pi to reconnect, then open the Tailscale HTTPS address. You can also verify over SSH:

```bash
systemctl is-active ironlog
systemctl is-active tailscaled
tailscale serve status
curl http://127.0.0.1:8787/api/health
```

Each service should report `active`, and the health endpoint should return `{"status":"ok"}`.

The Pi cannot operate while electricity is absent. Frequent sudden outages can also corrupt an SD card. For important or long-term use, add a small UPS or UPS HAT that supports clean shutdown, and keep regular IronLog backups.

## Update IronLog

Application data is ignored by Git, so pulling source updates does not replace the local database.

```bash
cd "$HOME/ironlog"
git pull --ff-only
npm test
sudo systemctl restart ironlog
sudo systemctl status ironlog --no-pager
```

The Tailscale address and Serve configuration do not need to be recreated after application updates.

## Back up your data

Use **Settings > Export backup** in IronLog regularly. The database on the Pi is:

```text
$HOME/ironlog/data/lifting-data.json
```

You can also make a timestamped backup over SSH:

```bash
cd "$HOME/ironlog"
cp data/lifting-data.json "$HOME/ironlog-backup-$(date +%F).json"
```

Importing a backup from IronLog Settings replaces the current database.

## Troubleshooting

### IronLog does not start

```bash
sudo systemctl status ironlog --no-pager
sudo journalctl -u ironlog -n 100 --no-pager
command -v node
```

If the project was moved or the Pi username changed, repeat the commands in **Start IronLog automatically** to regenerate the service file.

### Port 8787 is already in use

```bash
sudo ss -ltnp 'sport = :8787'
```

Stop the other process, or change `Environment=PORT=8787` in `/etc/systemd/system/ironlog.service`, run `sudo systemctl daemon-reload`, and restart IronLog. If the port changes, run `tailscale serve --bg <new-port>` again.

### Local service works but the Tailscale URL does not

```bash
curl http://127.0.0.1:8787/api/health
tailscale status
tailscale serve status
sudo systemctl status tailscaled --no-pager
```

Also confirm that the phone or computer is connected to Tailscale with the correct account.

### Useful service commands

```bash
sudo systemctl restart ironlog
sudo systemctl stop ironlog
sudo systemctl start ironlog
sudo systemctl disable --now ironlog
tailscale serve off
```

## Configuration

- `PORT`: listening port, default `8787`
- `HOST`: listening interface, default `0.0.0.0`
- `DATA_FILE`: database path, default `data/lifting-data.json`

These can be added as `Environment=` entries in `/etc/systemd/system/ironlog.service`. Run `sudo systemctl daemon-reload` and `sudo systemctl restart ironlog` after changing the service file.

## Public access

Tailscale Serve is intentionally private and requires the connecting device to join your Tailscale network. Do not use Tailscale Funnel or direct router port forwarding for the current IronLog build because it has no application-level authentication. A genuinely public deployment should first add authentication and then use an authenticated reverse proxy or access gateway.
