FROM node:22.22.2-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm build

EXPOSE 3000

CMD ["sh", "-c", "pnpm --filter @ai-se/database migrate && pnpm --filter @ai-se/server start"]
