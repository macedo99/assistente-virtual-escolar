# Etapa 1: gera o CSS (Tailwind) — precisa das dependências de desenvolvimento, que não vão para a imagem final.
FROM node:22-alpine AS estilos
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npm run build:css

# Etapa 2: imagem final, só com as dependências de produção e o CSS já gerado.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
COPY --from=estilos /app/src/public/app.css ./src/public/app.css

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
