FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000
ENV STORAGE_DIR=/app/storage
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install chromium

COPY . .

RUN mkdir -p /app/storage

EXPOSE 10000
CMD ["npm", "start"]
