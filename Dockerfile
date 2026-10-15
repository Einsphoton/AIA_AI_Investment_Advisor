# syntax=docker/dockerfile:1.7
#
# AI 投资顾问 — 单容器镜像（API + 静态前端）
#
# 多阶段构建：
#   base      仅复制清单文件，供依赖安装层缓存
#   deps      安装全部依赖（含构建工具：typescript / rollup）
#   build     编译 shared + server(tsc) 与 web(rollup)
#   prod-deps 只安装生产依赖（fastify / @fastify/static / zod）
#   runtime   非 root 运行，暴露 8787，/data 挂载卷持久化 SQLite 与备份
#
# 说明：本项目不使用 esbuild/tsx/vite，构建只依赖纯 JS 的 tsc 与 rollup，
# 因此在 Alpine（musl）与受限环境中表现一致，无需编译原生模块。

ARG NODE_VERSION=24-alpine

# ─────────────────────────────── base ───────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# ─────────────────────────────── deps ───────────────────────────────────────
FROM base AS deps
RUN npm ci --ignore-scripts

# ─────────────────────────────── build ──────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
# pre* 钩子会先跑 scripts/guard-running-pipeline.mjs（构建/测试前检查本机是否有 AI 流水线在跑），
# 所以构建阶段必须把 scripts/ 一并复制进来；容器内 127.0.0.1:8787 没有服务，守卫直接放行（与 CI 同一分支）
COPY scripts ./scripts
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/web ./packages/web
# 类型检查作为构建门禁：类型错误直接让镜像构建失败
RUN npm run typecheck
# 镜像里不需要前端 sourcemap（体积减 7MB+），但保留压缩
RUN AIA_WEB_SOURCEMAP=0 npm run build

# ───────────────────────────── prod-deps ────────────────────────────────────
# 只安装生产依赖。npm workspaces 会把无法提升的包放进各自的
# packages/*/node_modules（例如 @fastify/static），因此这里显式创建目录，
# 保证 runtime 阶段可以无条件 COPY。
FROM base AS prod-deps
RUN npm ci --omit=dev --ignore-scripts \
    && mkdir -p packages/shared/node_modules packages/server/node_modules packages/web/node_modules

# ────────────────────────────── runtime ─────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime

# 构建标识：镜像里没有 .git，服务器只能从环境变量知道自己在哪个 revision 上构建
# （见 packages/server/src/version.ts）。CI 通过 --build-arg 注入，最终由
# `GET /api/version` 和前端左上角的版本徽标展示。
ARG AIA_GIT_COMMIT=""
ARG AIA_GIT_BRANCH=""

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    LOG_LEVEL=info \
    AIA_GIT_COMMIT=${AIA_GIT_COMMIT} \
    AIA_GIT_BRANCH=${AIA_GIT_BRANCH}

# 注意：runtime 阶段不继承 base 阶段的 WORKDIR /app，这里的 /app 必须显式创建，
# 否则 chown 会以 "chown: /app: No such file or directory" 直接中断构建。
RUN apk add --no-cache tini \
    && mkdir -p /data/backups /app \
    && chown -R node:node /data /app

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# 工作区私有依赖（如 @fastify/static 被 npm 放在 packages/server/node_modules）
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/server/package.json ./packages/server/package.json
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/web/package.json ./packages/web/package.json
COPY --from=build --chown=node:node /app/packages/web/dist ./packages/web/dist
# 运维脚本：远程部署排障要在**容器内**跑 `npm run trace`（直读 /data/advisor.db）
# 与 `npm run probe:sources`（从这台机器的网络实测数据源）。之前只 COPY 到 build
# 阶段，导致容器里 `npm run trace` 直接报模块不存在，只能先把 DB 拷出来。
# 这些脚本只用 node 内置模块（node:sqlite / 全局 fetch），不需要 devDependencies。
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "packages/server/dist/index.js"]
