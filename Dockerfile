# 免费AI工具站（自部署版）
FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

# 先只复制 package.json 和 package-lock.json，利用 Docker 层缓存：
# 依赖不变时跳过 npm ci；用 npm ci 保证安装版本与锁文件一致
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# 再复制其余代码（data/、node_modules/、.env 由 .dockerignore 排除，不会打进镜像）
COPY . .

# 数据目录归 node 用户所有，保证非 root 运行时可写
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "server.js"]
