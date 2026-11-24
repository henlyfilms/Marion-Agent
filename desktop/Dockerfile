FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium dbus-x11 fonts-liberation imagemagick socat \
    tesseract-ocr tigervnc-standalone-server xauth xdotool xfce4 xterm \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash marion \
    && install -d -o marion -g marion /workspace /workspace/files /workspace/profiles

COPY start.sh /usr/local/bin/start-desktop
ENV DISPLAY=:0 HOME=/home/marion
USER marion
WORKDIR /workspace
ENTRYPOINT ["/bin/bash", "/usr/local/bin/start-desktop"]
