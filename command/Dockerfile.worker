FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit
COPY worker ./worker
COPY src/lib ./src/lib
EXPOSE 8080
CMD ["npm", "run", "worker"]
