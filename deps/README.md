# Offline Dependency Cache

This folder holds every OS/runtime dependency that the installer needs when the target VM has no internet access.

Included artifacts:

- `nginx_*.deb`, `postgresql-16_*.deb`, `postgresql-client-16_*.deb`, `postgresql-common_*.deb`, `libpq5_*.deb`, `logrotate_*.deb`, `fail2ban_*.deb`, `gettext-base_*.deb`, `rsync_*.deb` – install via `apt-get install -y ./deps/*.deb`
- `node-v20.17.0-linux-x64.tar.xz` – extracted to `/usr/local/lib/nodejs`
- `pm2-*.tgz` – installed with `npm install -g ./deps/pm2-*.tgz`

To refresh this cache on a machine with internet access, run:

```bash
cd /home/subhash.thakur.india/Projects/hptourism-stg-rc3
scripts/fetch-deps.sh
```

The script downloads the latest binaries into `deps/` so `Installation/setup.sh` can run completely offline.
