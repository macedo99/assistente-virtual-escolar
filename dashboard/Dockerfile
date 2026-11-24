# Etapa 1: gera o CSS (Tailwind) — precisa das dependências de desenvolvimento, que não vão para a imagem final.
# Versão fixa do Node (mude de propósito, junto com um teste: npm test e scripts/testar-dashboard.js).
ARG NODE_IMAGE=node:22.23.5-alpine

FROM ${NODE_IMAGE} AS estilos
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npm run build:css

# Etapa 2: imagem final, só com as dependências de produção e o CSS já gerado.
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
COPY --from=estilos /app/src/public/app.css ./src/public/app.css

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
