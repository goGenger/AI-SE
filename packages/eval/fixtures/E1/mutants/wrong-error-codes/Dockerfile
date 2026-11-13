FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data

# 零运行时依赖项目：无需 install 层；如需依赖请在此补充安装步骤。
COPY --chown=node:node package.json pnpm-lock.yaml ./
COPY --chown=node:node src ./src

USER node
VOLUME /data
EXPOSE 3000

CMD ["node", "src/server.mjs"]
