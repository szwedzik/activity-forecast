# Two stages so the runtime image carries no TypeScript and no dev dependencies.
# node:sqlite is built into Node itself, so there is nothing to compile and alpine is
# enough. 24 is what .nvmrc pins; 22.13 is the floor and CI proves both.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script points git at .githooks, and there is no git here.
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# The SQLite file lives here. Mount a volume over it to keep the cache across containers;
# without one the first request after every start pays for a fetch, which still works.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
# The container has to listen on every interface or a published port reaches nothing.
ENV DB_PATH=/app/data/app.db PORT=4000 HOST=0.0.0.0

USER node
EXPOSE 4000
# node:24-alpine has no curl, and fetch is built in.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s   CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
