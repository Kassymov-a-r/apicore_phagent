FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 videobot
WORKDIR /app
COPY uniquifier ./uniquifier
RUN mkdir /app/work && chown -R videobot:videobot /app
USER videobot
CMD ["python", "-m", "uniquifier.bot"]
