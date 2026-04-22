FROM node:18-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN npm install

# Ensure Vite entry files are present in /app before building.
COPY index.html ./
COPY src ./src

COPY . .

RUN npm run build
RUN npm install -g serve

EXPOSE 5173

CMD ["serve", "-s", "dist", "-l", "5173"]
