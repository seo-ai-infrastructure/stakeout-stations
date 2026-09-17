FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends adb ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml requirements.lock ./
COPY src ./src
RUN pip install --no-cache-dir -r requirements.lock && pip install --no-cache-dir --no-deps . && useradd --create-home --uid 10001 drive && mkdir -p /data/duomove && chown -R drive:drive /data
USER drive
ENV PYTHONUNBUFFERED=1 DUOMOVE_STATE_DIR=/data/duomove
EXPOSE 8000
CMD ["duomove-drive", "serve"]
