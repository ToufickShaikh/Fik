## Stage 1 — Build the React app
FROM node:18-alpine AS build

WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN npm install

COPY index.html ./
COPY src ./src
COPY vite.config.js ./

RUN npm run build

## Stage 2 — Serve with nginx (handles /api + /ws proxy to backend)
FROM nginx:1.27-alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
