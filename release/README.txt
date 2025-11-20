Homestay Release Installation (HF1) – Quick Guide
=================================================

1. Copy the release bundle and checksum to the target server
   Example:
     scp homestay-r1.0.11-hf1.tar.gz homestay-r1.0.11-hf1.tar.gz.sha256 <server>:/home/<user>/Setup

2. Verify the integrity of the tarball
   sha256sum -c homestay-r1.0.11-hf1.tar.gz.sha256
   (Proceed only if you see “OK”.)

3. Expand the package into /opt
   sudo bash unpack-release.sh homestay-r1.0.11-hf1.tar.gz /opt

4. Run the automated installer
   cd /opt/homestay-r1.0.11-hf1
   sudo bash Installation/setup.sh

5. The installer performs the following:
   - Installs required OS packages/Nginx/PostgreSQL (offline debs if provided)
   - Installs Node.js + PM2 from the bundled deps directory
   - Creates the hptourism system user and app directories (/opt/hptourism/app)
   - Configures PostgreSQL, runs Drizzle migrations, and seeds reference data
   - Builds the client + server bundles, deploys them to /opt/hptourism/app/dist
   - Sets up systemd services (homestay-r1 + nightly backup timer) and Nginx vhost

6. After setup completes:
   - sudo systemctl status homestay-r1
   - sudo systemctl status homestay-r1-backup.timer
   - Access the site via the configured hostname/IP and run a test transaction

The log file for each install is written to /var/log/hptourism-installer/install-<timestamp>.log for audit/troubleshooting.
