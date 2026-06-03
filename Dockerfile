FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=10000
ENV STORAGE_DIR=/app/storage
EXPOSE 10000
CMD ["npm", "start"]
