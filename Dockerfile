# Optional: run the bridge in Docker (Linux hosts, or Windows with Docker Desktop).
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=80
EXPOSE 80
CMD ["node", "src/index.js"]
