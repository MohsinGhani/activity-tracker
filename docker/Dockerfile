# Activity Tracker (Electron) running on a virtual Linux desktop.
# View it in your browser via noVNC at http://localhost:6080
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_RESOLUTION=1440x900x24 \
    ELECTRON_DISABLE_SECURITY_WARNINGS=true

# Electron runtime libs + virtual display (Xvfb), window manager, VNC, noVNC,
# and x11-utils (xprop/xwininfo, used by active-win on Linux).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 xvfb fluxbox x11vnc novnc websockify x11-utils \
      libgtk-3-0 libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxss1 \
      libxtst6 libdrm2 libxkbcommon0 libsecret-1-0 libnotify4 dbus-x11 \
      ca-certificates fonts-dejavu-core procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && chown -R node:node /app

COPY --chown=node:node docker/start.sh /usr/local/bin/start.sh
RUN sed -i 's/\r$//' /usr/local/bin/start.sh && chmod +x /usr/local/bin/start.sh

COPY --chown=node:node . .

RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && mkdir -p /home/node/.config && chown -R node:node /home/node
USER node
EXPOSE 6080
CMD ["/usr/local/bin/start.sh"]
