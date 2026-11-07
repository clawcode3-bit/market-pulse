FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173

COPY package.json server.js ./
COPY public ./public
COPY data ./data

EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:5173/api/health || exit 1

CMD ["node", "server.js"]
