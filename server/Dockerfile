FROM node:22-alpine
RUN apk add --no-cache fontconfig ttf-dejavu

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p uploads/tmp && chown -R node:node /app

USER node

EXPOSE 3000
CMD ["node", "src/app.js"]
