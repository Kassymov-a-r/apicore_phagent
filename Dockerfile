FROM mcr.microsoft.com/playwright:v1.52.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV HEADLESS=true
EXPOSE 3000
CMD ["npm", "start"]
