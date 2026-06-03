FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000
ENV STORAGE_DIR=/app/storage
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

COPY package*.json .npmrc ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/storage /app/storage/sessions /app/storage/data

EXPOSE 10000
CMD ["npm", "start"]
