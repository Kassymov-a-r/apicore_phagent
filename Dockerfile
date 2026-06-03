FROM mcr.microsoft.com/playwright:v1.52.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/storage/sessions /app/storage/screenshots
ENV HEADLESS=true
ENV SQLITE_PATH=/app/storage/data.sqlite
EXPOSE 3000
CMD ["npm", "start"]
